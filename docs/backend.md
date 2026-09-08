# Backend API clients

The Backend API clients are under `backend/`.

- Python: `backend/python`, package `apicostx`, command `apicostx`
- TypeScript: `backend/typescript`, package `@apicostx/backend-sdk`
- Go: `backend/go`, module `github.com/morganross/apicostx-go`
- MCP: `backend/mcp`, command `apicostx-backend-mcp`

Use a read-only key for discovery and a read/write key only when the program
must execute presets or perform other writes. Supply an idempotency key for a
retryable preset launch. Backend endpoint errors are returned as typed client
errors where the language client supports them.
