/**
 * File-based OAuth 2.1 store and helpers for DeskLink (JS).
 * Persists under ~/.desklink/oauth/ — no database.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PRESETS: Record<string, { name: string; scopes: string[]; public: boolean; description: string }> = {
  claude: { name: "Claude", scopes: ["mcp:tools", "mcp:resources", "filesystem:read"], public: true, description: "Anthropic Claude" },
  chatgpt: { name: "ChatGPT", scopes: ["mcp:tools", "mcp:resources"], public: true, description: "OpenAI ChatGPT" },
  manus: { name: "Manus", scopes: ["mcp:tools", "filesystem:read", "filesystem:write"], public: true, description: "Manus agent" },
  cursor: { name: "Cursor", scopes: ["mcp:tools", "filesystem:read", "filesystem:write"], public: true, description: "Cursor IDE" },
  custom: { name: "Custom Agent", scopes: ["mcp:tools"], public: true, description: "Custom MCP client" },
};

export const ALL_SCOPES = ["mcp:tools", "mcp:resources", "filesystem:read", "filesystem:write", "admin"];

function oauthDir() {
  return path.join(process.env.HOME || "/tmp", ".desklink", "oauth");
}

async function load(name: string): Promise<Record<string, any>> {
  try {
    const text = await fs.readFile(path.join(oauthDir(), name), "utf-8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function save(name: string, data: Record<string, any>) {
  const dir = oauthDir();
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function generateClientId() { return "dl_" + randomBytes(16).toString("base64url"); }
export function generateClientSecret() { return randomBytes(32).toString("base64url"); }
export function generateCode() { return randomBytes(32).toString("base64url"); }
export function generateAccessToken() { return "dl_at_" + randomBytes(32).toString("base64url"); }
export function generateRefreshToken() { return "dl_rt_" + randomBytes(32).toString("base64url"); }
export function hashSecret(value: string) { return createHash("sha256").update(value).digest("hex"); }

export function verifyPkce(verifier: string, challenge: string, method = "S256") {
  if (method === "plain") return verifier === challenge;
  const digest = createHash("sha256").update(verifier).digest();
  const computed = digest.toString("base64url");
  try { return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge)); } catch { return computed === challenge; }
}

export async function saveApp(app: any) { const data = await load("apps.json"); data[app.client_id] = app; await save("apps.json", data); }
export async function getApp(clientId: string) { const data = await load("apps.json"); return data[clientId] || null; }
export async function listApps() { const data = await load("apps.json"); return Object.values(data); }
export async function saveCode(code: any) { const data = await load("codes.json"); data[code.code] = code; await save("codes.json", data); }
export async function getCode(code: string) { const data = await load("codes.json"); return data[code] || null; }
export async function markCodeUsed(code: string) { const data = await load("codes.json"); if (data[code]) data[code].used = true; await save("codes.json", data); }
export async function saveToken(token: any) { const data = await load("tokens.json"); data[token.token] = token; await save("tokens.json", data); }
export async function getToken(token: string) { const data = await load("tokens.json"); return data[token] || null; }
export async function listTokens(clientId?: string) { const data = await load("tokens.json"); let tokens = Object.values(data) as any[]; if (clientId) tokens = tokens.filter((t) => t.client_id === clientId); return tokens; }
export async function revokeToken(token: string) { const data = await load("tokens.json"); if (data[token]) data[token].revoked = true; for (const v of Object.values(data) as any[]) { if (v.refresh_token === token) v.revoked = true; } await save("tokens.json", data); }
export async function saveGrant(grant: any) { const data = await load("grants.json"); data[grant.client_id] = grant; await save("grants.json", data); }
export async function revokeGrant(clientId: string) { const grants = await load("grants.json"); if (grants[clientId]) grants[clientId].revoked = true; await save("grants.json", grants); const tokens = await load("tokens.json"); for (const v of Object.values(tokens) as any[]) { if (v.client_id === clientId) v.revoked = true; } await save("tokens.json", tokens); }
export async function logActivity(event: string, detail = "") { const data = await load("activity.json"); const items = data.items || []; items.push({ ts: Date.now() / 1000, event, detail }); data.items = items.slice(-200); await save("activity.json", data); }
export async function listActivity(limit = 50) { const data = await load("activity.json"); return (data.items || []).slice(-limit).reverse(); }
export function isValidOAuthToken(token: any) { if (!token || token.revoked) return false; if (token.expires_at && token.expires_at < Date.now() / 1000) return false; return true; }
