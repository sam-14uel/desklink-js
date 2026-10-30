/**
 * OAuth 2.1 routes + lightweight dashboard for DeskLink (Express).
 */
import type { Express, Request, Response } from "express";
import {
  PRESETS,
  ALL_SCOPES,
  generateClientId,
  generateClientSecret,
  generateCode,
  generateAccessToken,
  generateRefreshToken,
  hashSecret,
  verifyPkce,
  saveApp,
  getApp,
  listApps,
  saveCode,
  getCode,
  markCodeUsed,
  saveToken,
  getToken,
  listTokens,
  revokeToken,
  saveGrant,
  revokeGrant,
  logActivity,
  listActivity,
  isValidOAuthToken,
} from "./oauth.js";

function issuer(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function scopesFromStr(s?: string): string[] {
  if (!s) return [];
  return s.replace(/,/g, " ").split(/\s+/).filter(Boolean);
}

export function isValidOAuthAccessToken(token: string): boolean {
  // Synchronous check against in-memory cache is not available;
  // we do a best-effort async-safe pattern by reading the store.
  // Callers should prefer the async version when possible.
  return false; // placeholder – real check is async below
}

export async function checkOAuthToken(token: string): Promise<boolean> {
  const tok = await getToken(token);
  return isValidOAuthToken(tok);
}

export function mountOAuthRoutes(app: Express): void {
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const iss = issuer(req);
    res.json({
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      registration_endpoint: `${iss}/oauth/register`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ALL_SCOPES,
      response_modes_supported: ["query"],
    });
  });

  app.post("/oauth/register", async (req, res) => {
    try {
      const body = req.body || {};
      const name = body.client_name || body.name || "Dynamic Client";
      const preset = body.preset || "custom";
      let scopes = body.scope || (PRESETS[preset] || PRESETS.custom).scopes.join(" ");
      if (Array.isArray(scopes)) scopes = scopes.join(" ");
      const redirect_uris = body.redirect_uris || [];
      const publicClient = (body.token_endpoint_auth_method || "none") === "none";
      const client_id = generateClientId();
      let secret: string | undefined;
      let secret_hash: string | undefined;
      if (!publicClient) {
        secret = generateClientSecret();
        secret_hash = hashSecret(secret);
      }
      const appObj = {
        client_id,
        name,
        preset,
        scopes: scopesFromStr(scopes) || ["mcp:tools"],
        public: publicClient,
        client_secret_hash: secret_hash,
        redirect_uris,
        description: body.description || "",
        created_at: Date.now() / 1000,
        active: true,
      };
      await saveApp(appObj);
      await logActivity("client_registered", `${name} (${client_id})`);
      const resp: any = {
        client_id,
        client_name: name,
        scope: appObj.scopes.join(" "),
        redirect_uris,
        token_endpoint_auth_method: publicClient ? "none" : "client_secret_post",
      };
      if (secret) resp.client_secret = secret;
      res.status(201).json(resp);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/oauth/authorize", async (req, res) => {
    const q = req.query as Record<string, string>;
    const client_id = q.client_id || "";
    const appObj = await getApp(client_id);
    if (!appObj || !appObj.active) {
      res.status(400).send("<h2>Unknown or inactive client</h2>");
      return;
    }
    const requested = scopesFromStr(q.scope) || appObj.scopes;
    const allowed = requested.filter((s: string) => appObj.scopes.includes(s)) || appObj.scopes;
    const checks = allowed
      .map(
        (s: string) =>
          `<label><input type="checkbox" name="scopes" value="${s}" checked> ${s}</label><br>`
      )
      .join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Authorize ${appObj.name}</title>
<style>body{font-family:system-ui;background:#0f1115;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d24;padding:2rem;border-radius:12px;max-width:460px}button{padding:0.6rem 1rem;border:0;border-radius:8px;margin-right:0.5rem;cursor:pointer}
.a{background:#3b82f6;color:#fff}.d{background:#374151;color:#fff}</style></head>
<body><div class="card"><h2>Authorize ${appObj.name}</h2><p>${appObj.description || appObj.preset}</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${appObj.client_id}">
<input type="hidden" name="redirect_uri" value="${q.redirect_uri || ""}">
<input type="hidden" name="state" value="${q.state || ""}">
<input type="hidden" name="code_challenge" value="${q.code_challenge || ""}">
<input type="hidden" name="code_challenge_method" value="${q.code_challenge_method || "S256"}">
${checks}<p><button class="a" name="decision" value="approve">Approve</button>
<button class="d" name="decision" value="deny">Deny</button></p></form></div></body></html>`;
    res.type("html").send(html);
  });

  app.post("/oauth/authorize", async (req, res) => {
    const form = req.body || {};
    const client_id = form.client_id || "";
    const decision = form.decision || "deny";
    const redirect_uri = form.redirect_uri || undefined;
    const state = form.state || "";
    let scopes = form.scopes;
    if (!Array.isArray(scopes)) scopes = scopes ? [scopes] : [];
    const code_challenge = form.code_challenge || undefined;
    const code_challenge_method = form.code_challenge_method || "S256";
    const appObj = await getApp(client_id);
    if (!appObj) {
      res.status(400).send("<h2>Unknown client</h2>");
      return;
    }
    if (decision !== "approve") {
      await logActivity("consent_denied", client_id);
      if (redirect_uri) {
        const q = new URLSearchParams({ error: "access_denied", state });
        res.redirect(302, `${redirect_uri}?${q}`);
        return;
      }
      res.send("<h2>Access denied</h2>");
      return;
    }
    await saveGrant({ client_id, scopes: scopes.length ? scopes : appObj.scopes, granted_at: Date.now() / 1000, revoked: false });
    const code = generateCode();
    await saveCode({
      code,
      client_id,
      redirect_uri,
      scopes: scopes.length ? scopes : appObj.scopes,
      code_challenge,
      code_challenge_method,
      expires_at: Date.now() / 1000 + 600,
      used: false,
    });
    await logActivity("consent_approved", client_id);
    if (redirect_uri) {
      const q = new URLSearchParams({ code, state });
      res.redirect(302, `${redirect_uri}?${q}`);
      return;
    }
    res.type("html").send(
      `<html><body style='font-family:system-ui;background:#0f1115;color:#eee;padding:2rem'><h2>Approved</h2><p>Code: <code>${code}</code></p></body></html>`
    );
  });

  app.post("/oauth/token", async (req, res) => {
    const form = req.body || {};
    const grant_type = form.grant_type || "";
    const client_id = form.client_id || "";
    const client_secret = form.client_secret;
    const appObj = await getApp(client_id);
    if (!appObj || !appObj.active) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    if (!appObj.public) {
      if (!client_secret || hashSecret(client_secret) !== appObj.client_secret_hash) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
    }
    if (grant_type === "authorization_code") {
      const code = form.code || "";
      const verifier = form.code_verifier;
      const authCode = await getCode(code);
      if (
        !authCode ||
        authCode.used ||
        authCode.expires_at < Date.now() / 1000 ||
        authCode.client_id !== client_id
      ) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (
        authCode.code_challenge &&
        (!verifier || !verifyPkce(verifier, authCode.code_challenge, authCode.code_challenge_method))
      ) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      await markCodeUsed(code);
      const access = generateAccessToken();
      const refresh = generateRefreshToken();
      await saveToken({
        token: access,
        client_id,
        scopes: authCode.scopes,
        expires_at: Date.now() / 1000 + 3600,
        refresh_token: refresh,
        revoked: false,
        created_at: Date.now() / 1000,
      });
      await logActivity("token_issued", client_id);
      res.json({
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refresh,
        scope: authCode.scopes.join(" "),
      });
      return;
    }
    if (grant_type === "refresh_token") {
      const refresh = form.refresh_token || "";
      const tokens = await listTokens(client_id);
      const existing = tokens.find((t: any) => t.refresh_token === refresh && !t.revoked);
      if (!existing) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const access = generateAccessToken();
      const newRefresh = generateRefreshToken();
      await saveToken({
        token: access,
        client_id,
        scopes: existing.scopes,
        expires_at: Date.now() / 1000 + 3600,
        refresh_token: newRefresh,
        revoked: false,
        created_at: Date.now() / 1000,
      });
      await revokeToken(existing.token);
      res.json({
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: newRefresh,
        scope: existing.scopes.join(" "),
      });
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  app.post("/oauth/revoke", async (req, res) => {
    const form = req.body || {};
    await revokeToken(form.token || "");
    res.status(200).json({});
  });

  app.get("/dashboard", async (_req, res) => {
    const apps = await listApps();
    const activity = await listActivity(30);
    const tokens = (await listTokens()).filter(
      (t: any) => !t.revoked && t.expires_at > Date.now() / 1000
    );
    const rows =
      apps
        .map(
          (a: any) =>
            `<tr><td>${a.name}</td><td><code>${a.client_id}</code></td><td>${a.preset}</td><td>${a.public ? "public" : "confidential"}</td><td>${(a.scopes || []).join(", ")}</td><td><form method='post' action='/dashboard/revoke/${a.client_id}'><button>Revoke</button></form></td></tr>`
        )
        .join("") || "<tr><td colspan='6'>No apps yet</td></tr>";
    const act = activity
      .map(
        (i: any) =>
          `<tr><td>${new Date(i.ts * 1000).toLocaleTimeString()}</td><td>${i.event}</td><td>${i.detail}</td></tr>`
      )
      .join("");
    const opts = Object.entries(PRESETS)
      .map(([k, v]) => `<option value='${k}'>${v.name}</option>`)
      .join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>DeskLink Dashboard</title>
<style>body{font-family:system-ui;background:#0f1115;color:#eee;margin:0;padding:1.5rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:0.5rem;border-bottom:1px solid #2a2f3a}
.card{background:#1a1d24;padding:1.25rem;border-radius:12px;margin-bottom:1rem}button{background:#3b82f6;color:#fff;border:0;padding:0.5rem 1rem;border-radius:8px}</style></head>
<body><h1>DeskLink Dashboard</h1>
<div class="card"><h2>Create OAuth app</h2><form method="post" action="/dashboard/create">Preset <select name="preset">${opts}</select> Name <input name="name" style="background:#111;color:#eee;border:1px solid #333;padding:0.4rem;border-radius:6px"> <button>Create</button></form></div>
<div class="card"><h2>Applications</h2><table><tr><th>Name</th><th>Client ID</th><th>Preset</th><th>Type</th><th>Scopes</th><th></th></tr>${rows}</table><p>Active tokens: ${tokens.length}</p></div>
<div class="card"><h2>Recent activity</h2><table><tr><th>Time</th><th>Event</th><th>Detail</th></tr>${act}</table></div></body></html>`;
    res.type("html").send(html);
  });

  app.post("/dashboard/create", async (req, res) => {
    const form = req.body || {};
    const preset = form.preset || "custom";
    const name = form.name || (PRESETS[preset] || PRESETS.custom).name;
    const scopes = (PRESETS[preset] || PRESETS.custom).scopes;
    const client_id = generateClientId();
    await saveApp({
      client_id,
      name,
      preset,
      scopes,
      public: true,
      created_at: Date.now() / 1000,
      active: true,
    });
    await logActivity("app_created", `${name} (${client_id})`);
    res.redirect(302, "/dashboard");
  });

  app.post("/dashboard/revoke/:clientId", async (req, res) => {
    const clientId = req.params.clientId;
    await revokeGrant(clientId);
    await logActivity("grant_revoked", clientId);
    res.redirect(302, "/dashboard");
  });
}
