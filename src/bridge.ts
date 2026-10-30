/**
 * Bridge that proxies tools from local STDIO MCP servers.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DeskLinkConfig } from "./config.js";
import readline from "node:readline";

export interface DiscoveredTool {
  server: string;
  name: string;
  namespaced: string;
  description: string;
  inputSchema: any;
}

export class McpBridge {
  config: DeskLinkConfig;
  clients: Map<string, Client> = new Map();
  transports: Map<string, StdioClientTransport> = new Map();
  tools: DiscoveredTool[] = [];

  constructor(config: DeskLinkConfig) {
    this.config = config;
  }

  async startServers(): Promise<void> {
    for (const [name, srv] of Object.entries(this.config.mcp.mcpServers)) {
      try {
        const transport = new StdioClientTransport({
          command: srv.command,
          args: srv.args || [],
          env: srv.env as any,
          cwd: srv.cwd,
        });
        const client = new Client(
          { name: `desklink-bridge-${name}`, version: "0.3.0" },
          { capabilities: {} }
        );
        await client.connect(transport);
        this.clients.set(name, client);
        this.transports.set(name, transport);

        const listed = await client.listTools();
        for (const t of listed.tools) {
          this.tools.push({
            server: name,
            name: t.name,
            namespaced: `${name}__${t.name}`,
            description: t.description || "",
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          });
        }
        console.error(`[DeskLink] Connected to MCP server '${name}' (${listed.tools.length} tools)`);
      } catch (err: any) {
        console.error(`[DeskLink] Failed to start MCP server '${name}':`, err?.message || err);
      }
    }
  }

  private async shouldApprove(toolName: string): Promise<boolean> {
    const policy =
      this.config.settings.approvals.tools[toolName] ??
      this.config.settings.approvals.default;
    if (policy === "auto") return true;

    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question(`\n[DeskLink] Approve tool call '${toolName}'? [y/N] `, (answer) => {
        rl.close();
        resolve(["y", "yes"].includes((answer || "").trim().toLowerCase()));
      });
    });
  }

  private trace(tool: string, args: any, result: any, durationMs: number, error?: string) {
    if (!this.config.settings.tracing.enabled || this.config.settings.tracing.level === "none") {
      return;
    }
    const entry: any = {
      tool,
      duration_ms: Math.round(durationMs * 10) / 10,
      error: error || null,
    };
    if (this.config.settings.tracing.level === "full") {
      if (this.config.settings.tracing.redact_sensitive) {
        const sensitive = new Set(["password", "token", "secret", "key", "authorization"]);
        entry.args = Object.fromEntries(
          Object.entries(args || {}).map(([k, v]) => [
            k,
            sensitive.has(k.toLowerCase()) ? "***" : v,
          ])
        );
      } else {
        entry.args = args;
      }
      entry.result = result ? String(result).slice(0, 500) : null;
    }
    console.error("[TRACE]", JSON.stringify(entry));
  }

  async callTool(namespacedName: string, arguments_: Record<string, unknown>): Promise<any> {
    if (!namespacedName.includes("__")) {
      throw new Error(`Invalid tool name: ${namespacedName}`);
    }
    const [serverName, toolName] = namespacedName.split("__", 2);
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`No session for server '${serverName}'`);

    const approved = await this.shouldApprove(namespacedName);
    if (!approved) {
      throw new Error(`Tool call '${namespacedName}' denied by user`);
    }

    const start = performance.now();
    let error: string | undefined;
    let result: any;
    try {
      result = await client.callTool({ name: toolName, arguments: arguments_ });
      return result;
    } catch (e: any) {
      error = e?.message || String(e);
      throw e;
    } finally {
      this.trace(namespacedName, arguments_, result, performance.now() - start, error);
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.transports.clear();
  }
}
