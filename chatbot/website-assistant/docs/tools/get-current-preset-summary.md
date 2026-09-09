# Tool Plan: `get_current_preset_summary`

Status: planning draft

Purpose:
Give the assistant a concise, structured summary of the currently relevant preset so it can explain what the preset is, what major parts are configured, and what kind of work it is set up to do.

This tool is not meant to answer every deep preset question by itself. It is meant to provide the assistant with the first-layer overview a human would want before drilling deeper.

## 1. Tool name

`get_current_preset_summary`

## 2. User-facing purpose

This tool exists so the assistant can answer questions like:

- "What is this preset?"
- "What is this preset configured to do?"
- "Which engines are turned on?"
- "What models or instruction assets are attached?"
- "Give me a quick summary before we edit anything."

This is a summary tool, not a full raw preset dump.

## 3. Category

Primary category:

- read-only page state / lazy frontend fetch

Secondary role:

- explanation support

## 4. Boundary level

This tool should read only from frontend-owned sources:

- visible page context
- assistant-local preset cache
- frontend API client when a preset needs to be loaded

It must not:

- use runtime backend tools
- use hidden server-side ACM powers
- mutate anything
- silently save or execute
- pretend to summarize a preset if no preset is actually selected or loaded

## 5. Inputs

Recommended inputs:

```json
{
  "preset_id": "optional"
}
```

Interpretation:

- If `preset_id` is provided, summarize that preset.
- If `preset_id` is omitted, summarize the current active preset from page context.

Validation rules:

- If neither `preset_id` nor `active_preset_id` exists, return `unavailable`.
- If the preset cannot be found, return `not_found`.

Optional future inputs, not needed in first version:

- `include_raw_sections: boolean`
- `include_document_names: boolean`
- `include_instruction_titles: boolean`

## 6. Source of truth

Preferred resolution order:

1. If requested preset is already in assistant-local cache, use cached preset data.
2. Otherwise, load the preset through the normal frontend preset API client.
3. Use current page context only to determine the default target preset when no `preset_id` is passed.

The summary should be derived from:

- preset metadata
- engine configuration presence / enablement
- selected models
- document references
- instruction references
- other high-level configuration markers

This tool should not rely on the LLM to infer basic preset structure from a giant opaque object.

## 7. Output schema

Recommended output shape:

```json
{
  "status": "loaded",
  "preset_id": "474cb303-0125-4398-9caf-a8c8ad749d33",
  "name": "Tavily Research Preset",
  "description": "Saved from Build Preset page",
  "summary": {
    "report_modes": ["aiq"],
    "enabled_engines": ["aiq"],
    "selected_models": ["openai:gpt-4.1", "anthropic:claude-sonnet-4"],
    "document_count": 3,
    "generation_instructions_attached": true,
    "eval_instructions_attached": false,
    "combine_instructions_attached": false,
    "active_search_provider": "searchbox"
  },
  "notes": [
    "This is a high-level summary only.",
    "Use deeper tools to inspect runnability, blockers, or detailed configuration."
  ]
}
```

The `summary` object should stay intentionally compact.

Good high-level fields for version 1:

- `report_modes`
- `enabled_engines`
- `selected_models`
- `document_count`
- `generation_instructions_attached`
- `eval_instructions_attached`
- `combine_instructions_attached`
- `active_search_provider`

Potential future additions:

- `estimated_complexity`
- `estimated_cost_band`
- `likely_workflow_type`
- `has_history`

## 8. Semantics

Important meaning rules:

- `report_modes` should reflect the major configured mode(s), not every low-level internal flag.
- `enabled_engines` should be presented in user-facing terms as much as possible.
- `selected_models` should be a compact list, not a full raw nested config dump.
- `document_count` is informational only; it is not by itself a readiness signal.
- instruction attachment booleans tell the assistant whether key prompt assets appear connected, not whether they are semantically good.
- `active_search_provider` should describe the main search/retrieval configuration in user-meaningful terms.

This tool should help the assistant answer:

"What kind of preset is this?"

It should not try to answer:

"Can this preset definitely run?" or "Why did this preset fail?"

Those belong to more focused tools.

## 9. Allowed LLM interpretation

The assistant may safely infer:

- the general role or shape of the preset
- which big systems are in play
- whether instructions appear attached at a high level
- whether the preset looks simple or multi-part at a glance

The assistant should not infer:

- that the preset is runnable just because models or documents exist
- that attached instruction assets are correct or sufficient
- that a missing field is definitely the blocker unless another tool says so

Good explanation:

"This preset looks like an AIQ-style research preset with AIQ enabled, multiple selected models, three attached source documents, and generation instructions attached."

Bad explanation:

"This preset is definitely ready to run."

## 10. Failure and unavailable behavior

Suggested response classes:

### Success

```json
{
  "status": "loaded",
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

### Unexpected fetch error

```json
{
  "status": "error",
  "message": "Preset summary could not be loaded."
}
```

## 11. Side effects

This tool should be read-only.

Acceptable side effects:

- assistant-local cache population for the loaded preset

Not acceptable:

- saving
- executing
- mutating visible preset draft
- navigating the user to another page without explicit instruction

## 12. Security / safety review

Why this tool is relatively safe:

- it is read-only
- it uses frontend-owned preset access
- it returns a structured summary instead of raw internal dumps by default
- it improves assistant understanding without adding backend privilege

Potential risks:

- summary fields could accidentally expose more detailed configuration than intended
- future additions might drift into hidden readiness or mutation logic

Mitigations:

- keep version 1 narrow
- separate summary from validation/runnability
- prefer a second focused tool instead of bloating this one

## 13. UI / UX expectations

Desired user experience:

- The assistant should be able to answer "What is this preset?" in one or two coherent paragraphs.
- The response should sound grounded, not vague.
- The assistant should be able to mention engines, models, docs, and instructions without drowning the user in raw JSON.

This tool should make the assistant feel more knowledgeable immediately, even before deeper diagnosis tools exist.

## 14. Example call

Using current visible preset:

```json
{}
```

Using explicit preset id:

```json
{
  "preset_id": "474cb303-0125-4398-9caf-a8c8ad749d33"
}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "preset_id": "474cb303-0125-4398-9caf-a8c8ad749d33",
  "name": "Tavily Research Preset",
  "description": "Saved from Build Preset page",
  "summary": {
    "report_modes": ["aiq"],
    "enabled_engines": ["aiq"],
    "selected_models": ["anthropic:claude-sonnet-4"],
    "document_count": 3,
    "generation_instructions_attached": true,
    "eval_instructions_attached": false,
    "combine_instructions_attached": false,
    "active_search_provider": "searchbox"
  },
  "notes": [
    "This summary is high-level only.",
    "Use dedicated tools for runnability, blockers, or detailed per-section configuration."
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

"This preset looks like an AIQ-oriented research preset. AIQ is the main enabled engine, it currently has one selected model, three attached source documents, and generation instructions attached. I can inspect readiness separately if you want to know whether it is actually runnable."

Good follow-up:

"If you want, I can next check whether anything is missing that would prevent it from running."

## 18. Relationship to other tools

This tool should work alongside, not replace:

- `get_current_preset_runnability`
- `get_current_preset_requirements`
- `get_current_preset_models`
- `get_current_preset_instructions`

Think of this one as:

- broad summary first

Then those others as:

- focused follow-up inspection

## 19. Open questions

1. What is the best compact representation for "report mode" versus "enabled engine" in ACM terms?
2. Should model names be capped to avoid giant summaries?
3. Should document names be included, or only counts, in version 1?
4. Should instruction fields be booleans only, or include content titles when available?

Current recommendation:

- keep version 1 compact
- use booleans and counts first
- add names/titles only when they materially help explanation
