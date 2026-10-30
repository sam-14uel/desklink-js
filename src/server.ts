/**
 * DeskLink HTTP server: auth middleware + MCP Streamable HTTP proxy + OAuth routes.
 */
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { DeskLinkConfig } from "./config.js";
import { McpBridge } from "./bridge.js";
import { getTunnelProvider, type TunnelProvider } from "./tunnel.js";
import { mountOAuthRoutes, checkOAuthToken } from "./oauth-server.js";

export class DeskLinkServer {
  config: DeskLinkConfig;
  bridge: McpBridge;
  app: express.Express;
  httpServer: any = null;
  tunnel: TunnelProvider | null = null;
  localUrl = "";
  publicUrl = "";
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();

  constructor(config: DeskLinkConfig) {
    this.config = config;
    this.bridge = new McpBridge(config);
    this.app = express();
    this.app.use(express.json({ limit: "4mb" }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  private authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const path = req.path || "";
    if (
      path.startsWith("/oauth") ||
      path.startsWith("/.well-known") ||
      path.startsWith("/dashboard")
    ) {
      return next();
    }
    if (!this.config.settings.auth.enabled || !this.config.settings.auth.token) {
      return next();
    }
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized", message: "Valid Bearer token required" });
      return;
    }
    const token = auth.slice(7);
    if (token === this.config.settings.auth.token) {
      return next();
    }
    const ok = await checkOAuthToken(token);
    if (ok) return next();
    res.status(401).json({ error: "Unauthorized", message: "Valid Bearer token required" });
  };

  private buildProxyServer(): McpServer {
    const server = new McpServer(
      { name: "DeskLink Bridge", version: "0.3.0" },
      { capabilities: { tools: {} } }
    );

    for (const tool of this.bridge.tools) {
      const nsName = tool.namespaced;
      const desc = tool.description || `Proxied tool from ${tool.server}`;
      const schema = tool.inputSchema || { type: "object", properties: {} };

      // registerTool expects a Zod-like or plain object schema in recent SDKs;
      // we pass a loose any-schema via a wrapper that accepts arbitrary args.
      server.tool(
        nsName,
        desc,
        // Use a permissive shape so FastMCP-style registration works with dynamic schemas
        async (args: any) => {
          const result = await this.bridge.callTool(nsName, args || {});
          // Normalize to CallToolResult shape if needed
          if (result && result.content) return result;
          return {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
          };
        }
      );

      // Best-effort: some SDK versions expose internal tool manager for schema override
      try {
        const anyServer = server as any;
        const toolsMap =
          anyServer._registeredTools ||
          anyServer._toolHandlers ||
          anyServer.server?._requestHandlers;
        // If we can reach the tool definition, attach original inputSchema
        if (anyServer._registeredTools?.[nsName]) {
          anyServer._registeredTools[nsName].inputSchema = schema;
        }
      } catch {
        // ignore – schema will still be usable via tool description
      }
    }

    return server;
  }

  async startHttpServer(): Promise<string> {
    await this.bridge.startServers();
    const proxyMcp = this.buildProxyServer();

    this.app.use(this.authMiddleware);
    mountOAuthRoutes(this.app);

    // Streamable HTTP endpoint (stateful sessions)
    this.app.all(this.config.settings.server.mcp_path, async (req, res) => {
      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (req.method === "POST" && isInitializeRequest(req.body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          transport.onclose = () => {
            if (transport.sessionId) this.transports.delete(transport.sessionId);
          };
          await proxyMcp.connect(transport);
          await transport.handleRequest(req, res, req.body);
          if (transport.sessionId) this.transports.set(transport.sessionId, transport);
          return;
        }

        if (sessionId && this.transports.has(sessionId)) {
          const transport = this.transports.get(sessionId)!;
          await transport.handleRequest(req, res, req.body);
          return;
        }

        // Stateless fallback: new transport per request when no session
        if (req.method === "POST") {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await proxyMcp.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }

        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session" },
          id: null,
        });
      } catch (err: any) {
        console.error("[DeskLink] MCP handler error:", err?.message || err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: err?.message || "Internal error" },
            id: null,
          });
        }
      }
    });

    const { host, port, mcp_path } = this.config.settings.server;
    await new Promise<void>((resolve, reject) => {
      this.httpServer = this.app.listen(port, host, () => resolve());
      this.httpServer.on("error", reject);
    });

    this.localUrl = `http://${host}:${port}${mcp_path}`;
    console.error(`[DeskLink] Local MCP bridge listening at ${this.localUrl} (${this.bridge.tools.length} tools)`);
    return this.localUrl;
  }

  async startTunnel(): Promise<string> {
    const provider = getTunnelProvider(this.config.settings.tunnel.provider);
    const info = await provider.start(
      this.config.settings.server.port,
      this.config.settings.tunnel.authtoken
    );
    this.tunnel = provider;
    this.publicUrl =
      info.public_url.replace(/\/$/, "") + this.config.settings.server.mcp_path;
    console.error(`[DeskLink] Public MCP endpoint: ${this.publicUrl}`);
    return this.publicUrl;
  }

  async shutdown(): Promise<void> {
    console.error("[DeskLink] Shutting down...");
    await this.bridge.close();
    if (this.tunnel) {
      try {
        await this.tunnel.stop();
      } catch {
        // ignore
      }
    }
    for (const t of this.transports.values()) {
      try {
        await t.close();
      } catch {
        // ignore
      }
    }
    this.transports.clear();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
      this.httpServer = null;
    }
  }
}
