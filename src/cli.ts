import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import chalk from "chalk";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Config {
  port: number;
  allowedDirs: string[];
  token: string;
  tunnel: "ngrok" | "none";
}

function isPathAllowed(target: string, allowed: string[]): boolean {
  const resolved = path.resolve(target);
  return allowed.some((dir) => {
    const abs = path.resolve(dir);
    return resolved === abs || resolved.startsWith(abs + path.sep);
  });
}

function createServer(allowedDirs: string[], readOnly = false): McpServer {
  const server = new McpServer({
    name: "desklink-filesystem",
    version: "0.1.0",
  });

  server.tool(
    "list_allowed_directories",
    "Return the directories this server is allowed to access.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(allowedDirs) }],
    })
  );

  server.tool(
    "list_directory",
    "List files and directories at the given path.",
    { path: { type: "string", description: "Path to list", default: "." } },
    async ({ path: p }) => {
      let target = path.resolve(p);
      if (!path.isAbsolute(p) && allowedDirs.length) {
        target = path.join(allowedDirs[0], p);
      }
      if (!isPathAllowed(target, allowedDirs)) {
        return { content: [{ type: "text", text: "Access denied" }], isError: true };
      }
      const entries = await fs.readdir(target, { withFileTypes: true });
      const result = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }));
      return { content: [{ type: "text", text: JSON.stringify({ path: target, entries: result }) }] };
    }
  );

  server.tool(
    "read_file",
    "Read the contents of a text file.",
    { path: { type: "string" }, max_bytes: { type: "number", default: 1_000_000 } },
    async ({ path: p, max_bytes }) => {
      let target = path.resolve(p);
      if (!path.isAbsolute(p) && allowedDirs.length) {
        target = path.join(allowedDirs[0], p);
      }
      if (!isPathAllowed(target, allowedDirs)) {
        return { content: [{ type: "text", text: "Access denied" }], isError: true };
      }
      const data = await fs.readFile(target);
      const truncated = data.length > max_bytes;
      const content = data.slice(0, max_bytes).toString("utf-8");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: target, content, truncated, size: data.length }),
          },
        ],
      };
    }
  );

  if (!readOnly) {
    server.tool(
      "write_file",
      "Write content to a file.",
      { path: { type: "string" }, content: { type: "string" } },
      async ({ path: p, content }) => {
        let target = path.resolve(p);
        if (!path.isAbsolute(p) && allowedDirs.length) {
          target = path.join(allowedDirs[0], p);
        }
        if (!isPathAllowed(target, allowedDirs)) {
          return { content: [{ type: "text", text: "Access denied" }], isError: true };
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf-8");
        return { content: [{ type: "text", text: JSON.stringify({ path: target, bytes: Buffer.byteLength(content) }) }] };
      }
    );
  }

  return server;
}

function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== token) {
      return res.status(401).json({ error: "Unauthorized", message: "Valid Bearer token required" });
    }
    next();
  };
}

async function startTunnel(port: number, provider: string): Promise<string | null> {
  if (provider === "none") return null;
  // Use ngrok CLI via child process for simplicity (assumes ngrok is installed)
  return new Promise((resolve, reject) => {
    const child = spawn("ngrok", ["http", String(port), "--log=stdout"], { stdio: ["ignore", "pipe", "pipe"] });
    let url: string | null = null;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("ngrok timed out"));
    }, 15000);
    child.stdout?.on("data", (data) => {
      const line = data.toString();
      const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok[-\w.]*\.(?:app|io|dev)/);
      if (match && !url) {
        url = match[0];
        clearTimeout(timeout);
        resolve(url);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function run() {
  const program = new Command();
  program
    .name("desklink")
    .description("Turn your local computer into a remote MCP endpoint")
    .version("0.1.0");

  program
    .command("start")
    .option("-d, --dir <dirs...>", "Allowed directories")
    .option("-p, --port <number>", "Port", "8765")
    .option("--tunnel <provider>", "ngrok or none", "ngrok")
    .option("--token <token>", "Bearer token")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const allowed = opts.dir || [process.env.HOME || process.cwd()];
      const token = opts.token || randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const tunnelProvider = opts.tunnel as "ngrok" | "none";

      console.log(chalk.cyan("┌────────────────┐"));
      console.log(chalk.cyan("│ DeskLink v0.1.0 │"));
      console.log(chalk.cyan("└────────────────┘"));

      const app = express();
      app.use(express.json());
      app.use(bearerAuth(token));

      const mcp = createServer(allowed);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await mcp.connect(transport);

      app.post("/mcp", async (req, res) => {
        await transport.handleRequest(req, res, req.body);
      });
      app.get("/mcp", async (req, res) => {
        await transport.handleRequest(req, res);
      });
      app.delete("/mcp", async (req, res) => {
        await transport.handleRequest(req, res);
      });

      const server = app.listen(port, "127.0.0.1", () => {
        console.log(chalk.green(`✓ Filesystem MCP started`));
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

      console.log(`\nAuth token: ${token}`);
      console.log("Include as Authorization: Bearer <token> when connecting.");
      console.log("\nStatus: ● Connected");
      console.log("Tools: 5");
      console.log("\nPress Ctrl+C to stop.");

      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        server.close();
        process.exit(0);
      });
    });

  await program.parseAsync(process.argv);
}
