# APICostX chatbot deployment manifest

Recorded: 2026-09-22T12:46:31Z

This manifest records the source branches, deployed file hashes, built assets,
service settings, and verification evidence for the APICostX chatbot surfaces.
Hashes are SHA-256. The canonical release branch is `release/chatbot` in each
existing application repository.

## Website frontend

- Repository: `morganross/acm-wordpress-plugin`
- Canonical release commit: `af694a2` (`release/chatbot`)
- Release history: the prior assistant branch was merged with `origin/main`
  before the hardening commits.
- Deployed source checkout: `/home/ubuntu/acm-wordpress-plugin`
- Deployed source hashes:
  - `ui/src/api/assistantDevLogger.ts`: `b3df3c8a60bfc727b881f2860ed4bd078c18e57efe92f1db1a162f1aacd50a87`
  - `ui/src/components/assistant/useAssistantPageTools.ts`: `0d8ce9eb0df76a0b58811fab939342d77d9198abcf38a3699c77797f8a088361`
  - `acm2-integration.php`: `7b5941ebc2633c4e29dd850505499f2990a6019b22441b61c0a6eab2dfe389af`
- Deployed build:
  - `assets/react-build/index.html`: `eaf49f17f8cb899e7236d9e6de5e0046fe661ababe64f1e74942727c76924aa8`
  - `assets/index-CLr3fLh2.js`: `bea8db4604861881c346f880a4fbd69990c11120bb749df1327859e1323acd9a`
  - `assets/AssistantRoot-BBxTVrlz.js`: `c7b123619ae3caa8f9a2e0633aa7fcb211ee4e2ca0cbda66a3d836bc9730ce57`
- Public `/app/` referenced `index-CLr3fLh2.js` after deployment.
- Public bootstrap reported assistant development logging disabled.
- The deployed assistant bundle contains the page-owned approval prompt.

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
- Canonical release commit: `cb284aa` (`release/chatbot`)
- Deployed source checkout: `/opt/acm-copilot`
- Source hashes:
  - `runtime/src/index.ts`: `2b49c95fba312958282de32382a6ec5769b5724279b4f17d9134fe7693023371`
  - `runtime/src/config.ts`: `911b2d06d55f77142c10c636ef37cf09d413308ec66071b3bf23f3c8b6bea901`
  - `runtime/src/perUserRunLimiter.ts`: `548dc64b222ac8c55d1a2591bc4f4172a33cd91815e06797943602542098ce88`
- Built runtime hashes:
  - `runtime/dist/index.js`: `a2d44e188df33dc46038fd8caeb1842fedd1bb641349d961486c4a799e8176bf`
  - `runtime/dist/config.js`: `fdc6a367d316d509f87a0acd107e91a3ad682cab8f5cdda72120a4eab6686b94`
  - `runtime/dist/perUserRunLimiter.js`: `ccc482c69b24e695da719b5c3cf0a3199c6673120269d0b586d776dfbd608ca8`
- Runtime health after restart:
  - model: `openai:gpt-5.6-luna`
  - reasoning effort: `high`
  - backend: `langgraph`
  - per-user model turns: 20 per rolling minute
  - concurrent model runs: 2 per user
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
- CopilotKit runtime: 17 passed in Node 24, including two new limiter tests.
- Standalone Owl: 18 passed during the review validation.
- Public website Allie health returned HTTP 200.
- Public backend API root and health returned HTTP 200 through Cloudflare while
  direct-origin access remained blocked.

## Deferred scaling item

Distributed Owl conversation locks and rate limits are intentionally deferred.
Keep Owl at one worker until those shared controls exist.
