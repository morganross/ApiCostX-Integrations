# Tool Plan: `get_run_status_summary`

Status: planning draft

Purpose:
Give the assistant a compact, structured overview of a run’s current or final state so it can answer:

"What happened with this run?"

This tool should provide the high-level execution status layer before deeper tools inspect logs, outputs, or likely failure causes.

## 1. Tool name

`get_run_status_summary`

## 2. User-facing purpose

This tool exists so the assistant can answer questions like:

- "What is the status of this run?"
- "Did it finish or fail?"
- "Is it still running?"
- "Do outputs exist?"
- "Give me the short version of what happened."

This is a summary tool, not a full forensic log analysis tool.

## 3. Category

Primary category:

- lazy frontend fetch / read-only run inspection

Secondary role:

- explanation support

## 4. Boundary level

This tool should read only from frontend-owned sources:

- current run id from page context
- assistant-local run cache
- frontend run API client

It must not:

- mutate anything
- execute anything
- invent hidden backend tool paths
- silently inspect unrelated runs unless explicitly asked

This tool should use the same run data the frontend itself would use to render a run detail view or execution summary.

## 5. Inputs

Recommended inputs:

```json
{
  "run_id": "optional"
}
```

Interpretation:

- If `run_id` is provided, summarize that run.
- If `run_id` is omitted, summarize the current active run from page context.

Validation rules:

- If neither `run_id` nor `current_run_id` exists, return `unavailable`.
- If the run cannot be found, return `not_found`.

Optional future inputs, not needed in version 1:

- `include_output_presence: boolean`
- `include_stage_summary: boolean`

## 6. Source of truth

Preferred resolution order:

1. Use assistant-local cached run data if already loaded.
2. Otherwise load the run through the normal frontend run API client.
3. Use page context only to determine the default run target if `run_id` is omitted.

This tool should summarize only high-level factual execution state such as:

- current status
- completion state
- timestamps
- whether generated outputs exist
- whether research completed
- whether the run appears failed or incomplete

It should avoid bloating the response with every nested run detail field.

## 7. Output schema

Recommended output shape:

```json
{
  "status": "loaded",
  "run_id": "abc123",
  "summary": {
    "state": "failed",
    "finished": true,
    "research_completed": false,
    "outputs_available": false,
    "generated_document_count": 0,
    "started_at": "2026-06-04T19:01:12Z",
    "updated_at": "2026-06-04T19:03:05Z"
  },
  "notes": [
    "This is a high-level run summary only.",
    "Use log and failure tools for deeper diagnosis."
  ]
}
```

Recommended core fields for version 1:

- `state`
- `finished`
- `research_completed`
- `outputs_available`
- `generated_document_count`
- `started_at`
- `updated_at`

Potential future additions:

- `duration_seconds`
- `cost_summary_available`
- `stage_summary`
- `last_meaningful_event_type`

## 8. Semantics

Important meaning rules:

- `state` should use user-meaningful run states if the frontend already has them.
- `finished: true` means the run is no longer actively progressing.
- `research_completed: true` indicates the research phase completed, not necessarily that every downstream stage succeeded perfectly.
- `outputs_available: true` means the assistant can likely proceed to output inspection.
- `generated_document_count` is informational and should not be treated as quality by itself.

This tool should help the assistant answer:

"Did this run finish, fail, or produce outputs?"

It should not try to answer:

"Why did it fail?" in depth.

That belongs to later failure/log tools.

## 9. Allowed LLM interpretation

The assistant may safely infer:

- whether the run is still active or finished
- whether outputs exist
- whether deeper log inspection is likely needed
- whether the user should next inspect outputs or failures

The assistant should not infer:

- root cause from status alone
- output quality from output count alone
- detailed failure mechanism without deeper evidence

Good explanation:

"This run appears to have finished in a failed state and produced no generated documents. The next useful step is to inspect failure signals or logs."

Bad explanation:

"This failed because the prompt was bad."

## 10. Failure and unavailable behavior

Suggested response classes:

### Success

```json
{
  "status": "loaded",
  ...
}
```

### No active run available

```json
{
  "status": "unavailable",
  "message": "No active run is selected on the current page, and no run_id was provided."
}
```

### Run not found

```json
{
  "status": "not_found",
  "message": "The requested run could not be found."
}
```

### Unexpected error

```json
{
  "status": "error",
  "message": "Run status summary could not be loaded."
}
```

## 11. Side effects

This tool should be read-only.

Acceptable side effects:

- assistant-local cache population for the loaded run

Not acceptable:

- navigation
- retrying execution
- loading giant unrelated datasets by default

## 12. Security / safety review

Why this tool is relatively safe:

- it is read-only
- it uses frontend-owned run access
- it improves explanation without adding mutation power

Potential risks:

- drifting into a huge raw run dump
- leaking more historical detail than the assistant immediately needs
- quietly becoming a failure-diagnosis tool with undocumented heuristics

Mitigations:

- keep version 1 compact
- split deeper diagnosis into separate tools
- prefer explicit output fields over raw nested objects

## 13. UI / UX expectations

Desired user experience:

- The assistant can answer "what happened with this run?" quickly.
- The answer should separate status summary from deeper diagnosis.
- The assistant should know when to suggest checking logs or outputs next.

This tool should be the run-side equivalent of `get_current_preset_summary`.

## 14. Example call

Using current visible run:

```json
{}
```

Using explicit run id:

```json
{
  "run_id": "a6e44c24-61e9-425d-861c-225dcb93eeee"
}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "run_id": "a6e44c24-61e9-425d-861c-225dcb93eeee",
  "summary": {
    "state": "failed",
    "finished": true,
    "research_completed": false,
    "outputs_available": false,
    "generated_document_count": 0,
    "started_at": "2026-06-04T19:01:12Z",
    "updated_at": "2026-06-04T19:03:05Z"
  },
  "notes": [
    "This is a high-level run summary only.",
    "Use dedicated tools to inspect logs, failure signals, or outputs."
  ]
}
```

## 16. Example unavailable result

```json
{
  "status": "unavailable",
  "message": "No active run is selected on the current page, and no run_id was provided."
}
```

## 17. Example explanation behavior

Good explanation:

"This run is finished and appears to have ended in a failed state. Research did not complete, and no generated documents are currently available. The next useful step is to inspect failure signals or logs."

Good follow-up:

"If you want, I can next summarize the first important failure signals from the run."

## 18. Relationship to other tools

This tool should complement, not replace:

- `load_run_for_assistant`
- `load_run_logs_for_assistant`
- `load_run_outputs_for_assistant`
- `get_run_failure_signals`

Think of this one as:

- high-level status layer

Then those others as:

- deeper factual inspection layers

## 19. Open questions

1. What run status vocabulary should be exposed to users directly?
2. Should `research_completed` be surfaced in version 1, or is that too internal?
3. Should duration be calculated here or left out for simplicity?
4. Should output availability be boolean only, or should output types be summarized too?

Current recommendation:

- keep version 1 compact
- include `research_completed` only if it already maps cleanly to how ACM users think about runs
