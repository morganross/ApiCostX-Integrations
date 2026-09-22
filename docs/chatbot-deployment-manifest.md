# APICostX chatbot deployment manifest

Recorded: 2026-09-22T12:46:31Z

This manifest records the source branches, deployed file hashes, built assets,
service settings, and verification evidence for the APICostX chatbot surfaces.
Hashes are SHA-256. The canonical release branch is `release/chatbot` in each
existing application repository.

## Website frontend

- Repository: `morganross/acm-wordpress-plugin`
- Canonical release commit: `6dff963` (`release/chatbot`)
- Release history: the prior assistant branch was merged with `origin/main`
  before the hardening commits.
- Deployed source checkout: `/home/ubuntu/acm-wordpress-plugin`
- Deployed source hashes:
  - `ui/src/api/assistantDevLogger.ts`: `b3df3c8a60bfc727b881f2860ed4bd078c18e57efe92f1db1a162f1aacd50a87`
  - `ui/src/components/assistant/useAssistantPageTools.ts`: `939191cfe2f81a30ba86fe371a4f1d8001c0ea6e1811d94aa8cf1e64c9006608`
  - `acm2-integration.php`: `7b5941ebc2633c4e29dd850505499f2990a6019b22441b61c0a6eab2dfe389af`
- Deployed build:
  - `assets/react-build/index.html`: `c4bc077c7d188db51b092956887de977a95fae84fbad93da0ae585444aff6ec6`
  - `assets/index-C7lCx4Bq.js`: `e3eceae7e7ea2fb911db4a62eb22b914e321fb0a90591630700ce6b69a086f8f`
  - `assets/AssistantRoot-B27RSEnz.js`: `ff17efbb053c0f73390ce30abb3a6ee161229772d15b0bec900afabcec0770ea`
- Public `/app/` referenced `index-C7lCx4Bq.js` after deployment.
- Public bootstrap reported assistant development logging disabled.
- This deployment did not change assistant tool confirmation behavior.

The live frontend checkout contains pre-existing changes beyond this release
branch. The deployed hashes above identify the actual running source/build;
the release commit identifies the reconciled reviewable branch.

## APICostX backend

- Repository: `morganross/acm2`
- Canonical release commit: `797c88b` (`release/chatbot`)
- Release history: `fix/execution-reliability` was merged with `origin/main`.
- Deployed source checkout: `/opt/acm2/acm2`
- `app/api/router.py`: `89ac28b4a6afd16944eabd18f34a874c254948dcad851636bb1984b33a21fea8`
- API child process was reloaded after Redis reported no queued or executing jobs.
- Local and public `/api/health` returned HTTP 200 after reload.
- `/api/assistant-advanced/capabilities` returned HTTP 404.
- `/api/internal/assistant-advanced/agent` returned HTTP 404.
- Public API root reported service `ACM2`, version `2.0.0`.

## Website CopilotKit and LangGraph runtime

- Repository: `morganross/acm-copilot-runtime`
- Canonical release commit: `5fb6518` (`release/chatbot`)
- Deployed source checkout: `/opt/acm-copilot`
- Source hashes:
  - `runtime/src/index.ts`: `9b8df91d1f82fc4a8586f9c0ae724ce55006eeed85417ee100e47446a5f80c94`
  - `runtime/src/config.ts`: `911b2d06d55f77142c10c636ef37cf09d413308ec66071b3bf23f3c8b6bea901`
  - `runtime/src/perUserRunLimiter.ts`: `606a0699d4cdc74026fb1ec56085b9525c5faacd5e0b3e3edc796c0411dc4fb6`
- Built runtime hashes:
  - `runtime/dist/index.js`: `0d67d467f6ce76c8effb1f5c0a810cf8a9b653ae2351c5ac17d284b0fd8c507f`
  - `runtime/dist/config.js`: `fdc6a367d316d509f87a0acd107e91a3ad682cab8f5cdda72120a4eab6686b94`
  - `runtime/dist/perUserRunLimiter.js`: `1ead0081c0b4e2803f7c738310135f4121cb03dafd69be18a2ea21f9bcad43ba`
- Runtime health after restart:
  - model: `openai:gpt-5.6-luna`
  - reasoning effort: `high`
  - backend: `langgraph`
  - per-user costly assistant requests: 20 per rolling minute
  - concurrent costly assistant requests: 2 per user
  - covered entrypoints: model runs, suggestions, direct assistant web search,
    and transcription
  - thread identity: verified user plus browser conversation

## Standalone Allie Owl developer product

- Canonical private repository: `morganross/APICostX-Allie-Owl`
- Canonical commit: `76ce772` (`main`)
- Live source checkout: `/opt/acm-allie-owl`
- The live checkout now has the canonical Git repository and origin configured.
- Runtime Python code, contracts, CLI, MCP, Python SDK, and knowledge files match
  the canonical commit when line-ending differences are ignored.
- The live deployment intentionally omits repository-only tests and the
  TypeScript SDK and retains older local deployment-status Markdown.
- `acm-allie-owl.service` remains configured with one Uvicorn worker.
- `assistant.apicostx.com` still lacked public DNS at this checkpoint.

## Verification

- Frontend TypeScript and Vite compilation completed; singleton build check
  passed; shared actions and assistant knowledge checks passed.
- Backend focused suite: 41 passed, 2 skipped.
- CopilotKit runtime: 18 passed in Node 24, including limiter and costly-entrypoint tests.
- Standalone Owl: 18 passed during the review validation.
- Public website Allie health returned HTTP 200.
- Public backend API root and health returned HTTP 200 through Cloudflare while
  direct-origin access remained blocked.

## Deferred scaling item

Distributed Owl conversation locks and rate limits are intentionally deferred.
Keep Owl at one worker until those shared controls exist.
