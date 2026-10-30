# DeskLink (JavaScript)

Turn your local computer into a remotely accessible **MCP endpoint** for cloud AI agents.

DeskLink is a thin authenticated bridge: it loads local MCP servers (especially STDIO servers defined in a standard `mcp.json`), discovers their tools, and exposes all of them through a single Streamable HTTP URL (optionally tunnelled with ngrok).

## Quick start

```bash
npm install -g desklink
desklink start
```

## OAuth 2.1 for remote agents

DeskLink can act as an OAuth 2.1 authorization server so cloud MCP clients can obtain scoped access without sharing the device bearer token. Existing bearer-token authentication continues to work.

### Create an app

```bash
desklink create oauth-app claude
desklink create oauth-app chatgpt
desklink create oauth-app manus
desklink create oauth-app cursor
# or
devlink create oauth-app claude
```

Generates a Client ID (and secret for confidential clients), selects sensible scopes, and prints endpoints. Redirect URIs are optional. Public clients and dynamic registration are supported.

### Endpoints (when `desklink start` is running)

| Endpoint | URL |
|----------|-----|
| Metadata | `http://127.0.0.1:8765/.well-known/oauth-authorization-server` |
| Authorize | `http://127.0.0.1:8765/oauth/authorize` |
| Token | `http://127.0.0.1:8765/oauth/token` |
| Revoke | `http://127.0.0.1:8765/oauth/revoke` |
| Register | `POST http://127.0.0.1:8765/oauth/register` |
| Dashboard | `http://127.0.0.1:8765/dashboard` |
| MCP | `http://127.0.0.1:8765/mcp` |

### Manage

```bash
desklink oauth list
desklink oauth revoke <client_id>
```

Open `/dashboard` for the web UI (create apps, view Client IDs, revoke access, see activity). Agents using Authorization Code + PKCE see a consent screen.

Device identity (`~/.desklink/token`) stays separate from OAuth application credentials. Data is stored as JSON under `~/.desklink/oauth/` (no database).

## Adding MCP servers

DeskLink supports any STDIO MCP server. Define them in a standard `mcp.json`.

## Development

```bash
npm install
npm run build
npm run dev -- start --tunnel none
```

Package name on npm is `desklink`.
