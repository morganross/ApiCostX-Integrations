# Tool Plan: `get_current_preset_runnability`

Status: planning draft

Purpose:
Give the assistant a structured answer to the question:

"Can this preset be run right now, and if not, what is blocking it?"

This tool is meant to separate high-level preset description from preset readiness. It should help the assistant explain current runnability in a deterministic, non-hand-wavy way.

## 1. Tool name

`get_current_preset_runnability`

## 2. User-facing purpose

This tool exists so the assistant can answer questions like:

- "Is this preset runnable?"
- "What’s wrong with this preset?"
- "What do I need to fix before I can execute it?"
- "Is this just a warning, or is something actually blocking execution?"

It should help the assistant distinguish:

- blockers
- warnings
- neutral informational facts

## 3. Category

Primary category:

- read-only page state / deterministic validation

Secondary role:

- explanation support

## 4. Boundary level

This tool should read only from frontend-owned sources:

- visible page context
- visible preset page draft if mounted
- assistant-local preset cache
- frontend API-loaded preset data when needed
- existing frontend validation or readiness logic if such logic already exists in the UI layer

It must not:

- mutate anything
- save anything
- execute anything
- call runtime backend tools
- invent hidden validation rules outside known frontend behavior

This tool should be as close as possible to the same readiness logic the frontend itself uses or should use.

## 5. Inputs

Recommended inputs:

```json
{
  "preset_id": "optional",
  "use_visible_draft_if_available": true
}
```

Interpretation:

- If a visible preset draft is mounted and `use_visible_draft_if_available` is true, evaluate the current visible draft state.
- Otherwise, evaluate the selected or requested saved preset shape.
- If `preset_id` is omitted, use the current active preset from page context.

Validation rules:

- If there is no active preset and no `preset_id`, return `unavailable`.
- If the preset cannot be found, return `not_found`.

## 6. Source of truth

Preferred resolution order:

1. Visible mounted preset draft, if available and allowed by the call.
2. Assistant-local cached preset data.
3. Frontend API-loaded preset data.

Runnability should be computed from deterministic checks such as:

- whether required models are present
- whether required instruction assets are present
- whether required document selections are present
- whether the selected engine/report mode has obvious unmet prerequisites
- whether the visible page/UI already exposes validation failures or readiness hints

This tool should prefer reusing existing UI-side logic if it exists, rather than creating a second competing definition of "runnable."

## 7. Output schema

Recommended output shape:

```json
{
  "status": "evaluated",
  "subject": {
    "preset_id": "474cb303-0125-4398-9caf-a8c8ad749d33",
    "source": "visible_preset_draft"
  },
  "runnable": false,
  "blocking_reasons": [
    "No generation instructions are selected.",
    "No models are selected for the active engine."
  ],
  "warnings": [
    "Document count is low for the selected workflow."
  ],
  "checks": {
    "has_models": false,
    "has_generation_instructions": false,
    "has_documents": true,
    "has_visible_page_bridge": true
  },
  "notes": [
    "Blocking reasons prevent execution.",
    "Warnings do not prevent execution by themselves."
  ]
}
```

Version 1 should keep the schema narrow and human-meaningful.

Recommended core fields:

- `runnable`
- `blocking_reasons`
- `warnings`
- `checks`
- `subject`

The `checks` object should expose a few deterministic facts, not a giant internal dump.

## 8. Semantics

Important meaning rules:

- `runnable: true` means there are no currently known blocking reasons.
- `runnable: false` means at least one blocking reason exists.
- `blocking_reasons` are conditions that should prevent execution.
- `warnings` are cautionary conditions that should not automatically block execution.
- `checks` are low-level factual signals that support the higher-level summary.

This tool must clearly separate:

- "cannot run"
- "can run but may be a bad idea"
- "not enough information to decide"

That distinction is important for trust.

## 9. Allowed LLM interpretation

The assistant may safely infer:

- whether the preset is currently runnable
- which listed reasons are blocking execution
- which listed conditions are warnings only
- what the user would need to change to clear a blocker

The assistant should not infer:

- hidden blockers not surfaced by the tool
- that a warning is a hard failure
- that an attached instruction asset is semantically good just because one exists

Good explanation:

"This preset is not runnable right now because there are no generation instructions selected and no models chosen for the active engine. There is also a warning that the document count is low, but that warning alone would not block execution."

Bad explanation:

"This preset probably won’t work because it seems weak."

## 10. Failure and unavailable behavior

Suggested response classes:

### Success

```json
{
  "status": "evaluated",
  ...
}
```

### No active preset available

```json
{
  "status": "unavailable",
  "message": "No active preset is selected on the current page, and no preset_id was provided."
}
```

### Preset not found

```json
{
  "status": "not_found",
  "message": "The requested preset could not be found."
}
```

### Not enough information to evaluate

```json
{
  "status": "indeterminate",
  "message": "Preset runnability could not be determined from the currently available frontend data.",
  "missing_checks": ["generation_instructions", "selected_models"]
}
```

### Unexpected error

```json
{
  "status": "error",
  "message": "Preset runnability could not be evaluated."
}
```

## 11. Side effects

This tool should be read-only.

Acceptable side effects:

- assistant-local cache population if preset data had to be loaded first

Not acceptable:

- modifying the visible draft
- saving
- executing
- navigating

## 12. Security / safety review

Why this tool is relatively safe:

- it does not broaden backend access
- it is read-only
- it helps the assistant explain readiness without guessing
- it can reduce user frustration before execution attempts

Potential risks:

- duplicating validation logic incorrectly
- creating a second definition of "runnable" that drifts away from the real UI/backend behavior
- overreporting warnings as blockers

Mitigations:

- reuse existing frontend validation helpers where possible
- document each blocking rule
- keep version 1 deterministic and conservative

## 13. UI / UX expectations

Desired user experience:

- The assistant should be able to answer "can I run this?" clearly.
- The assistant should list blockers first, warnings second.
- The user should understand what to fix next.
- The explanation should feel actionable, not like a vague opinion.

This tool should make the assistant feel meaningfully more useful for execution-oriented workflows.

## 14. Example call

Use visible draft if present:

```json
{}
```

Explicit preset:

```json
{
  "preset_id": "474cb303-0125-4398-9caf-a8c8ad749d33",
  "use_visible_draft_if_available": false
}
```

## 15. Example success result

```json
{
  "status": "evaluated",
  "subject": {
    "preset_id": "474cb303-0125-4398-9caf-a8c8ad749d33",
    "source": "visible_preset_draft"
  },
  "runnable": false,
  "blocking_reasons": [
    "No generation instructions are selected.",
    "No models are selected for the active engine."
  ],
  "warnings": [
    "Only one document is attached."
  ],
  "checks": {
    "has_models": false,
    "has_generation_instructions": false,
    "has_documents": true,
    "has_visible_page_bridge": true
  },
  "notes": [
    "Blocking reasons prevent execution.",
    "Warnings do not prevent execution on their own."
  ]
}
```

## 16. Example unavailable result

```json
{
  "status": "unavailable",
  "message": "No active preset is selected on the current page, and no preset_id was provided."
}
```

## 17. Example explanation behavior

Good explanation:

"This preset is not runnable yet. The two blockers are that no generation instructions are selected and no models are selected for the active engine. There is also a warning that the document count is low, but that warning would not block execution by itself."

Good follow-up:

"If you want, I can next summarize the preset itself or help identify which visible fields need to be filled in."

## 18. Relationship to other tools

This tool should complement, not replace:

- `get_current_preset_summary`
- `get_current_preset_models`
- `get_current_preset_instructions`
- `get_available_assistant_actions`

Think of this tool as:

- readiness and blockers

while `get_current_preset_summary` is:

- overall shape and meaning

## 19. Open questions

1. What exact runnability rules already exist in frontend code, and can this tool reuse them directly?
2. Which missing assets should be hard blockers versus warnings across different engine/report modes?
3. Should this tool return only user-facing blocking text, or also machine-oriented blocker codes?
4. Should visible draft state always take priority over saved preset state when available?

Current recommendation:

- prioritize visible draft when mounted
- return user-facing reasons first
- consider blocker codes only if we later need stronger deterministic assistant behavior
