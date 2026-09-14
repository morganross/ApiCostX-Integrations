# Chatbot review fixes

Date: 2026-09-13

## Scope and result

This change addresses the 28 findings from the local chatbot review across
`acm-allie-owl`, `acm-wordpress-plugin-run-count-fix`, and
`acm2-execution-reliability-local`. The client, website, backend, and Owl
changes were deployed on 2026-09-08; current service details are recorded in
`production-deployment.md`. Deployment is not evidence of a successful
production conversation or run.
The website assistant, standalone Owl service, and existing resource API remain
separate products/components with explicit integration contracts.

## Finding-by-finding changes

| # | Finding | Implementation |
|---|---|---|
| 1 | An ID could redirect a named action to another route | Resource IDs are validated and encoded in the shared content, preset, and run API clients; slash, backslash, percent encoding, query/hash syntax, whitespace and dot segments are rejected before HTTP |
| 2 | Advanced graph rejected canonical actions | Its manifest, choice parser, argument transport and result synthesis now recognize the shared actions; writes use the existing confirmation UI |
| 3 | Provider credentials were never sent | Config reads ALLIE_OWL_MODEL_API_KEY, with OPENAI_API_KEY as the supported default; the model HTTP client sends the credential, and repr hides it |
| 4 | Installation failed | Explicit Python package discovery and package-data mappings include the service, clients, MCP entry point, contracts and knowledge |
| 5 | CLI forgot earlier turns | First interactive turn requests storage, then subsequent turns reuse the returned conversation ID |
| 6 | TypeScript streaming returned an empty object | SDK parses SSE incrementally, handles split UTF-8, and surfaces errors |
| 7 | Streaming waited for the completed answer | Provider deltas pass through a bounded queue to SSE; keepalives cover tool/model waits |
| 8 | Successful content deletion appeared to fail | HTTP 204 is accepted without JSON parsing |
| 9 | Saved history bypassed limits | Combined history plus input is checked, and accumulated model/tool context has an additional budget |
| 10 | Advanced content reads ignored size | Character offsets and limits bound body reads |
| 11 | Basic listing ignored pages | Both website modes use the same paginated handler |
| 12 | Truncation had no continuation | Read results expose result_offset/result_chars and next_result_offset; individual text reads also expose character offsets |
| 13 | Tool schemas were advisory | Owl validates JSON Schema before execution; website tools validate equivalent schemas through Zod |
| 14 | Model could self-confirm | Owl matches exact client-approved actions, consumed once per request; basic website writes require a page confirmation, advanced writes use the existing confirmation card and the graph strips model-supplied confirm |
| 15 | Later failure erased action audit evidence | Tool start and outcome are recorded as execution proceeds, before the next model call |
| 16 | Failed operations disappeared from usage | Failed turns and direct-tool requests are recorded and included in usage summaries |
| 17 | Concurrent turns raced | Active turns on the same conversation return 409; deletion is also guarded, and history is reloaded inside the guard |
| 18 | Retry header did not prevent duplicate launches | Owl persists launch receipts; backend launch requests with Idempotency-Key reserve a user-scoped Redis receipt before side effects and replay completed results; frontend forwards the header and CORS allows it |
| 19 | Validation details were hidden | Safe bounded validation/conflict/rate-limit details and client status codes are preserved |
| 20 | Duplicate auth and fresh connections added overhead | One backend identity verification per request; persistent HTTP clients and one backend client per service instance |
| 21 | Conversation endpoints lacked limits | Authentication dependency applies limits to all authenticated endpoints; list/message reads are paginated; bodies are capped at 2 MB before parsing |
| 22 | Ownership changed across keys | Backend /api/identity returns verified UUID, key ID and scope; Owl stores ownership by UUID, migrating legacy rows only after verifying that exact key |
| 23 | Shared implementations drifted | Both website modes use one executor and exported schema definitions; regression checks compare backend/frontend schema copies against Owl's registry |
| 24 | Missing common website operations | Added duplicate content, resolve variables, duplicate preset, resume information, checkpoints, and delete run, bringing this contract to 28 actions |
| 25 | MCP fallback advertised a broken alias | Discovery errors are explicit; the legacy preset-list alias maps to the correct canonical tool |
| 26 | MCP errors lost the request ID | Error replies preserve the parsed request ID |
| 27 | Unsupported options were ignored | Unsupported response_format, top_p, caller tool transcripts and unknown options fail explicitly rather than pretending to honor them |
| 28 | Tests missed real behavior | Added regression tests for credentials, 204, traversal, validation, history budgets, write failures, concurrency, shared ownership, retry receipts, streaming timing and schema parity; frontend and SDK runtime checks exercise real adapter/parser code with mock transport |

## Verification

- Owl: `python -m pytest tests -q` — 18 passing at this checkpoint
- Owl: Python compileall — passed
- Owl: editable install and normal wheel build — passed; wheel contents include the service, SDK, MCP, contract JSON and knowledge Markdown
- Backend: `python -m pytest test_shared_assistant_actions.py -q` — 2 passing
- Backend expanded run with `test_api_keys.py` — 8 passed, 1 failed on a Unix 0600 permission assertion under Windows; the API-key storage code was not changed
- Website: `node scripts/check-shared-user-actions.cjs` — passed, including traversal variants and a legitimate deletion control
- Website: TypeScript and focused lint checks — passed during development; rerun after final changes
- Website: Vite production build — passed after installing the missing Windows optional binaries; no package manifest or lockfile change was needed for that repair
- TypeScript SDK: typecheck and `node test.cjs` — passed

The original path-redirection reproduction now throws before any network call.
The legitimate resource ID still reaches its original endpoint. The independent
security review perspective also checked alternate percent encodings,
backslashes, dot segments, query/hash suffixes and the sibling API clients.

## Operational boundaries and remaining validation

1. The backend identity endpoint is deployed. Missing or malformed identity
   fails closed, without reverting to key-only ownership. Backend Redis is
   required for launches that supply retry keys.
2. The current Owl limiter and conversation guard support one service process;
   distributed leases/limits remain necessary before multiple Owl workers or
   replicas. This change does not claim cross-process conversation locking.
3. Retry protection requires reuse of the same Idempotency-Key. Completed
   backend receipts last seven days; unknown launch outcomes stay reserved and
   require inspection/reconciliation rather than an automatic second launch.
4. A client handles acx_pending_actions by submitting approved_actions containing
   the exact name and arguments (without confirm). The CLI exposes /approve;
   direct typed API calls remain authorized by their caller and confirm=true.
5. Large mutable reads can change between pages; callers should re-read if an
   object changed during pagination. The transport does not claim snapshot
   isolation for mutable log/content pages.
6. Live provider authentication, website conversations, Redis receipt replay,
   and cross-account behavior have not been functionally exercised since the
   deployment. Mock checks cannot prove them.
7. The 28-action contract covers the reviewed content/preset/run gaps, not an
   exhaustive claim that every website function has an Owl action; Flow Lab and
   unrelated account-management features remain outside this implementation.
8. The existing build emits chunk-size and dependency browser-externalization
   warnings; a successful bundle is not a browser end-to-end test.

## OWL engine knowledge (2026-09-13)

The backend source contains an `OwlAdapter` and a separate JSON bridge. The
deployed runtime inspected on the backend worker contains CAMEL-AI 0.2.84 and
implements a CAMEL `Workforce` with task/coordinator agents plus configured
search workers. It exposes DuckDuckGo search only and deliberately does not add
browser, shell, or file-write tools. The runtime source checks APICostX pricing
before provider calls and requires token usage to meter a result. In the model
registry snapshot checked on 2026-09-13, `openai:gpt-5-mini` is enabled for OWL.

These details explain the implementation, not a successful user run. The
adapter cancellation method is currently a no-op; readiness checks inspect
configuration and paths rather than proving the CAMEL workflow executes. The
standalone Allie Owl API is a separate product from this OWL preset engine.
