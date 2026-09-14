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

The old Advanced assistant is retired from the user experience. Its frontend,
backend REST-thread, LangGraph, and website-bridge code still exists, and the
backend endpoint is still configured. The live frontend explicitly sets
`advancedModeAvailable = false`, so users cannot select that path. It is
dormant legacy/rollback code, not a second active product.

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

### Dormant or rollback code

1. The old Advanced frontend mode, bridge, REST client, backend thread service,
   and backend graph remain in source.
2. The current frontend hard-disables Advanced with
   `advancedModeAvailable = false`.
3. The old Built-in Copilot runtime remains a configuration rollback from the
   active LangGraph backend.
4. Historical `basic` names remain around the active unified website path.

### What is retired versus removed

| Component | User-facing status | Code status |
|---|---|---|
| Original Basic assistant behavior | Replaced by unified LangGraph Allie | Frontend shell/names reused; Built-in backend retained as rollback |
| Separate Advanced assistant | Retired and unavailable in current UI | Frontend/backend code and endpoint remain |
| Unified website Allie | Active | Current production path |
| Allie Owl API | Active separate product | Independent service and state |

## Recent Markdown record and how to read it

### Current architecture and decisions

1. `acm-wordpress-plugin/docs/assistant/one-allie-implementation-plan.md`
   - The clearest statement of the unification decision, target architecture,
     rollout, rollback, and definition of done.
   - Its deletion goals are not all complete because dormant Advanced code and
     old `basic` naming remain.

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
3. The old Basic/Advanced code has not been fully removed: Advanced is disabled
   in the UI, and the unified path still carries the internal name `basic`.

The assistant's earlier conclusion that two old chatbots were still active was
wrong because it inferred runtime activation from dormant source files. The
correct current count is **two active chatbot products**: one unified website
Allie and one separate Allie Owl developer API.
