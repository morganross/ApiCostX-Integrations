# Tool Plan: `get_current_preset_instructions`

Status: planning draft

Purpose:
Return a structured summary of the instruction assets attached to the current or specified preset.

## 1. Tool name

`get_current_preset_instructions`

## 2. User-facing purpose

Use this tool to answer:

- "What instructions are attached to this preset?"
- "Does it have generation instructions?"
- "Does it have eval or combine instructions?"

## 3. Category

- read-only page state / lazy frontend fetch

## 4. Boundary level

Reads only from visible draft, cached preset data, or frontend preset APIs. No mutation.

## 5. Inputs

```json
{
  "preset_id": "optional",
  "use_visible_draft_if_available": true,
  "include_titles": true
}
```

## 6. Source of truth

Visible draft first, then cache, then frontend API.

## 7. Output schema

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "instructions": {
    "generation": {"attached": true, "id": "gen1", "title": "Executive Summary Prompt"},
    "single_eval": {"attached": false},
    "pairwise_eval": {"attached": false},
    "combine": {"attached": true, "id": "comb1", "title": "Combine Policy"}
  }
}
```

## 8. Semantics

- `attached` only means the asset is linked, not that it is semantically good.
- Titles are explanatory helpers if available.

## 9. Allowed LLM interpretation

Allowed:

- explain which instruction categories are attached or missing

Not allowed:

- assume attachment quality or adequacy

## 10. Failure and unavailable behavior

Standard:

- `unavailable`
- `not_found`
- `error`

## 11. Side effects

Read-only, cache fill allowed.

## 12. Security / safety review

Low risk. Main caution is avoiding accidental full content dumps in a summary tool.

## 13. UI / UX expectations

The assistant should be able to clearly say whether instruction assets are attached and name them briefly.

## 14. Example call

```json
{}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "instructions": {
    "generation": {"attached": true, "id": "gen1", "title": "Executive Summary Prompt"},
    "single_eval": {"attached": false},
    "pairwise_eval": {"attached": false},
    "combine": {"attached": true, "id": "comb1", "title": "Combine Policy"}
  }
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

"This preset has generation instructions attached and combine instructions attached, but no single-eval or pairwise-eval instructions attached."

## 18. Relationship to other tools

- `get_current_preset_summary`
- `get_current_preset_requirements`
- `explain_instruction_attachment_state`

## 19. Open questions

- Should this tool ever include preview snippets?
- Should instruction folder/category metadata be included?
