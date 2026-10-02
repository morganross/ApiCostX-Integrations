# Allie reliability and public API repair — October 2, 2026 UTC

## Changes

Website Allie and the standalone Allie Owl API remain separate products. Website Allie uses the WordPress user's browser-side tools. Standalone Owl validates the caller's APICostX API key and uses typed backend HTTP adapters. No privileged backend bypass, key rotation, credential removal, or user-database replacement was introduced.

1. The website LangGraph agent normalizes both parsed tool calls and raw Responses `function_call` content before every model request. It retains only ordered, completed call/result exchanges, strips unmatched/late/duplicate results and stale provider reasoning items, and preserves visible text. It does not invent results or repeat interrupted mutations.
2. AG-UI RAW events are disabled. Normal text, tool-call, state and lifecycle events remain enabled. Metadata-only model timing callbacks are retained; Luna High remains the website configuration.
3. The frontend observes run-error events and reads the original live agent's message list after completion instead of a stale display wrapper. Empty/tool-only completion is a failure. A visible alert advises checking changes/runs before retrying; no automatic mutation retry was added.
4. Frontend tool exceptions return an explicit `frontend_tool_failed` receipt to the model instead of leaving a tool exchange without a result. This does not assert rollback or that no side effect occurred.
5. Responses render Markdown, including bold text, lists, code and GFM tables. Raw HTML is skipped, unsafe URL schemes are rejected by the renderer, external images become text placeholders, and links use safe new-tab attributes.
6. New `get_saved_preset_snapshot` reads the saved record and readiness concurrently without selecting or modifying the current draft. It accepts an ID or exact name, rejects ambiguous names, caps lookup at ten pages, distinguishes name from ID, and returns a compact engine/model/input/readiness summary. Knowledge guidance recommends this before larger overlapping reads.
7. Standalone Owl is reachable at `https://apicostx.com/__acm-copilot/owl/v1`. The existing WordPress proxy forwards the isolated `/owl/` path to the separate Owl service; API-key authentication is unchanged. Python/TypeScript SDK, CLI and MCP defaults are updated in the canonical and integrations repositories. Explicit URL overrides still work.

## Public endpoints

- OpenAI-shaped base: `https://apicostx.com/__acm-copilot/owl/v1`
- SDK/CLI/MCP base: `https://apicostx.com/__acm-copilot/owl`
- Health: `https://apicostx.com/__acm-copilot/owl/health`
- Backend resource API remains: `https://api.apicostx.com`

The originally advertised `assistant.apicostx.com` still has no public DNS record. It was not silently restored; current clients use the working existing hostname instead. No Cloudflare credentials were changed. Old installed packages may need `ALLIE_OWL_API_URL` or a SDK URL override until updated clients are released through package registries.

## Verification

- Seven history-repair regressions pass locally and against deployed Python dependencies, exercising the actual LangChain Responses formatter: raw/non-standard orphan calls, partial parallel results, out-of-order results, duplicates, text preservation and idempotence.
- Twelve frontend regressions pass on the server: reply detection, alert placement outside the scrolling history, Markdown rendering, HTML/link/image safety, exact/ambiguous lookup, lookup limits and invalid IDs. The first eleven also passed locally.
- The final live production build passes TypeScript, knowledge/tool declaration checks, the existing OWL configuration contract, and asset-singleton checks. Entry: `index-Dc3E7Ae1.js`; assistant chunk: `AssistantRoot-G60apbJ5.js`.
- Entry SHA-256: `4e5311b0d70a6c29e568099ff5b3276e6dffe60599eba646541b3533e1312706`.
- Assistant chunk SHA-256: `9464ba0dfe8c21c069cfff249ef8ba74f13f7dc2f95e146aa5409cc3a508d49e`.
- A previously interrupted website conversation completes a new saved-preset inspection with fresh tool evidence; the visible New draft remains selected. A deliberately nonexistent preset produces an honest failure answer instead of hanging or claiming success.
- A browser-only blocked chat request produces the visible failure alert; request blocking is removed immediately afterward. Production services were not stopped to simulate this failure.
- Screenshot review caught the original error banner scrolling offscreen. The final banner sits outside the history viewport and its visible bounds were verified at y=142–234 pixels. Normal chat resumes afterward with `RECOVERY_OK`, and another reload preserves that answer.
- Existing answers visibly render semantic Markdown after reload. Reauthentication and reload restore persisted history. No preset was saved or executed during these checks.
- Twenty standalone Owl tests pass locally. Python SDK tests verify the proxy prefix and API-key header for default/overridden URLs. TypeScript SSE verification covers the default URL, auth header, split lines and multibyte characters.
- Public Owl health returns 200; unauthenticated models returns 401. Backend and website assistant health remain 200. Nginx validation passes before reload.

## Deployment scope and remaining work

Only the website agent was restarted. Frontend assets were published after a successful staged build and the existing watcher was resumed. Owl's proxy was reloaded without restarting Owl. Unrelated live source edits, backend compatibility routes, user data and credentials were preserved. The frontend patch script rejects unexpected overlapping source drift and preserves unrelated package scripts and knowledge text.

GitHub patch commits: frontend `a618c5b` and `581d361` on `release/chatbot`; website runtime `80b2fce` on `release/chatbot`; canonical Owl `5e0ed20` on `main`; integrations first update `9f2adb7` on `main`. These are patch provenance, not a claim that the entire live checkout equals those commits. The frontend build manifest still names its existing base HEAD `f84792b`; unrelated live edits were deliberately preserved. Runtime source hashes: agent `2612ab84fdf607b06db25dd2d9b4214fe2fe8a169486182cb801d5385222f4a6`, history helper `75a676420be9ccb42877846c07c14ad7b0f86bfcffe5b32d91a658d4ea4276b2`. Metadata-only timing confirms one resumed text-only call reached its first token at 1,301 ms and finished at 1,775 ms; this is not a universal latency guarantee.

The website catalog is now 80 declared tools (52 direct plus 28 shared), not proof that every tool or website feature is verified. Standalone Owl remains at 28 typed actions. Successful authenticated standalone chat is untested here because the test account has no API key; no replacement key was minted or bypass used. Scheduled automation coverage and broader OpenAI client compatibility remain product work.

Three observed recovered-stream segments were approximately 3.5, 3.5 and 5.2 seconds, carrying 373, 458 and 288 KB. These are request segments, not a controlled full-turn latency comparison. History/state still adds payload overhead; disabling RAW copies does not solve all latency or checkpoint durability problems. Dependency installation reports five audit findings and the build has existing browser-externalization/large-chunk warnings; no unrelated dependency overhaul was applied.

Deferred item 10 remains unchanged: keep standalone Owl at one worker until shared conversation leases and distributed per-user rate/concurrency limits are implemented. No horizontal scaling was introduced.
