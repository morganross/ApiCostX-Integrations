# Allie Owl standalone product plan

Allie Owl is a new product with its own repository, service, hostname, API,
conversation store, agent runtime, tool registry, SDKs, CLI, MCP server,
deployment, metrics, tests, and release process.

The three systems remain distinct:

1. The APICostX backend API is the existing resource API.
2. The Allie Owl API is the new conversational API and developer tool layer.
3. The existing advanced chatbot is the website assistant using CopilotKit,
   LangGraph, and browser/page-owned hooks.

Owl reuses reviewed chatbot patterns such as model setup, graph-style tool
loops, knowledge conventions, memory limits, streaming contracts, retries,
and tests. It does not reuse the live website runtime, website threads,
assistant tokens, browser state, or assistant database.

## Product shape

The public interface is OpenAI-shaped:

- `GET /v1/models`;
- `POST /v1/chat/completions`;
- `POST /v1/conversations` and conversation reads/deletion;
- `GET /v1/tools`;
- `POST /v1/tools/call`;
- JSON errors, Bearer authentication, request IDs, and Server-Sent Events.

The user sends the existing APICostX API key as a Bearer credential. Owl
validates it through the unchanged APICostX API and forwards it only for the
authenticated user's downstream resource calls. Owl does not create another
user database or API-key format.

## Intelligence and tools

Owl has a separate system prompt and agent runtime. Its server-owned tools call
the existing APICostX API for content, presets, runs, logs, generated outputs,
models, usage, and credits. It also supports content/preset writes and run
pause/resume/cancel actions, all with explicit confirmation; the downstream
API remains the final authority for the user's existing permissions.

The model may use the tools in a conversation, while developers can call the
same typed tools directly through the API or MCP. Caller-owned tools are not
accepted yet, so they cannot replace or weaken Owl's APICostX tools.

## State and operations

Owl conversations are stored in its own SQLite store with AES-GCM encrypted
titles and messages, user-key-ID ownership checks, usage events, and audit
events. Chat is not billed, but Owl records turn count, character counts,
available token counts, tool count, request IDs, action outcome, and latency.
The first process has per-key request and concurrency guardrails; production
deployment must add shared limits, proxy body limits, key rotation, backups,
retention, and operational alerts.

The CLI uses the Python SDK, the TypeScript and Python SDKs use the public API,
and the MCP bridge exposes the conversational tool plus typed Owl actions.
None of these clients contains a second implementation of APICostX business
rules.

## Delivery phases

1. Harden the standalone service and OpenAPI schema, then run it against a
   disposable API key and mocked downstream/model services.
2. Add true provider event streaming, server-side identity introspection,
   distributed limits, compatibility tests against common OpenAI clients, and
   a real deployment unit.
3. Verify each adapter against the live APICostX API, including writes,
   execution, logs, outputs, and recovery, before external release.
4. Add `/v1/responses`, caller-owned tools, background jobs, or voice only
   after the Chat Completions product is stable and demand is known.

