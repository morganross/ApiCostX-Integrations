# Allie Owl clients

The Owl clients are under `owl/`.

- Python SDK: `owl/python/allie_owl_client`
- TypeScript SDK: `owl/typescript`, package `@apicostx/allie-owl`
- CLI: `allie-owl`
- MCP: `allie-owl-mcp`

The OpenAI-shaped endpoint is:

```text
https://assistant.apicostx.com/owl/v1/chat/completions
```

Use `conversation_id` for a continuing conversation. On a write request, Owl
returns a pending exact action when caller approval is missing; resend that
action in `approved_actions` after the user approves it. The CLI uses `/approve`
for this flow. Keep log/content reads paginated and use the returned offsets
for additional sections.
