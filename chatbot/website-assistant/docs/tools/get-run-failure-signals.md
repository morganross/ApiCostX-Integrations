# Tool Plan: `get_run_failure_signals`

Status: planning draft

Purpose:
Give the assistant a structured set of the most important failure-related facts for a run without making the assistant parse an entire raw log stream every time.

This tool is meant to support:

- "Why did this run fail?"
- "What are the first important failure clues?"
- "What should I inspect next?"

It should not try to be a full autonomous root-cause engine. It should surface the strongest machine-readable failure signals available from frontend-accessible run/log data.

## 1. Tool name

`get_run_failure_signals`

## 2. User-facing purpose

This tool exists so the assistant can answer questions like:

- "What are the main failure signals?"
- "What does the run seem blocked on?"
- "Is there a first clear error?"
- "Is this a preset problem, a runtime problem, or just unclear from the current evidence?"

This is the assistant’s first structured diagnostic layer, not the final answer to every debugging question.

## 3. Category

Primary category:

- lazy frontend fetch / read-only diagnostic summary

Secondary role:

- explanation support

## 4. Boundary level

This tool should read only from frontend-owned sources:

- cached run data
- cached run logs if already present
- frontend run/log API client if needed

It must not:

- mutate anything
- retry anything
- call hidden runtime backend tools
- pull unrelated runs or unrelated giant history sets by default

This tool should stay within the page-agent model even though it is more diagnostic than a simple summary tool.

## 5. Inputs

Recommended inputs:

```json
{
  "run_id": "optional",
  "classification": "event"
}
```

Interpretation:

- If `run_id` is provided, inspect that run.
- If `run_id` is omitted, inspect the current active run from page context.
- `classification` defaults to `event` because that is likely the least noisy first layer.

Optional future inputs:

- `max_signals`
- `include_raw_examples`
- `classification: "event" | "all"`

Validation rules:

- If no run can be resolved, return `unavailable`.
- If the run cannot be found, return `not_found`.

## 6. Source of truth

Preferred resolution order:

1. Use assistant-local cached run and logs if already available.
2. Otherwise load the run through frontend run APIs.
3. Load frontend-accessible logs for the target run, ideally starting with `event`.

Failure signals should be based on deterministic or near-deterministic evidence such as:

- explicit error events
- terminal failed state
- missing outputs at end state
- missing prerequisite indicators exposed in run or log data
- repeated warning/error patterns

This tool should avoid pretending to know more than the available run/log signals actually support.

## 7. Output schema

Recommended output shape:

```json
{
  "status": "loaded",
  "run_id": "abc123",
  "signals": {
    "severity": "high",
    "top_errors": [
      "No generation instructions were available for the run.",
      "Execution terminated before generated documents were produced."
    ],
    "warnings": [
      "Research phase did not complete."
    ],
    "evidence": [
      {
        "kind": "run_state",
        "message": "Run finished in failed state."
      },
      {
        "kind": "log_event",
        "message": "Generation instructions missing."
      }
    ]
  },
  "next_steps": [
    "Inspect the preset's instruction attachments.",
    "Review run logs in more detail if the preset looks correct."
  ]
}
```

Recommended core fields:

- `severity`
- `top_errors`
- `warnings`
- `evidence`
- `next_steps`

This tool should not dump the full raw log unless explicitly requested by a different tool.

## 8. Semantics

Important meaning rules:

- `top_errors` are the strongest failure-related signals found.
- `warnings` are notable but less conclusive signals.
- `evidence` provides the factual basis for the summary.
- `severity` is a compact synthesis of how serious and confidence-worthy the detected failure picture is.
- `next_steps` should be practical and bounded.

This tool should help the assistant answer:

"What are the clearest failure clues we have right now?"

It should not overclaim:

- root cause certainty
- hidden infrastructure failures
- backend-internal truth the frontend cannot see

## 9. Allowed LLM interpretation

The assistant may safely infer:

- which failure clues appear strongest
- whether the evidence points more toward config issues versus generic execution failure
- whether deeper log reading is warranted

The assistant should not infer:

- a certain root cause when evidence is weak
- that an error event is the only cause
- invisible infrastructure states not represented in run or log data

Good explanation:

"The strongest visible failure signal is that the run ended failed without generated documents, and the clearest specific clue in the available evidence is that generation instructions appear to have been missing."

Bad explanation:

"The backend worker crashed because memory was exhausted," unless the available evidence actually says that.

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

### No failure signals found

```json
{
  "status": "loaded",
  "run_id": "abc123",
  "signals": {
    "severity": "low",
    "top_errors": [],
    "warnings": [],
    "evidence": []
  },
  "next_steps": [
    "Review full logs or outputs for more context."
  ]
}
```

### Unexpected error

```json
{
  "status": "error",
  "message": "Run failure signals could not be loaded."
}
```

## 11. Side effects

This tool should be read-only.

Acceptable side effects:

- assistant-local cache population for run data and logs

Not acceptable:

- navigation
- retrying run execution
- modifying preset state

## 12. Security / safety review

Why this tool is moderately safe:

- still read-only
- stays within frontend-owned run/log access
- reduces the need for the LLM to parse large raw log blobs directly

Potential risks:

- turning a weak hint into an overconfident failure summary
- exposing too much raw log material by default
- drifting into a second hidden diagnostic system disconnected from the UI

Mitigations:

- return evidence alongside summary
- keep summary deterministic where possible
- separate "signal extraction" from "raw log access"

## 13. UI / UX expectations

Desired user experience:

- The assistant can give a short, useful answer to "what went wrong?"
- The answer should mention evidence, not just vibes.
- The assistant should know when to say the evidence is thin.
- The assistant should point the user to the next sensible inspection step.

## 14. Example call

Using current visible run:

```json
{}
```

Using explicit run id:

```json
{
  "run_id": "a6e44c24-61e9-425d-861c-225dcb93eeee",
  "classification": "event"
}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "run_id": "a6e44c24-61e9-425d-861c-225dcb93eeee",
  "signals": {
    "severity": "high",
    "top_errors": [
      "Run ended in failed state.",
      "No generated documents were produced."
    ],
    "warnings": [
      "Research phase did not complete."
    ],
    "evidence": [
      {
        "kind": "run_state",
        "message": "Run finished as failed."
      },
      {
        "kind": "output_summary",
        "message": "Generated document count is zero."
      }
    ]
  },
  "next_steps": [
    "Inspect detailed logs for the first explicit error event.",
    "Check preset runnability if the run appears to have failed before useful work began."
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

"The clearest visible failure signals are that the run ended failed, produced no generated documents, and did not complete research. That doesn’t yet prove the exact root cause, but it strongly suggests we should inspect the first explicit error events in the logs next."

Good follow-up:

"If you want, I can next pull a deeper log summary or check whether the preset itself had obvious blockers."

## 18. Relationship to other tools

This tool should complement, not replace:

- `get_run_status_summary`
- `load_run_logs_for_assistant`
- `load_run_outputs_for_assistant`
- `get_current_preset_runnability`

Think of this one as:

- first diagnostic signal layer

while `get_run_status_summary` is:

- broad state summary

## 19. Open questions

1. What evidence types are stable enough to expose in version 1?
2. Should `severity` be an enum or omitted until we have more confidence?
3. Should this tool rely only on event logs first, with full logs handled separately?
4. How much of `next_steps` should be code-generated versus left to the LLM?

Current recommendation:

- keep version 1 conservative
- use event logs first
- include evidence explicitly
- avoid overconfident severity logic until the signal extraction rules are well understood
