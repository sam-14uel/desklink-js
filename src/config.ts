/**
 * Configuration loading for DeskLink (JS).
 * Supports desklink.config.json + standard mcp.json + env overrides.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ServerConfig {
  host: string;
  port: number;
  mcp_path: string;
}

export interface TunnelConfig {
  provider: string;
  authtoken?: string;
}

export interface AuthConfig {
  enabled: boolean;
  token?: string;
  token_file: string;
}

export interface TracingConfig {
  enabled: boolean;
  level: "none" | "basic" | "full";
  redact_sensitive: boolean;
}

export interface ApprovalsConfig {
  default: "auto" | "prompt";
  tools: Record<string, "auto" | "prompt">;
}

export interface LoggingConfig {
  level: string;
}

export interface DeskLinkSettings {
  logging: LoggingConfig;
  tracing: TracingConfig;
  auth: AuthConfig;
  approvals: ApprovalsConfig;
  server: ServerConfig;
  tunnel: TunnelConfig;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface DeskLinkConfig {
  settings: DeskLinkSettings;
  mcp: McpConfig;
}

const DEFAULT_SETTINGS: DeskLinkSettings = {
  logging: { level: "info" },
  tracing: { enabled: true, level: "basic", redact_sensitive: true },
  auth: {
    enabled: true,
    token_file: path.join(os.homedir(), ".desklink", "token"),
  },
  approvals: { default: "auto", tools: {} },
  server: { host: "127.0.0.1", port: 8765, mcp_path: "/mcp" },
  tunnel: { provider: "ngrok" },
};

function loadJson(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge<T extends Record<string, any>>(base: T, override: any): T {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (base as any)[k] === "object") {
      (out as any)[k] = deepMerge((base as any)[k], v);
    } else if (v !== undefined) {
      (out as any)[k] = v;
    }
  }
  return out;
}

export function loadConfig(opts: {
  configPath?: string;
  mcpPath?: string;
} = {}): DeskLinkConfig {
  const home = os.homedir();
  const candidatesConfig = [
    opts.configPath,
    path.join(process.cwd(), "desklink.config.json"),
    path.join(home, ".desklink", "config.json"),
  ].filter(Boolean) as string[];

  const candidatesMcp = [
    opts.mcpPath,
    path.join(process.cwd(), "mcp.json"),
    path.join(home, ".desklink", "mcp.json"),
  ].filter(Boolean) as string[];

  let settingsData: any = {};
  for (const p of candidatesConfig) {
    if (fs.existsSync(p)) {
      settingsData = loadJson(p);
      break;
    }
  }

  let mcpData: any = {};
  for (const p of candidatesMcp) {
    if (fs.existsSync(p)) {
      mcpData = loadJson(p);
      break;
    }
  }

  const settings = deepMerge(DEFAULT_SETTINGS, settingsData);
  if (!settings.tunnel.authtoken) {
    settings.tunnel.authtoken = process.env.NGROK_AUTHTOKEN;
  }

  const mcp: McpConfig = {
    mcpServers: mcpData.mcpServers || {},
  };

  return { settings, mcp };
}

/** If no MCP servers configured, inject the official filesystem server. */
export function ensureDefaultFilesystem(
  cfg: DeskLinkConfig,
  dirs?: string[]
): DeskLinkConfig {
  if (Object.keys(cfg.mcp.mcpServers).length > 0) return cfg;
  const allowed = dirs && dirs.length > 0 ? dirs : [os.homedir()];
  cfg.mcp.mcpServers["filesystem"] = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ...allowed],
  };
  return cfg;
}
