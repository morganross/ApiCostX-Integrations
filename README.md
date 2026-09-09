# ApiCostX-Integrations

Official public clients for two separate APICostX products:

| Product | API entry point | Purpose |
|---|---|---|
| APICostX Backend API | `https://api.apicostx.com` | Presets, Content Library, runs, outputs, models, and account data |
| Allie Owl Chatbot API | `https://assistant.apicostx.com/owl/v1` | OpenAI-shaped conversations and user-authorized APICostX actions |

These are separate API surfaces. A backend client does resource operations
directly; an Owl client sends conversational messages to Allie Owl. Both use a
user-created APICostX API key, sent only from a server, CLI, local MCP process,
or other trusted environment. Never place an API key in browser JavaScript,
source control, logs, or support messages.

## Six integrations

Each API has its own CLI, SDKs, and MCP server:

| Integration | Backend API | Allie Owl API |
|---|---|---|
| Python SDK | `backend/python` → `apicostx` | `owl/python` → `allie_owl_client` |
| TypeScript SDK | `backend/typescript` → `@apicostx/backend-sdk` | `owl/typescript` → `@apicostx/allie-owl` |
| Go SDK | `backend/go` | Use the OpenAI-compatible HTTP shape or add the Go Owl client when needed |
| CLI | `apicostx` | `allie-owl` |
| MCP server | `apicostx-backend-mcp` | `allie-owl-mcp` |

The Python distribution includes both CLIs and both MCP servers. The language
SDK folders are independently publishable packages.

## Python install

```bash
python -m pip install apicostx-api-tools
export APICOSTX_API_KEY='acm2.ak_...'
apicostx health
apicostx presets list
allie-owl models
```

For local installation from this repository:

```bash
python -m pip install .
```

## TypeScript install

```bash
npm install @apicostx/backend-sdk
npm install @apicostx/allie-owl
```

The backend SDK uses `https://api.apicostx.com` by default. The Owl SDK uses
`https://assistant.apicostx.com/owl` as its API base, so its chat endpoint is
`/v1/chat/completions`.

## MCP configuration

Backend MCP:

```json
{
  "mcpServers": {
    "apicostx-backend": {
      "command": "apicostx-backend-mcp",
      "env": {
        "APICOSTX_API_KEY": "${APICOSTX_API_KEY}"
      }
    }
  }
}
```

Allie Owl MCP:

```json
{
  "mcpServers": {
    "allie-owl": {
      "command": "allie-owl-mcp",
      "env": {
        "APICOSTX_API_KEY": "${APICOSTX_API_KEY}",
        "ALLIE_OWL_API_URL": "https://assistant.apicostx.com/owl"
      }
    }
  }
}
```

Writes and preset execution require explicit confirmation. The backend API
still enforces the user API-key scope and membership. Owl adds a separate
caller approval step for conversational writes.

## Release layout

This repository is the public client distribution. It does not contain the
APICostX backend, the website Allie runtime, Owl server secrets, private
knowledge, WordPress code, or database credentials. Release workflows publish
the Python package, the two npm packages, and the Go module after a version tag;
publishing credentials belong in GitHub Actions secrets or trusted publishing.

See [API boundaries](docs/api-boundaries.md), [backend client guide](docs/backend.md),
and [Owl client guide](docs/owl.md).

## Chatbot source

The public chatbot source is under [`chatbot/`](chatbot/): the standalone Owl
server, website assistant bridge and advanced graph, CopilotKit runtime,
assistant knowledge/tool docs, and mascot assets. This source is included for
transparency and development; deployment secrets and private infrastructure
files are excluded.
