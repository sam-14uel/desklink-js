# DeskLink (JavaScript)

Turn your local computer into a remotely accessible **MCP endpoint** for cloud AI agents.

DeskLink is a thin authenticated bridge: it loads local MCP servers (especially STDIO servers defined in a standard `mcp.json`), discovers their tools, and exposes all of them through a single Streamable HTTP URL (optionally tunnelled with ngrok).

## Quick start

```bash
npm install -g desklink
# Optional: export NGROK_AUTHTOKEN=your_token

# Option A: use a standard mcp.json (recommended)
desklink start --mcp-config ./mcp.json

# Option B: no config → default official filesystem server (home directory)
desklink start

# Or specify directories
desklink start --dir ~/Documents --dir ~/Projects
```

## Adding MCP servers

DeskLink supports any STDIO MCP server. Define them in a standard `mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"]
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "/path/to/repo"]
    },
    "custom": {
      "command": "node",
      "args": ["my_server.js"],
      "env": { "DEBUG": "1" },
      "cwd": "/path/to/workdir"
    }
  }
}
```

Then:

```bash
desklink start --mcp-config ./mcp.json
```

If no `mcp.json` is found, DeskLink automatically starts the official `@modelcontextprotocol/server-filesystem` (controlled by `--dir` or home).

Tool names are namespaced as `servername__toolname` (e.g. `filesystem__list_directory`).

## Listing and testing tools

```bash
# List all discovered tools (no tunnel started)
desklink tools
desklink tools --mcp-config ./mcp.json

# Call a tool with arguments (for testing)
desklink call filesystem__list_directory --args '{"path":"/tmp"}'
desklink call filesystem__read_file --args '{"path":"/tmp/test.txt"}'
```

## Configuration: desklink.config.json

Create `desklink.config.json` (or `~/.desklink/config.json`) for DeskLink settings:

```json
{
  "logging": {
    "level": "info"
  },
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
      "filesystem__create_directory": "prompt",
      "git__commit": "prompt"
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

### Full config options

| Section | Key | Values | Description |
|---------|-----|--------|-------------|
| `logging` | `level` | `debug`, `info`, `warning`, `error` | Log verbosity |
| `tracing` | `enabled` | `true` / `false` | Enable tool-call tracing |
| `tracing` | `level` | `none`, `basic`, `full` | `basic` = name + duration + error; `full` = + args + truncated result |
| `tracing` | `redact_sensitive` | `true` / `false` | Mask keys like password/token/secret/key |
| `auth` | `enabled` | `true` / `false` | Require Bearer token |
| `auth` | `token` | string | Override auto-generated token |
| `approvals` | `default` | `auto` / `prompt` | Default policy for all tools |
| `approvals` | `tools` | map of `namespaced_tool` → `auto`/`prompt` | Per-tool override |
| `server` | `host`, `port`, `mcp_path` | | Local bind settings |
| `tunnel` | `provider` | `ngrok`, `none` | Tunnel provider |

**Approval policies:**
- `auto` — tool calls execute immediately.
- `prompt` — DeskLink asks for confirmation in the terminal before executing the tool.

Environment variables (`NGROK_AUTHTOKEN`) and CLI flags override the config file.

## Security

- Bearer token required (generated and stored in `~/.desklink/token` by default).
- Optional per-tool approval prompts before execution (`auto` or `prompt`).
- Access is controlled by the underlying MCP servers you configure.

## Development

```bash
npm install
npm run build
npm run dev -- start --tunnel none
npm run dev -- tools
npm run dev -- call filesystem__list_directory --args '{"path":"/tmp"}'
```

Package name on npm is `desklink`.
