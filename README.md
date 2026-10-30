# DeskLink (JavaScript / TypeScript)

**Turn your local computer into a remotely accessible MCP endpoint for cloud AI agents.**

DeskLink is a thin authenticated bridge. It loads local MCP servers (especially STDIO servers defined in a standard `mcp.json`), discovers their tools, and exposes all of them through a single Streamable HTTP URL (optionally tunnelled with ngrok).

Package name on npm: **`desklink`**  
CLI commands: `desklink` and `devlink` (alias)

> **Status** – The Node/TypeScript package is under active development. Core OAuth 2.1 helpers and the package skeleton are in place. The full CLI + MCP bridge (parity with the Python version) is being completed. For production use today, prefer the [Python package](https://github.com/sam-14uel/desklink-py).

---

## What it does

1. Loads MCP servers from a standard `mcp.json` (or injects the official filesystem server if none are defined).
2. Starts a local Streamable HTTP server (default `http://127.0.0.1:8765/mcp`).
3. Proxies every discovered tool under a namespaced name (`servername__toolname`).
4. Protects the endpoint with a device bearer token **and/or** OAuth 2.1 (Authorization Code + PKCE).
5. Optionally opens an ngrok tunnel so the same endpoint is reachable from the public internet.
6. Provides a web dashboard + consent screen for OAuth apps.

You keep full control: tools stay on your machine, approvals can prompt you, and tokens never leave your machine unless you choose.

---

## Quick start

```bash
npm install -g desklink

# Optional but recommended for public tunnels
export NGROK_AUTHTOKEN=your_ngrok_token

desklink start
```

On first run DeskLink will create `~/.desklink/token` (device bearer token), start the configured MCP servers, and print the local + public MCP URLs together with the auth token.

### Useful flags (once CLI is fully wired)

```bash
desklink start \
  --mcp-config ./mcp.json \
  --config ./desklink.config.json \
  --dir ~/Documents --dir ~/projects \
  --port 8765 \
  --tunnel ngrok          # or "none" for local-only
  --token my-static-token # optional override
  -v                      # verbose logging
```

---

## Configuration

DeskLink looks for two files (first match wins):

| File | Search order |
|------|--------------|
| **DeskLink settings** | `--config` → `./desklink.config.json` → `~/.desklink/config.json` |
| **MCP servers** | `--mcp-config` → `./mcp.json` → `~/.desklink/mcp.json` |

### Example `mcp.json`

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents", "/Users/you/projects"]
    },
    "my-custom-server": {
      "command": "node",
      "args": ["./my-mcp-server.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

Any STDIO MCP server works. Tools appear as `filesystem__read_file`, `my-custom-server__do_something`, etc.

### Example `desklink.config.json`

```json
{
  "logging": { "level": "info" },
  "tracing": {
    "enabled": true,
    "level": "basic",
    "redact_sensitive": true
  },
  "auth": {
    "enabled": true
  },
  "approvals": {
    "default": "auto",
    "tools": {
      "filesystem__write_file": "prompt",
      "filesystem__create_directory": "prompt"
    }
  },
  "server": {
    "host": "127.0.0.1",
    "port": 8765,
    "mcp_path": "/mcp"
  },
  "tunnel": {
    "provider": "ngrok"
  }
}
```

**Approvals**  
- `"auto"` – run immediately  
- `"prompt"` – ask before the tool executes

**Tracing levels**  
- `none` / `basic` / `full`

---

## Authentication

### 1. Device bearer token

Stored at `~/.desklink/token`. Sent as:

```
Authorization: Bearer <token>
```

### 2. OAuth 2.1 (recommended for cloud agents)

DeskLink can act as an OAuth 2.1 authorization server so agents never see your device token.

**Create an app**

```bash
desklink create oauth-app claude
desklink create oauth-app chatgpt
desklink create oauth-app manus
desklink create oauth-app cursor
desklink create oauth-app custom --name "My Agent" --public
```

Presets ship with sensible default scopes. Confidential clients receive a Client Secret; public clients rely on PKCE.

**Endpoints (when `desklink start` is running)**

| Purpose | URL |
|---------|-----|
| Metadata | `http://127.0.0.1:8765/.well-known/oauth-authorization-server` |
| Authorize | `http://127.0.0.1:8765/oauth/authorize` |
| Token | `http://127.0.0.1:8765/oauth/token` |
| Revoke | `http://127.0.0.1:8765/oauth/revoke` |
| Dynamic registration | `POST http://127.0.0.1:8765/oauth/register` |
| Dashboard | `http://127.0.0.1:8765/dashboard` |
| MCP | `http://127.0.0.1:8765/mcp` |

**Manage**

```bash
desklink oauth list
desklink oauth revoke <client_id>
```

Or open `/dashboard` for the web UI.

**Scopes**

| Scope | Meaning |
|-------|---------|
| `mcp:tools` | Call tools |
| `mcp:resources` | Read resources |
| `filesystem:read` | Read files |
| `filesystem:write` | Write / create |
| `admin` | Full control |

All OAuth state is stored as JSON under `~/.desklink/oauth/` (no database).

---

## Customer usage flow

1. Install & start DeskLink on the machine whose tools/files you want to expose.
2. (Optional) Create an OAuth app for the agent you will connect.
3. Give the agent the **public MCP URL** + either the device token or the OAuth Client ID (and secret if confidential).
4. The agent discovers tools via normal MCP `tools/list` and calls them. DeskLink proxies the call to the local STDIO server, applies your approval policy, and returns the result.
5. Stop with `Ctrl+C`. The tunnel and local servers shut down cleanly.

---

## Extensibility

- **Any STDIO MCP server** – just add it to `mcp.json`.
- **Approvals & tracing** – configure per-tool policies and log levels.
- **Tunnel providers** – `ngrok` and `none` today; the interface is designed for more providers later.
- **Auth** – static bearer + full OAuth 2.1 (PKCE, refresh tokens, dynamic registration, consent screen).
- **Programmatic use** – import the package and drive the server/bridge from your own Node process once the core modules are complete.

---

## Development

```bash
git clone https://github.com/sam-14uel/desklink-js.git
cd desklink-js
npm install
npm run build
npm run dev -- start --tunnel none
```

Requires Node.js ≥ 18.

---

## License

MIT © Samuel Obinna Chimdi
