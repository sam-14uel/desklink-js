import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface TracingConfig {
  enabled: boolean;
  level: "none" | "basic" | "full";
  redact_sensitive: boolean;
}

interface ApprovalsConfig {
  default: "auto" | "prompt";
  tools: Record<string, "auto" | "prompt">;
}

interface DeskLinkConfig {
  logging?: { level: string };
  tracing?: TracingConfig;
  auth?: { enabled: boolean; token?: string };
  approvals?: ApprovalsConfig;
  server?: { host: string; port: number; mcp_path: string };
  tunnel?: { provider: string };
}

const DEFAULT_CONFIG: DeskLinkConfig = {
  tracing: { enabled: true, level: "basic", redact_sensitive: true },
  auth: { enabled: true },
  approvals: { default: "auto", tools: {} },
  server: { host: "127.0.0.1", port: 8765, mcp_path: "/mcp" },
  tunnel: { provider: "ngrok" },
};

async function loadJson<T>(file: string | undefined, fallbacks: string[]): Promise<T | null> {
  const candidates = [file, ...fallbacks].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, "utf-8");
      return JSON.parse(text) as T;
    } catch {
      // continue
    }
  }
  return null;
}

async function ensureDefaultFilesystem(mcp: McpConfig, dirs: string[]): Promise<McpConfig> {
  if (Object.keys(mcp.mcpServers || {}).length > 0) return mcp;
  const allowed = dirs.length ? dirs : [process.env.HOME || "/"];
  mcp.mcpServers = {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", ...allowed],
    },
  };
  return mcp;
}

function redact(args: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  if (!enabled) return args;
  const sensitive = new Set(["password", "token", "secret", "key", "authorization"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = sensitive.has(k.toLowerCase()) ? "***" : v;
  }
  return out;
}

async function shouldApprove(tool: string, approvals: ApprovalsConfig): Promise<boolean> {
  const policy = approvals.tools[tool] || approvals.default;
  if (policy === "auto") return true;
  const rl = createInterface({ input, output });
  const ans = (await rl.question(`\n[DeskLink] Approve tool call '${tool}'? [y/N] `)).trim().toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}

function trace(tool: string, args: any, result: any, duration: number, error?: string, cfg?: TracingConfig) {
  if (!cfg?.enabled || cfg.level === "none") return;
  const entry: any = { tool, duration_ms: Math.round(duration), error };
  if (cfg.level === "full") {
    entry.args = redact(args || {}, cfg.redact_sensitive);
    entry.result = result ? String(result).slice(0, 500) : null;
  }
  console.log("TRACE", JSON.stringify(entry));
}

async function startTunnel(port: number, provider: string): Promise<string | null> {
  if (provider === "none" || provider === "local") return null;
  try {
    const ngrok = await import("ngrok");
    const url = await ngrok.connect({ port, authtoken: process.env.NGROK_AUTHTOKEN });
    return url;
  } catch (e) {
    console.error(chalk.yellow(`ngrok failed: ${(e as Error).message}`));
    return null;
  }
}

async function main() {
  const program = new Command();
  program
    .name("desklink")
    .description("Turn your local computer into a remote MCP endpoint.")
    .version("0.2.0");

  program
    .command("start")
    .option("--mcp-config <path>", "Path to mcp.json")
    .option("--config <path>", "Path to desklink.config.json")
    .option("-d, --dir <dirs...>", "Allowed dirs for default filesystem server")
    .option("-p, --port <number>", "Local port", "8765")
    .option("--tunnel <provider>", "ngrok or none", "ngrok")
    .option("--token <token>", "Bearer token")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const home = process.env.HOME || "";
      let settings = (await loadJson<DeskLinkConfig>(opts.config, [
        path.join(process.cwd(), "desklink.config.json"),
        path.join(home, ".desklink", "config.json"),
      ])) || DEFAULT_CONFIG;
      settings = { ...DEFAULT_CONFIG, ...settings };

      let mcp = (await loadJson<McpConfig>(opts.mcpConfig, [
        path.join(process.cwd(), "mcp.json"),
        path.join(home, ".desklink", "mcp.json"),
      ])) || { mcpServers: {} };

      mcp = await ensureDefaultFilesystem(mcp, opts.dir || []);

      const port = Number(opts.port) || settings.server?.port || 8765;
      const tunnelProvider = opts.tunnel || settings.tunnel?.provider || "ngrok";
      let token = opts.token || settings.auth?.token;
      if (!token && settings.auth?.enabled !== false) {
        const tokenFile = path.join(home, ".desklink", "token");
        try {
          token = (await fs.readFile(tokenFile, "utf-8")).trim();
        } catch {
          token = randomUUID();
          await fs.mkdir(path.dirname(tokenFile), { recursive: true });
          await fs.writeFile(tokenFile, token, { mode: 0o600 });
        }
      }

      console.log(chalk.cyan.bold(`DeskLink v0.2.0`));

      const sessions: Record<string, Client> = {};
      const transports: any[] = [];
      const tools: { server: string; name: string; namespaced: string; description: string }[] = [];

      for (const [name, srv] of Object.entries(mcp.mcpServers)) {
        try {
          const transport = new StdioClientTransport({
            command: srv.command,
            args: srv.args || [],
            env: srv.env,
            cwd: srv.cwd,
          });
          const client = new Client({ name: "desklink-bridge", version: "0.2.0" });
          await client.connect(transport);
          sessions[name] = client;
          transports.push(transport);

          const listed = await client.listTools();
          for (const t of listed.tools) {
            tools.push({
              server: name,
              name: t.name,
              namespaced: `${name}__${t.name}`,
              description: t.description || "",
            });
          }
          console.log(chalk.green(`Connected to '${name}' (${listed.tools.length} tools)`));
        } catch (e) {
          console.error(chalk.red(`Failed to start server '${name}': ${(e as Error).message}`));
        }
      }

      const server = new McpServer({ name: "desklink-bridge", version: "0.2.0" });
      const approvals = settings.approvals || { default: "auto" as const, tools: {} };
      const tracing = settings.tracing;

      for (const t of tools) {
        server.tool(
          t.namespaced,
          t.description,
          {},
          async (args: any) => {
            const start = Date.now();
            let error: string | undefined;
            let result: any;
            try {
              if (!(await shouldApprove(t.namespaced, approvals))) {
                throw new Error(`Tool call '${t.namespaced}' denied by user`);
              }
              const client = sessions[t.server];
              result = await client.callTool({ name: t.name, arguments: args });
              return result;
            } catch (e) {
              error = (e as Error).message;
              throw e;
            } finally {
              trace(t.namespaced, args, result, Date.now() - start, error, tracing);
            }
          }
        );
      }

      const app = express();
      app.use(express.json());

      if (token) {
        app.use((req: Request, res: Response, next: NextFunction) => {
          const auth = req.headers.authorization || "";
          if (!auth.startsWith("Bearer ") || auth.slice(7) !== token) {
            return res.status(401).json({ error: "Unauthorized" });
          }
          next();
        });
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await server.connect(transport);

      app.post("/mcp", async (req, res) => {
        await transport.handleRequest(req, res);
      });
      app.get("/mcp", async (req, res) => {
        await transport.handleRequest(req, res);
      });
      app.delete("/mcp", async (req, res) => {
        await transport.handleRequest(req, res);
      });

      const httpServer = app.listen(port, "127.0.0.1", () => {
        console.log(chalk.green(`✓ MCP bridge started`));
        console.log(chalk.green(`✓ Local MCP: http://127.0.0.1:${port}/mcp`));
      });

      let publicUrl: string | null = null;
      try {
        publicUrl = await startTunnel(port, tunnelProvider);
        if (publicUrl) {
          console.log(chalk.green("✓ Tunnel connected"));
          console.log("\nRemote MCP endpoint:");
          console.log(chalk.bold(publicUrl + "/mcp"));
        } else {
          console.log(chalk.yellow("Tunnel disabled (local only)"));
        }
      } catch (e) {
        console.log(chalk.yellow(`Tunnel failed: ${(e as Error).message}. Continuing local-only.`));
      }

      if (token) {
        console.log(`\nAuth token: ${token}`);
        console.log("Include as Authorization: Bearer <token> when connecting.");
      }
      console.log(`\nStatus: ● Connected`);
      console.log(`Tools: ${tools.length}`);
      console.log(`Servers: ${Object.keys(mcp.mcpServers).length}`);
      console.log("\nPress Ctrl+C to stop.");

      process.on("SIGINT", async () => {
        console.log("\nShutting down...");
        httpServer.close();
        for (const t of transports) {
          try { await t.close?.(); } catch {}
        }
        process.exit(0);
      });
    });

  async function loadAndConnect(opts: any) {
    const home = process.env.HOME || "";
    let settings = (await loadJson<DeskLinkConfig>(opts.config, [
      path.join(process.cwd(), "desklink.config.json"),
      path.join(home, ".desklink", "config.json"),
    ])) || DEFAULT_CONFIG;
    settings = { ...DEFAULT_CONFIG, ...settings };

    let mcp = (await loadJson<McpConfig>(opts.mcpConfig, [
      path.join(process.cwd(), "mcp.json"),
      path.join(home, ".desklink", "mcp.json"),
    ])) || { mcpServers: {} };

    mcp = await ensureDefaultFilesystem(mcp, opts.dir || []);

    const sessions: Record<string, Client> = {};
    const transports: any[] = [];
    const tools: { server: string; name: string; namespaced: string; description: string }[] = [];

    for (const [name, srv] of Object.entries(mcp.mcpServers)) {
      try {
        const transport = new StdioClientTransport({
          command: srv.command,
          args: srv.args || [],
          env: srv.env,
          cwd: srv.cwd,
        });
        const client = new Client({ name: "desklink-bridge", version: "0.2.0" });
        await client.connect(transport);
        sessions[name] = client;
        transports.push(transport);

        const listed = await client.listTools();
        for (const t of listed.tools) {
          tools.push({
            server: name,
            name: t.name,
            namespaced: `${name}__${t.name}`,
            description: t.description || "",
          });
        }
      } catch (e) {
        console.error(chalk.red(`Failed to start server '${name}': ${(e as Error).message}`));
      }
    }

    return { settings, mcp, sessions, transports, tools };
  }

  program
    .command("tools")
    .description("List tools discovered from configured MCP servers (no tunnel started)")
    .option("--mcp-config <path>", "Path to mcp.json")
    .option("--config <path>", "Path to desklink.config.json")
    .option("-d, --dir <dirs...>", "Allowed dirs for default filesystem server")
    .action(async (opts) => {
      const { tools, mcp, transports } = await loadAndConnect(opts);
      if (!tools.length) {
        console.log(chalk.yellow("No tools discovered."));
      } else {
        console.log(chalk.cyan.bold("Discovered MCP Tools"));
        for (const t of tools) {
          console.log(`  ${chalk.cyan(t.namespaced.padEnd(40))} ${t.server.padEnd(15)} ${(t.description || "").slice(0, 60)}`);
        }
        console.log(`\nTotal: ${tools.length} tools from ${Object.keys(mcp.mcpServers).length} server(s)`);
      }
      for (const t of transports) {
        try { await t.close?.(); } catch {}
      }
    });

  program
    .command("call <toolName>")
    .description("Call a tool by its namespaced name and print the result (for testing)")
    .option("-a, --args <json>", "JSON object of arguments, e.g. '{\"path\":\"/tmp\"}'")
    .option("--mcp-config <path>", "Path to mcp.json")
    .option("--config <path>", "Path to desklink.config.json")
    .option("-d, --dir <dirs...>", "Allowed dirs for default filesystem server")
    .action(async (toolName: string, opts) => {
      let args: Record<string, unknown> = {};
      if (opts.args) {
        try {
          args = JSON.parse(opts.args);
          if (typeof args !== "object" || args === null) throw new Error("must be object");
        } catch (e) {
          console.error(chalk.red(`Invalid --args JSON: ${(e as Error).message}`));
          process.exit(1);
        }
      }

      const { sessions, tools, transports } = await loadAndConnect(opts);
      const match = tools.find((t) => t.namespaced === toolName);
      if (!match) {
        console.error(chalk.red(`Tool '${toolName}' not found.`));
        const available = tools.slice(0, 10).map((t) => t.namespaced).join(", ");
        console.error(`Available (first 10): ${available}`);
        process.exit(1);
      }

      const client = sessions[match.server];
      console.log(chalk.cyan(`Calling ${toolName} with`), args);
      try {
        const result = await client.callTool({ name: match.name, arguments: args });
        console.log(chalk.green("\nResult:"));
        if (result.content) {
          for (const item of result.content) {
            if ("text" in item && item.text) console.log(item.text);
            else console.log(item);
          }
        } else {
          console.log(result);
        }
      } catch (e) {
        console.error(chalk.red(`Call failed: ${(e as Error).message}`));
        process.exit(1);
      } finally {
        for (const t of transports) {
          try { await t.close?.(); } catch {}
        }
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
