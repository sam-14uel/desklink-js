/**
 * DeskLink CLI – start bridge, create OAuth apps, manage tokens.
 */
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, ensureDefaultFilesystem } from "./config.js";
import { loadOrCreateToken } from "./auth.js";
import { DeskLinkServer } from "./server.js";
import {
  PRESETS,
  generateClientId,
  generateClientSecret,
  hashSecret,
  saveApp,
  listApps,
  revokeGrant,
} from "./oauth.js";

const VERSION = "0.3.0";

export async function run(): Promise<void> {
  const program = new Command();

  program
    .name("desklink")
    .description("Turn your local computer into a remote MCP endpoint for cloud AI agents.")
    .version(VERSION);

  program
    .command("start")
    .description("Start the MCP bridge and optional tunnel")
    .option("--mcp-config <path>", "Path to mcp.json")
    .option("--config <path>", "Path to desklink.config.json")
    .option("-d, --dir <dirs...>", "Allowed directories for default filesystem server")
    .option("-p, --port <number>", "HTTP port", (v) => parseInt(v, 10))
    .option("--tunnel <provider>", "Tunnel provider: ngrok | none")
    .option("--token <token>", "Override device bearer token")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      let cfg = loadConfig({
        configPath: opts.config,
        mcpPath: opts.mcpConfig,
      });
      cfg = ensureDefaultFilesystem(cfg, opts.dir);

      if (opts.port) cfg.settings.server.port = opts.port;
      if (opts.tunnel) cfg.settings.tunnel.provider = opts.tunnel;
      if (opts.token) {
        cfg.settings.auth.token = opts.token;
      } else if (cfg.settings.auth.enabled && !cfg.settings.auth.token) {
        cfg.settings.auth.token = loadOrCreateToken(cfg.settings.auth.token_file);
      }

      console.log(chalk.cyan.bold(`\n  DeskLink v${VERSION}\n`));

      const server = new DeskLinkServer(cfg);
      const shutdown = async () => {
        await server.shutdown();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      try {
        const local = await server.startHttpServer();
        const publicUrl = await server.startTunnel();
        console.log(chalk.green("MCP bridge started"));
        console.log(`  Local:  ${local}`);
        console.log(`  Remote: ${publicUrl}`);
        if (cfg.settings.auth.token) {
          console.log(`  Auth token: ${cfg.settings.auth.token}`);
        }
        console.log(chalk.dim("\n  Press Ctrl+C to stop.\n"));
        // Keep process alive
        await new Promise(() => {});
      } catch (err: any) {
        console.error(chalk.red("Failed to start:"), err?.message || err);
        await server.shutdown();
        process.exit(1);
      }
    });

  program
    .command("create")
    .description("Create resources (e.g. oauth-app)")
    .argument("<kind>", "What to create, e.g. oauth-app")
    .argument("[preset]", "Agent preset: claude, chatgpt, manus, cursor, custom", "custom")
    .option("--name <name>", "Display name")
    .option("--public", "Public client (no secret)", false)
    .option("--confidential", "Confidential client with secret", false)
    .action(async (kind, preset, opts) => {
      if (kind !== "oauth-app") {
        console.error(chalk.red(`Unknown create target: ${kind}`));
        process.exit(1);
      }
      preset = (preset || "custom").toLowerCase();
      const meta = PRESETS[preset] || PRESETS.custom;
      const display = opts.name || meta.name;
      const scopes = meta.scopes;
      const isPublic = opts.public || (!opts.confidential && meta.public !== false);
      const client_id = generateClientId();
      let secret: string | undefined;
      let secret_hash: string | undefined;
      if (!isPublic) {
        secret = generateClientSecret();
        secret_hash = hashSecret(secret);
      }
      await saveApp({
        client_id,
        name: display,
        preset,
        scopes,
        public: isPublic,
        client_secret_hash: secret_hash,
        description: meta.description || "",
        created_at: Date.now() / 1000,
        active: true,
      });
      console.log(chalk.green.bold(`\n  OAuth app created: ${display}\n`));
      console.log(`  ${chalk.cyan("Client ID:")} ${client_id}`);
      if (secret) {
        console.log(`  ${chalk.cyan("Client Secret:")} ${secret}`);
      } else {
        console.log(chalk.dim("  Public client (no secret). Use PKCE."));
      }
      console.log(`  ${chalk.cyan("Scopes:")} ${scopes.join(", ")}`);
      console.log("\n  Endpoints (when DeskLink is running):");
      console.log("    Authorization:  http://127.0.0.1:8765/oauth/authorize");
      console.log("    Token:          http://127.0.0.1:8765/oauth/token");
      console.log("    MCP:            http://127.0.0.1:8765/mcp");
      console.log("    Dashboard:      http://127.0.0.1:8765/dashboard\n");
    });

  const oauth = program.command("oauth").description("Manage OAuth applications");

  oauth
    .command("list")
    .description("List OAuth apps")
    .action(async () => {
      const apps = await listApps();
      if (!apps.length) {
        console.log("No OAuth apps yet. Create one with: desklink create oauth-app claude");
        return;
      }
      for (const a of apps as any[]) {
        console.log(
          `  ${a.name}  ${chalk.dim(a.client_id)}  [${a.preset}]  ${a.public ? "public" : "confidential"}  scopes=${(a.scopes || []).join(",")}`
        );
      }
    });

  oauth
    .command("revoke")
    .description("Revoke an OAuth app / its grants")
    .argument("<client_id>", "Client ID to revoke")
    .action(async (clientId) => {
      await revokeGrant(clientId);
      console.log(chalk.green(`Revoked grants for ${clientId}`));
    });

  await program.parseAsync(process.argv);
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
