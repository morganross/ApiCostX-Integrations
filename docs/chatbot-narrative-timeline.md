# APICostX Chatbot Narrative Timeline

Date: 2026-09-13  
Purpose: explain how APICostX moved from two chatbot experiments to one
user-facing website Allie plus a separate Allie Owl developer API.

## Corrected conclusion

The user-facing website now has one active assistant, **Allie**. Its live path
is CopilotKit plus a Python LangGraph agent, and its APICostX actions execute as
typed tools in the logged-in browser. The frontend still calls this path
`basic` internally, but that label now points to the unified LangGraph-backed
assistant; it does not describe the original simple bot accurately.

The old Advanced assistant is retired as a user-selectable mode. Its frontend,
backend REST-thread, LangGraph, and website-bridge code still exists, and its
backend routes remain required by live frontend compatibility paths. The live
frontend explicitly sets `advancedModeAvailable = false`, so users cannot
select that mode; this flag is not evidence that the routes are unused.

Operational correction, 2026-09-22: removing both Advanced route groups caused
a functional outage while backend health continued to return 200. The routes
were restored from the committed router and are now protected by a regression
test. Do not remove them until live request tracing proves there are no callers
and the frontend dependency has been migrated.

The **Allie Owl API** is a second active chatbot product for developers. It is
conceptually the API-authorized counterpart of website Allie, but it is not a
literal copy of the website runtime. It has its own service, prompt, encrypted
conversation store, tool loop, SDK/CLI/MCP clients, and API-key authentication.
Its tools call the APICostX Backend API instead of asking the logged-in browser
to execute page-owned tools.

Therefore the present product story is:

```text
Website user
  -> one visible Allie
  -> CopilotKit runtime
  -> Python LangGraph agent
  -> typed browser/page tools
  -> APICostX with the logged-in website session

Developer or external client
  -> Allie Owl API
  -> independent Owl agent/tool loop
  -> typed APICostX API adapters
  -> APICostX with the user's API key
```

## Why the record is confusing

Several historical names survived the migration:

- The active unified website path is still called `basic` in frontend types,
  configuration, state variables, and API helper names.
- The old Advanced components and backend endpoints remain in the repositories
  even though the frontend disables that mode.
- Some older documents call Advanced the future assistant because they were
  written before One-Allie was implemented.
- The standalone Owl plan calls the website assistant “the existing advanced
  chatbot,” although the active website path is actually the unified CopilotKit
  and LangGraph path retained under the old `basic` name.
- APICostX also has a preset generator named `OWL`, implemented with CAMEL-AI;
  that engine is unrelated to the Allie Owl chatbot name.

Reading source presence as product activation leads to the wrong conclusion.
The current routing and availability flags determine what users actually use.

## Phase 1: original Basic assistant

The original Basic assistant used the React/CopilotKit website integration and
frontend-registered tools. The browser held the logged-in website authority,
and tool handlers used page state, page bridges, or the normal frontend API
client. The remote assistant did not receive the user's browser session token
or database key.

This path accumulated preset, Content Library, run, log, output, model, and
navigation tools. It also accumulated the original assistant thread UI and
event persistence behavior. This is why much of the current unified Allie
frontend still appears under names containing `basic`.

## Phase 2: separate Advanced experiment

During June 2026, APICostX developed a second assistant lane named Advanced.
It had a separate browser mode, separate backend REST conversation endpoints,
separate encrypted backend thread records, a backend LangGraph graph, and a
separate website-tool bridge.

The two assistants did not use identical “webhooks.” More precisely:

- Basic used CopilotKit/AG-UI frontend tools.
- Advanced posted conversations to `/api/assistant-advanced/*` and returned
  named tool requests to a dedicated frontend bridge.
- Both preserved the same security idea: the logged-in website performed
  APICostX actions, while the model did not receive raw backend credentials.

Advanced began as a chat/history MVP and gradually acquired website
capabilities. It was useful design and test work, but it duplicated prompts,
threads, tools, UI behavior, workflow code, and error handling. The June handoff
documents correctly describe this period, but they are historical descriptions
of a migration experiment rather than the current product architecture.

## Phase 3: One-Allie decision

The `APICostX One-Allie Implementation Plan` changed the direction. It decided
that users should see one assistant named Allie, using:

- CopilotKit for UI, streaming, frontend tool registration, and AG-UI;
- one LangGraph agent as the reasoning/orchestration brain;
- one typed browser-tool catalog;
- one conversation identity and encrypted event store;
- a narrow classifier/router inside the graph, not a Basic-versus-Advanced
  classifier.

The plan explicitly said Basic and Advanced would cease to be separate
user-facing assistants. It also separated retirement from deletion: the rollout
kept the old Basic behavior as a rollback path, and required old Advanced code
to remain until equivalent coverage and a stable observation period existed.

## Phase 4: unified website Allie activated

On 2026-08-31, the runtime history records the actual cutover:

- `694a55d` — **Activate unified open-source LangGraph Allie**;
- `80332aa` — **Record complete One-Allie provider acceptance**;
- `c41955d` — **Run Allie exclusively on Luna High**;
- `01d1db1` — **Isolate and encrypt assistant user chats**.

The frontend history for the same cutover includes:

- `f49cf7c` — **Unify and harden Allie frontend tools**;
- `e1b4a14` — **Isolate Allie threads and hydrate selected presets**;
- `2e67156` — **Present one Allie assistant**.

The activated architecture is:

```text
APICostX React page
  -> CopilotKit runtime
  -> AG-UI HttpAgent
  -> loopback Python LangGraph service
  -> frontend tool requests
  -> logged-in browser executes the tools
```

Acceptance records say the unified path handled normal chat, isolated
conversations, preset creation/hydration/save/execute, bounded run evidence,
and Mini, Luna, and Google provider fixtures. The visible header was reduced to
one static Allie identity with no Basic/Advanced selector.

The current live configuration still confirms this architecture:

- Copilot runtime `agentBackend` is `langgraph`;
- the LangGraph endpoint is loopback-only;
- the active text model is `openai:gpt-5.6-luna` with high reasoning;
- the frontend sets `advancedModeAvailable = false`;
- `AssistantCopilotHooks` mounts only for the internally named `basic` path.

This means the original Basic backend behavior was replaced while much of its
frontend shell and naming was reused. The separate Advanced product path was
disabled. Neither historical implementation was completely deleted.

## Phase 5: strengthening unified Allie

From 2026-09-01 through 2026-09-04, the unified path received follow-up work:

- on-demand feature knowledge and larger bounded context budgets;
- engine-selection guidance;
- orphaned-tool-history repair;
- restored Content Library read/write tools;
- detached completed agent runs and safer composer lifecycle;
- cursor-based, bounded verbose log reading;
- current run summaries, output counts, and ownership-denial handling.

These changes belong to the unified website Allie path even where source names
still say `basic`.

## Phase 6: standalone Allie Owl API

From 2026-09-06, APICostX built a separate conversational developer product:

- `cbae2b2` — build the standalone Allie Owl product;
- `bf97486` — add the Owl API and developer clients;
- `b7118d0` — define the shared Owl action contract;
- `fc34039` — harden authentication, tools, conversations, and clients;
- `bd8ca1c` — record production activation and the public API address.

The service is available under:

```text
https://assistant.apicostx.com/owl/v1
```

It deliberately does not reuse website Allie threads, browser state,
assistant tokens, or the website conversation database. It does reuse reviewed
ideas and compatible action names: model/tool-loop patterns, knowledge files,
result limits, confirmation concepts, and APICostX object descriptions.

The authority difference is the key product distinction:

| Product | Authenticated actor | Action transport |
|---|---|---|
| Website Allie | Logged-in website page | Browser/frontend tools through CopilotKit and AG-UI |
| Allie Owl API | User API key validated by Owl/backend | Owl server tools call the APICostX Backend API |

Calling Owl a “copy” is reasonable at the product-concept level, but inaccurate
at the implementation level. It is an independent implementation designed to
offer similar or broader user-authorized APICostX operations to external
OpenAI-shaped clients, SDKs, CLIs, and MCP clients.

## Phase 7: shared action contract

Work on 2026-09-06 and 2026-09-07 aligned canonical APICostX action names
between website Allie and the Owl API. This did not merge the runtimes or their
credentials. It made the two products describe and execute comparable
user-owned operations through different authority adapters.

The desired relationship is:

```text
One user intent/tool vocabulary
  -> website adapter: browser session and page workflow
  -> Owl adapter: APICostX API key and backend resource API
```

Some implementation remains duplicated, and the shared contract does not mean
the two chatbots share conversations, memory, or runtime state.

## Phase 8: CAMEL-AI OWL engine clarification

On 2026-09-13, the chatbots were taught that the `OWL` preset generator is a
third meaning of “Owl.” It is an APICostX generation engine implemented with a
separate CAMEL-AI Workforce runtime. It is not website Allie and is not the
Allie Owl API.

This naming collision does not change the chatbot timeline, but it explains why
future docs and prompts must use these full names:

- **Allie** — the one user-facing website assistant;
- **Allie Owl API** — the independent developer chatbot API;
- **APICostX OWL engine** — the CAMEL-AI preset generator.

## Current architecture as of 2026-09-13

### Active products

1. **Website Allie** — one visible assistant, CopilotKit plus Python LangGraph,
   using typed browser/page tools and the website session.
2. **Allie Owl API** — separate developer chatbot service, using the user's
   API key and typed APICostX Backend API adapters.

### Compatibility and rollback code

1. The old Advanced frontend mode is hidden, but its bridge, REST client,
   backend thread service, graph, and routes remain compatibility dependencies.
2. The current frontend hard-disables Advanced with
   `advancedModeAvailable = false`.
3. The old Built-in Copilot runtime remains a configuration rollback from the
   active LangGraph backend.
4. Historical `basic` names remain around the active unified website path.

### What is retired versus removed

| Component | User-facing status | Code status |
|---|---|---|
| Original Basic assistant behavior | Replaced by unified LangGraph Allie | Frontend shell/names reused; Built-in backend retained as rollback |
| Separate Advanced assistant | Not user-selectable | Frontend/backend compatibility code and routes remain active dependencies |
| Unified website Allie | Active | Current production path |
| Allie Owl API | Active separate product | Independent service and state |

## Terminology and product names

The project has reused several words for different things. The following names
should be used consistently in future code, documentation, support, and UI:

| Preferred name | Meaning | Avoid calling it |
|---|---|---|
| Website Allie | The one assistant visible inside the logged-in APICostX website | Basic bot, Advanced bot, Owl API |
| Unified Allie runtime | CopilotKit runtime plus the active Python LangGraph agent | Basic backend |
| Advanced compatibility lane | Hidden REST-thread and website-bridge path still used by live frontend code | Current visible Allie identity |
| Built-in runtime agent | Configuration rollback behind the Copilot runtime | A second active chatbot |
| Allie Owl API | The independent OpenAI-shaped developer chatbot | Website Allie, Advanced mode |
| APICostX Backend API | The resource API used by website and developer integrations | Owl API |
| APICostX OWL engine | The CAMEL-AI preset generation engine | Allie Owl chatbot |

The word `basic` should now be treated as implementation debt. It identifies the
frontend branch through which unified Allie is mounted, not a simpler model or
a separate user-visible assistant. The word `advanced` identifies a hidden
compatibility lane and its historical design; it must not be treated as unused.

## Detailed architecture comparison

| Property | Original Basic | Legacy Advanced | Unified website Allie | Allie Owl API |
|---|---|---|---|---|
| User surface | Website assistant mode | Website assistant mode | Single website assistant | External API, SDK, CLI, MCP |
| Current status | Behavior replaced | Hidden UI; compatibility routes required | Active | Active |
| Chat UI | CopilotKit React | Shared panel with separate mode | CopilotKit React | Client-owned UI or terminal |
| Reasoning runtime | CopilotKit built-in agent | Backend LangGraph service | Python LangGraph behind CopilotKit | Independent Owl model/tool loop |
| Product-data authority | Logged-in browser tools | Logged-in browser bridge | Logged-in browser tools | User API key through Backend API |
| Conversation store | Copilot runtime store | User backend database | Copilot runtime encrypted store | Independent encrypted Owl store |
| Tool transport | CopilotKit frontend tools | REST tool request/result exchange | AG-UI frontend tools | Server-side APICostX adapters |
| Direct backend credentials in model | No | No | No | No; Owl service holds transient caller key for downstream requests |
| Knowledge path | Frontend knowledge/context | Backend prompt and bounded context | Frontend compact core plus on-demand topics | Owl Markdown loaded into its protected prompt |
| Rollback role | Parts retained | Code retained but disabled | Current production path | Independently stoppable product |

## Original Basic architecture in detail

Basic was not simply a small text chatbot. It was the original CopilotKit
integration and became the main home for browser-side capabilities. Its
important architectural properties were:

1. React mounted the assistant panel inside the authenticated website.
2. `useFrontendTool` registered named tools with schemas and handlers.
3. Handlers read page state or called normal frontend APIs with the logged-in
   website session.
4. CopilotKit transported model tool requests to the page and tool results back
   to the model.
5. Assistant conversation events were stored by the assistant runtime rather
   than in normal preset/run tables.

The original limitation was not merely model quality. The architecture had to
solve thread identity, tool-result size, lifecycle locks, page hydration,
provider routing, current run evidence, and user isolation. Much of the work
later described as “unified Allie” upgraded this existing route instead of
replacing every frontend component.

## Legacy Advanced architecture in detail

Advanced was built as a parallel experiment because the project wanted a more
capable LangGraph-driven operator before the original CopilotKit path had that
brain. Its request flow was:

```text
Assistant panel in Advanced mode
  -> normal APICostX frontend API client
  -> /api/assistant-advanced threads/messages
  -> encrypted user-owned backend assistant records
  -> backend LangGraph graph
  -> optional named website tool request
  -> AdvancedWebsiteToolBridge in the page
  -> tool result posted to the backend thread
  -> LangGraph continuation and final answer
```

This path preserved user authorization by returning tool requests to the page.
It did not hand the backend graph the browser token or unrestricted Backend API
access. However, it created a second implementation of conversations, prompts,
tool routing, result synthesis, and mutation workflows. That duplication became
the reason to stop presenting two modes to users.

Advanced contributed useful designs that survived the migration:

- LangGraph-based multi-step reasoning;
- deterministic handling for sensitive workflows;
- bounded page and tool context;
- explicit tool-request/result messages;
- separation of canonical reads from visible page mutation;
- the principle that visible chat usefulness, not a backend 200 response, is
  the success condition.

Its code remaining in the tree should not be mistaken for a decision to keep
the product mode.

## Unified website Allie request lifecycle

A current website turn follows this conceptual sequence:

1. The logged-in user opens Allie and selects or creates a conversation.
2. The frontend associates that conversation ID with CopilotKit's agent thread.
3. The frontend builds compact page context, memory summary, pinned facts, and
   the knowledge-topic manifest.
4. The authenticated request reaches the Copilot runtime.
5. The runtime validates assistant-token identity and conversation ownership.
6. The runtime maps the public conversation ID to a subject-bound internal
   thread key.
7. The runtime sends the turn through AG-UI to the loopback Python LangGraph
   service.
8. LangGraph answers directly or requests one or more named frontend tools.
9. The logged-in page executes those tools with page/session authority.
10. Bounded tool results return through CopilotKit to LangGraph.
11. LangGraph produces the visible response.
12. The assistant runtime persists encrypted conversation events and releases
    the active-run lifecycle state.

The model reasons about actions but is not the authenticated actor. The page is
the actor for APICostX website operations. The Copilot runtime and LangGraph
service are orchestration layers.

## Website authentication and authority

Website Allie has two credentials with different jobs:

- The website session authenticates normal APICostX resource actions made by
  frontend tools.
- The assistant token authenticates the browser to the Copilot runtime and
  binds the assistant request to a user/conversation subject.

Neither credential should be sent to the LangGraph model as prompt content or
tool arguments. A frontend tool may call the Backend API because the normal page
already has that authority; the model receives only the bounded result.

This design means “Allie can do what the logged-in user can do” is implemented
through allowlisted website capabilities, not by giving LangGraph an all-powerful
Backend API client.

## Unified conversation identity and storage

The One-Allie design required one conversation ID to connect the UI, CopilotKit
thread, LangGraph state, durable message store, and audit/usage records. The
August security work added subject-bound thread scoping and authenticated
encryption for sensitive conversation fields.

Current website conversation properties include:

- per-user ownership checks before live operations;
- a subject-bound internal thread mapping rather than a process-global default;
- encrypted durable assistant data;
- independent conversations that do not share one active-run lock;
- repair of orphaned tool-call history before subsequent model requests;
- cleanup/detachment of completed active runs so the composer becomes usable.

The Python LangGraph agent currently uses an in-memory checkpointer, while the
runtime's event store supplies durable conversation restoration. A separate
durable LangGraph checkpointer remains optional work if graph-local state must
survive independently of the runtime store.

## Unified website tool evolution

The tool system grew in layers:

1. Page orientation and route context.
2. Preset inspection and visible draft manipulation.
3. Model discovery and compatibility information.
4. Content Library reads and writes.
5. Preset creation, hydration, validation, save, and execution.
6. Recent/latest run discovery independent of the visible route.
7. Run status, failures, costs, logs, and generated outputs.
8. Bounded verbose-log cursors for real-time diagnosis.
9. Shared canonical APICostX action aliases matching the Owl API vocabulary.

Tools do not all have the same effect. A canonical read should not navigate or
change the page. A visible-draft tool intentionally changes page state. A save
persists a draft. Execution spends resources and creates a run. The One-Allie
plan called for one catalog to encode these effects, confirmation requirements,
limits, idempotency, and audit names.

The current system has moved toward that catalog but still contains legacy tool
names and duplicate bridge code. Shared action schemas reduce drift but do not
yet eliminate every older tool definition.

## Website knowledge architecture

Unified website Allie receives knowledge through the frontend rather than
having the remote model read arbitrary project files. The current knowledge
pack has two layers:

1. A compact always-on core and topic index included with each turn.
2. Allowlisted Markdown topics retrieved with `read_knowledge_topic` when a
   question needs deeper product guidance.

Live page context and fresh tool results outrank static knowledge. This matters
for model availability, preset contents, readiness, run status, pricing, and
outputs. Static docs explain meaning and strategy; tools establish current user
facts.

The knowledge pack covers APICostX concepts, glossary terms, tool behavior,
diagnostic playbooks, preset quality, engine strategy, current project status,
and the CAMEL-AI OWL engine distinction. It should not contain private hosts,
credentials, database paths, or operator procedures.

## Model and provider history

The unified runtime was activated with an explicit provider path rather than
silently routing ordinary OpenAI work through another compatibility service.
Acceptance records cover one-call Mini, Luna, and Google Flash fixtures. The
active website model was later pinned to `openai:gpt-5.6-luna` with high
reasoning effort for text and public-search behavior; audio transcription uses
a separate model.

Model selection for APICostX preset execution is different from the model that
powers Allie's conversation. Allie may help configure a preset containing many
providers and engines without switching its own conversational model.

## Allie Owl API request lifecycle

A developer API turn follows a separate sequence:

1. A client sends an OpenAI-shaped request to the Owl endpoint with an existing
   APICostX API key as a Bearer credential.
2. Owl parses the key format and asks the Backend API to authenticate it and
   return a stable user identity.
3. Owl checks conversation ownership, request limits, context size, and active
   conversation state.
4. Owl builds its protected prompt from its system rules and reviewed Markdown
   knowledge.
5. Owl's model either answers or calls a server-owned APICostX tool.
6. The tool adapter forwards the user's API key to one allowlisted Backend API
   operation.
7. The Backend API enforces user ownership, key scope, and membership.
8. Owl records usage and action audit events, stores encrypted conversation
   content when requested, and returns OpenAI-shaped JSON or SSE.

The raw API key is used transiently for downstream calls and must not be stored
in Owl conversations, logs, or audit payloads. Owl conversation ownership uses
the backend-verified user identity so multiple keys belonging to one user can
address the same user namespace.

## Allie Owl state and storage

The Owl API has its own SQLite store and encryption key. It does not read or
write the website assistant's conversation database. It stores:

- encrypted conversation titles and messages;
- conversation ownership;
- coarse request/turn/tool usage;
- action audit events;
- idempotency receipts for protected actions.

The service currently runs one worker because its conversation guard and rate
limiter are process-local. Multiple replicas require shared leases and limits
before they can safely provide the same guarantees.

## Owl API tool model

Owl exposes server-owned, schema-validated APICostX actions for Content Library,
presets, runs, logs, outputs, models, usage, and credits. Reads are bounded and
can return continuation offsets. Writes require caller approval distinct from
model-generated arguments.

The downstream Backend API remains the final authority. Owl does not gain
billing administration, unrestricted SQL, arbitrary HTTP, shell, filesystem,
or cross-user access. A direct typed MCP/API caller still acts under its own API
key and the declared confirmation/idempotency contract.

## Shared action vocabulary

The website and Owl API now share canonical names for common APICostX actions.
This has three benefits:

- documentation can describe one user intent consistently;
- frontend and API adapters can be compared for behavioral parity;
- SDK/MCP clients can expose recognizable operations.

It does not create a shared security context. The same conceptual action has
two implementations:

```text
apicostx_create_content
  website -> frontend API client with website session
  Owl API -> backend adapter with user API key
```

The contract should eventually become generated source for schemas,
descriptions, result limits, effect types, confirmation policy, and audit names.
At present, copies exist in several repositories and must be synchronized.

## Classifier and routing clarification

The original project had classification logic, but the One-Allie decision did
not preserve a classifier that chooses Basic versus Advanced. There is no
user-facing routing between two assistant products now.

The One-Allie plan proposed a lightweight router inside LangGraph for obvious
tool decisions, effect policy, known workflows, and impossible requests. The
main model should handle ambiguous choices unless measurement proves that a
separate cheap classifier reduces total cost and errors.

Legacy Advanced still contains substantial deterministic routing and result
synthesis. Its presence does not mean that graph is the active unified brain;
only the Copilot runtime's configured `agentBackend` determines that.

## Confirmation and spending model

Website and Owl confirmations differ because the authenticated actor differs:

- Website Allie uses page-owned confirmation UI before a mutating or spending
  frontend tool executes.
- Owl API returns an exact pending action and requires the client to approve
  that exact name/argument set.

A model inserting `confirm=true` into its own arguments is not proof of human
approval. Idempotency protects retryable run launches from duplicate spending,
but only when callers reuse the same idempotency key for the same operation.

## Error, cancellation, and recovery behavior

The website runtime limits duplicate status polling, repairs malformed tool
history, bounds large tool results, and releases conversation locks after
terminal outcomes. The old Built-in runtime agent remains a rollback path if
the LangGraph backend is disabled.

Owl API errors use an OpenAI-shaped envelope and preserve request IDs. Its
conversation guard rejects overlapping turns in one conversation. Failed turns
and tool calls still create coarse usage/audit evidence.

Not every cancellation statement means the underlying work stops. In
particular, the APICostX CAMEL-AI OWL engine adapter currently returns success
from `cancel()` without actually terminating its external runtime. Chatbots must
not claim cancellation is proven unless current run evidence confirms it.

## Deployment topology

The active chatbot services are independently managed:

```text
Website frontend
  APICostX WordPress/React plugin
  mounts the single visible Allie panel and browser tools

Assistant node
  Copilot runtime: authenticated transport, threads, persistence
  Python LangGraph: active website Allie brain
  Allie Owl service: separate developer chatbot API

Backend
  APICostX resource API
  legacy Advanced endpoints and graph code
  preset/run/content/model services used by page tools and Owl adapters
```

The unified website LangGraph and Owl API are separate processes and can be
restarted or stopped independently. The Owl API is currently exposed below the
assistant hostname under `/owl/v1`; that shared hostname does not merge the two
services.

## Repository ownership map

| Repository | Chatbot responsibility |
|---|---|
| `acm-wordpress-plugin` | Website UI, browser/page tools, knowledge pack, page confirmation, website session calls |
| `acm-copilot-runtime` | Unified website transport, Python LangGraph service, encrypted website conversations, runtime prompts |
| `acm2` | Backend resources, legacy Advanced APIs/graph, API-key identity, shared schemas, run execution |
| `acm-allie-owl` | Standalone Owl API, prompt, tool adapters, encrypted Owl conversations, usage/audit |
| `ApiCostX-Integrations` | Public SDKs, CLIs, MCP servers, public chatbot source snapshots and narrative docs |

The source snapshots in `ApiCostX-Integrations` are for transparency and
integration development. Changes should originate in the owning repository and
then be synchronized to the public snapshot.

## Evidence hierarchy

Conflicting claims should be resolved in this order:

1. Current live routing and process configuration.
2. Current source at the mounted production paths.
3. Current repository source and recent commits.
4. Production activation and acceptance documents.
5. Plans and handoff documents.
6. Old progress journals and generated stress logs.
7. Chat recollection.

A file existing in source proves only that the implementation exists. It does
not prove the route is enabled, the service is running, a tool is reachable, or
a user workflow succeeds.

## Evidence-backed facts versus assumptions

### Directly supported

- One visible Allie is the current website product.
- Advanced selection is disabled in the live frontend.
- The Copilot runtime is configured to use the loopback Python LangGraph agent.
- Website actions run through typed frontend tools.
- The Owl API is a separate running service with Backend API adapters.
- Website and Owl conversations use separate stores and credentials.
- Legacy Advanced frontend/backend code still exists.
- The active unified frontend route retains the name `basic`.

### Supported by dated acceptance records

- Mini, Luna, and Google fixtures completed through unified Allie on
  2026-08-31.
- Two conversations were isolated in that acceptance pass.
- Preset creation, hydration, save, execution, and run inspection completed in
  that acceptance pass.

These are historical acceptance facts, not perpetual uptime guarantees.

### Not established merely by architecture

- That every website tool has parity with an Owl API tool.
- That every old Advanced workflow was ported into unified Allie.
- That every external OpenAI-compatible client works with Owl.
- That multiple Owl service replicas are safe.
- That current provider/model availability matches an older fixture.
- That Advanced APIs can be removed because the visible mode is disabled.

## Current architectural debt

1. **Misleading `basic` naming.** The active unified path still uses Basic-era
   names in state, configuration, helpers, and endpoint objects.
2. **Advanced compatibility dependency.** The selector is disabled, while the
   frontend REST client, bridge, backend routes, database models, services, and
   graph still participate in live behavior.
3. **Multiple prompt copies.** Website frontend knowledge, Copilot runtime
   prompt, Python agent prompt, legacy Advanced prompt, and Owl prompt can drift.
4. **Multiple tool catalogs.** Canonical shared actions coexist with older
   website tool names and legacy Advanced tools.
5. **Two active conversation implementations.** This is intentional across the
   website and developer products, but requires clear product naming and
   separate operational monitoring.
6. **One-worker Owl limitation.** Process-local locking and limiting prevent
   safe horizontal scaling without additional shared coordination.
7. **Historical document drift.** Several plans accurately describe their time
   period but use present tense and therefore appear current.

## Recommended cleanup sequence

Cleanup should preserve the current working path while removing misleading
structure in small, reviewable stages:

1. Rename the active frontend mode and configuration from `basic` to `unified`
   or remove the mode abstraction entirely.
2. Remove the Basic/Advanced preference from settings and bootstrap payloads.
3. Add request telemetry for `/api/assistant-advanced` and its internal bridge,
   preserving user privacy while identifying callers and required operations.
4. Migrate every observed frontend dependency to the unified path and prove
   parity with contract and browser tests.
5. Export or archive any Advanced-only conversations that must be kept.
6. Remove Advanced frontend/backend code only after telemetry shows no callers,
   the dependency migration is deployed, and a rollback plan exists.
7. Keep the Built-in Copilot agent only as an explicitly documented rollback,
   or remove it after a separate rollback plan exists.
8. Generate website and Owl action schemas/docs from one reviewed contract.
9. Define one source-of-truth product knowledge package with adapters for the
   website and Owl prompt budgets.
10. Add distributed conversation leases and rate limits before scaling Owl
    beyond one worker.

## Criteria for complete retirement

Basic and Advanced can be called fully removed only when all of the following
are true:

- no user-facing selector or setting refers to either mode;
- no active frontend state or function names depend on `basic`/`advanced`;
- no production network call targets the Advanced REST API;
- legacy Advanced conversations have an explicit archive/delete decision;
- duplicate bridge and graph code is removed;
- rollback no longer depends on the original Basic built-in agent;
- docs describe one website assistant without mode qualifications;
- monitoring and alerts identify website Allie and Allie Owl separately.

Until then, **retired as a user-selectable mode** is accurate; **unused** and
**safe to remove** are not.

## Common questions answered

### Do users choose Basic or Advanced now?

No. The website presents one Allie and hard-disables the Advanced mode. The
active code path happens to carry the internal `basic` label.

### Is the active website assistant LangGraph-backed?

Yes. The Copilot runtime is configured with `agentBackend: langgraph` and sends
turns to the loopback Python LangGraph service.

### Does website Allie call the Backend API directly from LangGraph?

No. LangGraph requests typed frontend tools; the logged-in page performs the
actual APICostX operation.

### Is Allie Owl the same process as website Allie?

No. It has its own service, prompt, state, authentication, and tool loop.

### Was Allie Owl copied from unified Allie?

It reused reviewed concepts, schemas, knowledge, and tool vocabulary. Its code
and runtime were independently implemented around an API-key authority model.

### Are the original bots gone?

They are gone as user choices. Their code is only partly gone: the active path
reuses Basic-era frontend structure, Advanced code remains dormant, and a
Built-in runtime rollback remains configured.

### How many active chatbot products exist?

Two: website Allie and the Allie Owl developer API. The CAMEL-AI OWL preset
engine is an execution engine, not a chatbot product.

### Why keep browser tools for website Allie?

They make the logged-in page the authenticated actor and limit the remote agent
to named capabilities. This preserves the design goal that website Allie can do
what the user can do without receiving raw session or database credentials.

### Why use Backend API tools for Allie Owl?

External clients do not have a mounted APICostX browser page. Their existing
API key provides the user identity and permission boundary needed for typed
server-side actions.

## Documentation maintenance rules

Future chatbot documents should begin with:

- document date;
- status: current, plan, historical, or evidence-only;
- product: website Allie, Allie Owl API, legacy Advanced, or OWL engine;
- source of truth and superseding document;
- whether statements describe code, deployment, or proven behavior.

When architecture changes, update this timeline, `langgraph-production.md`,
the Owl implementation status, and the public API-boundary documentation in the
same change. Historical documents should remain available but acquire a clear
superseded banner rather than silently being rewritten as if they were always
current.

## Recent Markdown record and how to read it

### Current architecture and decisions

1. `acm-wordpress-plugin/docs/assistant/one-allie-implementation-plan.md`
   - The clearest statement of the unification decision, target architecture,
     rollout, rollback, and definition of done.
   - Its deletion goals are not all complete because Advanced compatibility
     dependencies and old `basic` naming remain.

2. `acm-copilot-runtime/docs/langgraph-production.md`
   - The best concise description of the active website request path and its
     security boundary.

3. `acm-copilot-runtime/docs/langgraph-acceptance.md`
   - The acceptance record for unified Allie, including provider fixtures,
     typed tools, conversation isolation, and removal of the visible selector.

4. `acm-allie-owl/docs/plan.md`
   - The defining document for the separate Allie Owl API.
   - Correctly says Owl has independent implementation/state and uses APICostX
     API adapters; its phrase “existing advanced chatbot” is stale shorthand
     for the website assistant after One-Allie.

5. `acm-allie-owl/docs/production-deployment.md`
   - Records the separate Owl service deployment on 2026-09-08.
   - “The existing website chatbot service was not restarted or replaced”
     refers to that Owl deployment operation; it does not undo the earlier
     2026-08-31 One-Allie cutover.

6. `acm-allie-owl/docs/implementation-status.md`
   - Current implementation summary for the standalone Owl service.

### Historical migration evidence

7. `acm-wordpress-plugin/docs/assistant/assistant-project-handoff-basic-vs-advanced-2026-06-07.md`
   - A valuable history of the two-mode period.
   - It predates One-Allie and should not be used as current routing truth.

8. `acm-wordpress-plugin/docs/assistant/advanced-chatbot-progress-and-next-steps-2026-06-06.md`
   - Documents the early Advanced MVP while Basic remained separate.
   - Explicitly historical and superseded by the August unification.

9. `acm-wordpress-plugin/docs/assistant/advanced-assistant-website-capability-architecture-2026-06-07.md`
   - Preserves the important website-authority design that survived into
     unified Allie.

10. `acm2/docs/allie-owl-openai-compatible-api-plan.md`
    - The fuller original design for the developer chatbot API and its strict
      separation from website Allie and the Backend API.

## Final correction of the competing narratives

The user's narrative is correct about the product outcome:

- there were two website assistants;
- they were consolidated into one user-facing LangGraph-backed Allie using
  website tools;
- a separate chatbot API was then created using APICostX API tools;
- the two old choices were retired from the visible website.

Three qualifications are necessary:

1. The original bots used different website-tool transports, not identical
   webhooks.
2. Allie Owl is an independent implementation derived from the same product
   concepts, not a byte-for-byte copy with hooks swapped out.
3. The old Basic/Advanced code has not been fully removed: Advanced is hidden
   in the UI but its routes remain required, and the unified path still carries
   the internal name `basic`.

The correct product count remains **two active chatbot products**: one unified
website Allie and one separate Allie Owl developer API. Internally, website
Allie still depends on an Advanced compatibility lane; product identity and
route-level dependency are different questions.
