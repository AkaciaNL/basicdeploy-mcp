<p align="center"><img src="./logo.svg" width="96" alt="BasicDeploy"></p>

# BasicDeploy MCP Server

**The persistent runtime your agent deploys to — a database, object storage, and a public URL, one MCP call.**

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets AI coding agents — Claude Code, Cursor, and any MCP client — create and manage [BasicDeploy](https://basicdeploy.com) containers directly. Every container comes with a PostgreSQL database, S3‑compatible object storage, environment variables, and a public HTTPS URL, all provisioned automatically. Your agent can create containers, deploy apps (Node, Python, Go, or Docker — auto‑detected), run commands, read logs, set always‑on, and share or delete containers.

- 🌐 Site: https://basicdeploy.com
- 📦 npm: https://www.npmjs.com/package/basicdeploy-mcp
- 📚 Docs: https://basicdeploy.com/docs

## Quick start

Requires Node.js ≥ 18. No install needed — `npx` fetches it on demand.

Get an API key at **https://basicdeploy.com/api-keys** (it looks like `bd_…`, shown once), then add this to your MCP client:

```json
{
  "mcpServers": {
    "basicdeploy": {
      "command": "npx",
      "args": ["-y", "basicdeploy-mcp@latest"],
      "env": {
        "BASICDEPLOY_API_KEY": "bd_your_api_key",
        "BASICDEPLOY_URL": "https://basicdeploy.com"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add basicdeploy \
  --env BASICDEPLOY_API_KEY=bd_your_api_key \
  --env BASICDEPLOY_URL=https://basicdeploy.com \
  -- npx -y basicdeploy-mcp@latest
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `BASICDEPLOY_API_KEY` | Yes | Your API key (`bd_…`). The server refuses to start without it. |
| `BASICDEPLOY_URL` | No | API base URL. Defaults to `https://basicdeploy.com`. |

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `list_containers` | — | List your containers: subdomain, status, URL, id, createdAt. |
| `create_container` | `memoryMb?` (256/512/1024/2048), `alwaysOn?` | Create a container. Database + S3 bucket provisioned automatically. Larger sizes need Pro/Scale; always‑on on Free uses a paid add‑on slot. |
| `get_container` | `containerId` | Full details: URL, status, ports, DB name/user, S3 bucket, volume path. |
| `deploy_app` | `tarballPath`, `containerId?` | Deploy a `.tar`/`.tar.gz`/`.tgz`/`.zip` from disk. Unpacks to `/workspace`, auto‑detects the runtime, and starts the app on `:8080`. Omit `containerId` to create a new container; pass one to deploy into an existing container. |
| `exec_command` | `containerId`, `command` | Run a shell command inside the container; returns output + exit code. |
| `get_logs` | `containerId`, `tail?` (default 200) | Fetch recent container logs. |
| `set_always_on` | `containerId`, `enabled` | Turn a container's 24/7 always‑on flag on/off. |
| `get_account` | — | Your plan, container limit (plan + add‑ons), selectable memory sizes, storage limit, and add‑ons. |
| `share_container` | `containerId`, `email`, `expiresInHours?` | Share a container with another user by email (they get a sign‑in link). Omit `expiresInHours` for an unlimited share. |
| `delete_container` | `containerId` | **Permanent** — destroys the container, its database, and all files. |

## Runtime

Deployed apps must listen on `0.0.0.0:8080` — that's the port the public URL serves. `DATABASE_URL` and `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` are preset in the container environment. Startup output goes to `/workspace/deploy.log`.

## Example prompts

- "Create a 1GB always‑on container and deploy `./dist/app.tar.gz` to it — give me the URL."
- "Show the last 100 log lines of my `blue-fox` container."
- "What plan am I on and how many containers can I run?"
- "Share my container with teammate@example.com for 24 hours."

## License

MIT. BasicDeploy is a product of Akacia (KVK 99629569, Netherlands).
