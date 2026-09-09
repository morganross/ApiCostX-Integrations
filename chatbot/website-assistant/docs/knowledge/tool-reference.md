# ACM Assistant Tool Reference

Status: authoritative v1

Purpose:
Teach Assistant what each frontend tool does, when to use it, and how to interpret its output.

## General Rules

All tools in this reference are browser-side frontend tools unless a future version says otherwise.

Read tools can inspect current page state, local assistant cache, or frontend-accessible ACM data. Mutation tools must use the visible page bridge and should report unavailable when that bridge is not present.

Do not assume a tool has backend powers beyond what the website frontend already has.

## Orientation Tools

### `get_assistant_knowledge_manifest`

Use this when the user asks what knowledge Assistant was given, what docs are loaded, or how Assistant knows ACM concepts.

Output includes knowledge pack version, document ids, source paths, character counts, always-injected channels, on-demand channels, and declared frontend tool metadata.

Safe interpretation:
Assistant may say compact core guidance and a topic index are injected through the system message while detailed feature docs are loaded on demand. Treat declared frontend tools as the frontend's tool manifest, not proof of the runtime's final registry.

Unsafe interpretation:
Do not claim runtime-side prompt loading is proven unless the manifest explicitly says so.

### `read_knowledge_topic`

Use this when the user asks for detailed information about one APICostX feature, engine, preset workflow, website tool, diagnostic process, or current project status.

Input is an allowlisted topic id from the knowledge manifest plus an optional character limit. The tool returns one bounded Markdown document and its source path; it cannot read arbitrary files, paths, URLs, or user content.

Safe interpretation:
Treat the returned document as product guidance, then prefer current page state and live tool results for changing facts. If the topic is missing or unavailable, say so plainly.

The `engine-strategy` topic contains provisional starting heuristics, not measured quality rankings or backend guarantees.

### `get_available_assistant_actions`

Use this before deciding what Assistant can do from the current frontend state.

Output includes page context, app-wide assistant cache summary, whether the preset draft bridge is mounted, available actions, suggested next steps, and knowledge status.

Safe interpretation:
If an action is unavailable, explain the reason from the tool. If save or execute is unavailable because the visible preset page bridge is missing, do not suggest an alternate mutation path.

### `get_visible_page_state`

Use this for quick orientation. It returns current page context, cache summary, and bridge availability.

Safe interpretation:
This tells Assistant what is visible or cached. It does not load new preset or run data.

### `get_current_route_context`

Use this when only route, page, active preset id, or current run id is needed.

Safe interpretation:
Route context identifies what the page points at. It is not a detailed preset or run summary.

### `navigate_to_app_route`

Changes the visible ACM React hash route for known app routes such as `/flow-lab`, `/execute`, `/history`, `/content`, `/settings`, `/presets/{presetId}`, and `/execute/{runId}`.

Safe interpretation:
Use this when the user asks Assistant to open or go to a different ACM page. Navigation is a visible browser action, not backend access. App-wide read tools can still inspect runs and presets without navigation, so do not navigate just to read latest-run data.

Unsafe interpretation:
Do not claim this tool can open arbitrary external URLs. Do not use it to bypass visible-page bridge rules for draft mutations. Navigating away can unmount page-local unsaved draft state.

### `refresh_current_page_data`

Use this to refresh assistant-local data for the current active preset or run. It should not bulk preload unrelated data.

Safe interpretation:
After success, cached data for the current page is fresher and recent/latest run context may also be refreshed. Lack of a visible run route is not a reason to avoid app-wide run reads.

## Internet Search Tool

### `internet_search`

Runtime-side server tool that searches the public internet through the authenticated assistant runtime and returns a concise answer with source URLs.

Use this when the user asks for current public information, external facts, documentation, release/news context, pricing or availability, or other information that is not in ACM page state.

Safe interpretation:
The returned `answer` is provider-generated from public web results. The returned `sources` are the URLs Assistant should cite when answering. Use it as external context only. This is not a browser-side frontend tool and should not appear in the frontend-declared tool metadata list.

Unsafe interpretation:
Do not use this tool for private ACM account facts, presets, runs, logs, outputs, provider keys, tokens, plugin secrets, cross-user data, or backend/server state. For ACM product facts, use ACM page tools.

## Content Library Tools

`get_content_library_summary` and `search_content_library_for_assistant` return bounded user-scoped metadata and previews. `load_content_for_assistant` loads one bounded body excerpt by id or name.

`create_content_for_assistant`, `update_content_for_assistant`, and `duplicate_content_for_assistant` use the normal logged-in website API client and reload the resulting record for verification. `delete_content_for_assistant` requires an explicit user deletion request and an exact `confirm_name` match; run logs remain read-only.

Evaluation-criteria bodies have a strict YAML contract: a top-level `criteria` list whose items each contain a non-empty `name` and `description`. If the website rejects malformed criteria, use the returned parser error to correct the body and retry; never claim the rejected record was created.

These records are Content Library database objects referenced by id, even when their source was an uploaded file or GitHub import. Do not describe these tools as filesystem or backend access.

`list_github_connections_for_assistant`, `browse_github_connection_for_assistant`, and `import_github_file_to_content_library` expose the Content Library's saved-connection import workflow without returning GitHub credentials. Import only a file path returned by the browse tool and reload the resulting Content Library record before claiming success.

Direct local-file upload is a visible Content Library workflow but is not currently exposed as an Assistant tool because chat has no user-file transfer contract. Do not claim to have uploaded a local file; the user must use the upload control until explicit chat attachment plumbing is added.

## Preset Read Tools

### `get_loaded_preset_list`

Returns only the preset list already loaded in this assistant session.

Safe interpretation:
`loaded: false` or an empty list means the assistant cache does not already contain a preset list. It does not mean the user has no presets.

### `load_preset_for_assistant`

Reads and caches canonical preset data without navigating or selecting the visible preset draft.

### `select_preset_and_wait_until_hydrated`

Selects a saved preset in the visible page and waits until route state and the page-owned draft report the same preset id. Use this before visible-draft runnability, mutation, save, or execution tools.

Loads one preset by id or name query through the frontend API client.

Safe interpretation:
Use this when the user names a preset or provides an id. If a name query matches, the returned preset is frontend-accessible to the current user.

### `get_current_preset_summary`

Returns compact saved-preset summary fields: report modes, enabled engines, selected models, document count, instruction attachment booleans, and active search provider.

Safe interpretation:
This can explain what kind of preset it is. It cannot prove the preset is runnable or that instructions are semantically good.

### `get_current_preset_runnability`

Evaluates whether the current visible draft or saved preset can run and why.

Important fields:

- `runnable`: whether known checks permit execution
- `blocking_reasons`: issues that prevent running
- `warnings`: issues that may matter but do not necessarily block
- `checks`: booleans used in the evaluation

Safe interpretation:
If `blocking_reasons` is non-empty, say the preset cannot currently run and cite the blockers. If only warnings exist and `runnable` is true, say it appears runnable but has cautions.

### `get_current_preset_requirements`

Returns which required pieces are present or missing for the current preset or visible draft.

Safe interpretation:
Use it to explain missing models, documents, generation instructions, or eval instructions.

### `get_current_preset_models`

Returns selected generation/eval/combine models for the current preset or visible draft.

Safe interpretation:
Use it for model selection questions. Do not infer quality or cost unless a tool result includes that information.

### `get_current_preset_documents`

Returns selected document/input state for the current preset or visible draft.

Safe interpretation:
Use it to explain what source materials appear attached. Attachment does not prove content relevance.

### `get_current_preset_instructions`

Returns selected instruction attachment state for generation, eval, pairwise eval, and combine instructions.

Safe interpretation:
Use it to explain what instruction assets are attached. Attachment does not prove the instructions are well written.

### `get_current_preset_draft`

Returns the visible preset page draft only when the preset page bridge is mounted.

Safe interpretation:
The draft may include unsaved edits. Treat it as current visible page state.

Unsafe interpretation:
Do not assume the draft has been saved.

## Preset Edit Tools

### `attach_generation_instructions_to_current_preset`

Sets the visible draft generation instruction id through the page bridge.

Safe interpretation:
The visible draft changed. It is not saved unless `save_current_preset` succeeds.

### `attach_eval_instructions_to_current_preset`

Sets visible draft single-eval instructions, pairwise-eval instructions, or evaluation-criteria id through the page bridge.

Safe interpretation:
The visible draft changed. It is not saved unless `save_current_preset` succeeds.

### `attach_combine_instructions_to_current_preset`

Sets the visible draft Combine instruction id through the page bridge. The change remains unsaved until `save_current_preset` succeeds.

### `set_current_preset_engine`

Enables or disables one engine section through the page bridge.

Safe interpretation:
This changes visible draft engine state. Disabling an engine may clear selected models for that engine when the tool result says so.

### `set_current_preset_iterations`

Sets visible draft iteration count through the page bridge.

Safe interpretation:
This is a draft edit until saved.

### `set_current_preset_search_provider`

Sets visible draft search provider fields for supported engine sections.

Safe interpretation:
This changes execution configuration for the visible draft. It does not make Assistant itself browse the internet.

### `set_current_preset_engine_models`

Replaces visible draft generation-model selections for exactly one named engine using the page-owned model compatibility map.

Safe interpretation:
The returned `selected_models` list is what the tool attempted to apply to the visible draft.

### `create_new_preset`

Starts a clean `-- New --` draft and sets its validated string name and optional description. It must not modify the previously loaded preset.

### `set_current_preset_name`

Sets the current visible draft name using a validated string.

### `list_available_generation_models`

Lists the model ids loaded by the preset page and the generation engines each model supports.

### `select_current_preset_input_documents`

Replaces the current visible draft document selection using validated document ids.

### `save_current_preset`

Saves the visible current preset through the page save handler.

Safe interpretation:
Only available when the visible preset page bridge is mounted. If it returns unavailable, do not suggest a hidden save route.

### `execute_current_preset`

Starts execution through the visible preset page workflow.

Safe interpretation:
Only available when the visible preset page bridge is mounted. A `started` result means execution was initiated by the page workflow, not that the run completed.

## Run And Output Tools

### `get_loaded_history_rows`

Returns only run history rows already loaded in assistant-local cache.

Safe interpretation:
Empty cache does not mean the user has no run history.

### `get_recent_runs_for_assistant`

Loads recent runs through the frontend API without navigation.

Safe interpretation:
Use this when the user asks about recent executions, history, "the last run", or when no visible route run id exists. The first returned item is treated as the latest run because the app's Execute page also resolves latest with `/runs?limit=1`.

### `get_latest_run_context`

Returns app-wide context for the latest run, including status summary and optional failure/output summaries.

Safe interpretation:
Use this first when the user asks "what happened on the run" and no explicit run id is visible or provided. This tool is intentionally not limited to the current route.

### `load_run_for_assistant`

Loads one run by id through the frontend API client. If no id is provided, it resolves the latest app-wide run.

Safe interpretation:
Use it when the user provides a run id, page context identifies a run id, or the likely target is the latest run.

### `get_run_status_summary`

Returns compact run state: status, finished flag, research completion, output availability, generated document count, and timestamps.

Safe interpretation:
Use it for "what happened" at a high level. Use failure and output tools for deeper explanation.

### `get_run_failure_signals`

Builds visible failure clues from run status, run error message, generated document count, research completion, and logs.

Safe interpretation:
Use `signals.severity`, `top_errors`, `warnings`, `evidence`, and `next_steps` to explain likely issues. Label conclusions as based on visible signals.

For terminal runs with zero visible generated documents, this tool may also return `artifact_evidence_from_logs` and `output_visibility_contradiction.detected: true`. When present, treat it as a real anomaly even if `signals.severity` is otherwise low.

Unsafe interpretation:
Do not claim a complete root cause if evidence is sparse.

### `get_run_output_summary`

Returns a compact summary of outputs produced by a run, optionally with document titles.

Safe interpretation:
Use it to explain whether outputs exist and how many. Do not judge content quality unless content was loaded and inspected.

If the run is finished and the output API returns zero visible generated documents, this tool may also return:

- `artifact_evidence_from_logs`: bounded evidence extracted from user-visible run logs, such as generated-save events and eval-save events.
- `output_visibility_contradiction.detected: true`: logs indicate generated artifacts were saved, but the output API still returned no visible generated documents.

When that contradiction is present, explain it as "completed with no visible outputs" or "outputs not visible through the output API" rather than saying the run simply produced no work.

If a run is still running, saved-artifact log evidence plus zero visible outputs is not yet an output visibility contradiction. Explain it as in-progress artifact evidence and re-check outputs after the run reaches a terminal state.

Unsafe interpretation:
Do not invent backend table names, SQL, queue names, service names, or storage internals while explaining the contradiction.

### `load_run_logs_for_assistant`

Loads user-visible logs for one run with bounded classification and limit.

Safe interpretation:
Logs are evidence. Empty logs are sparse evidence, not proof of no error.

Assistant-facing log samples redact volatile internal `task_id`, `job`, and `worker` identifier values. This is intentional and does not mean the log entry was unavailable. Prefer citing event types, timestamps, levels, sources, doc ids, models, and summarized evidence rather than repeating internal queue identifiers.

If the payload includes `queue_or_worker_samples`, use that field first for user questions about queues, workers, tasks, jobs, or queue health. Do not choose a generic run-start line from `sampled_entries` when a more specific queue/worker sample is available.

### `watch_run_logs_for_assistant`

Consumes the same user-scoped verbose log feed used by the Execute page in ordered cursor chunks. It always requests both lifecycle `EVENT` and verbose `DETAIL` records, includes bounded message/payload content, caps each returned chunk near 8,000 serialized characters, and may long-poll for up to 30 seconds while an active run waits for new entries.

Start with `after_offset: 0`. Repeat using the returned `next_call` until `has_more` is false; `returned_entries` may be smaller than `requested_max_entries` when `stopped_for_char_budget` is true, but `next_offset` still advances without skipping entries. For an active run, keep repeating the returned call to receive later entries. `status: no_delta` means no new records arrived during that bounded call, not that logging is permanently stopped.

This is website polling, not a pushed model stream. Describe it as near-real-time log watching only when repeated calls show increasing offsets, counts, or timestamps. Do not skip offsets, restart at zero on every turn, or claim an unseen entry.

`status: not_found` with zero returned entries is the normal safe result when the requested run does not exist or is outside the logged-in user's scope. Explain the boundary without retrying through another account or backend path.

### `load_run_outputs_for_assistant`

Loads generated output document content for one run, bounded by `max_documents`.

Safe interpretation:
Use it when the user asks to inspect output contents. Respect the bounded document count; `max_documents` must be between 1 and 10.

If the tool returns `status: "bounded"`, explain that the requested `max_documents` was outside the allowed range. Cite `requested_max_documents`, `effective_max_documents`, and `max_documents_limit`; do not describe the request as accepted at the original oversized value.

## Tool Selection Heuristics

For "What can you do?":
Use `get_assistant_knowledge_manifest` and `get_available_assistant_actions`.

For "What is this preset?":
Use `get_current_preset_summary`, then deeper preset tools if needed.

For "Can this run?":
Use `get_current_preset_runnability`.

For "What is missing?":
Use `get_current_preset_requirements`.

For "Why did this fail?":
Use `get_latest_run_context` if no run id is specified, then `get_run_status_summary`, then `get_run_failure_signals`, then logs if needed.

For "Watch or debug this run live":
Use `watch_run_logs_for_assistant` with the returned `next_call` repeatedly, and reconcile each delta with `get_run_status_summary` and `get_run_failure_signals`.

For "Where are the outputs?":
Use `get_latest_run_context` if no run id is specified, then `get_run_output_summary`, then `load_run_outputs_for_assistant` if content is needed.

For "Please change this preset":
Check availability, use a specific visible-draft mutation tool, then explain that it is a draft change unless saved.
