# Tool Plan: `get_current_preset_models`

Status: planning draft

Purpose:
Return a structured view of the model selections attached to the current or specified preset.

## 1. Tool name

`get_current_preset_models`

## 2. User-facing purpose

Use this tool to answer:

- "What models are selected?"
- "Which engines have models configured?"
- "Are there missing model selections?"

## 3. Category

- read-only page state / lazy frontend fetch

## 4. Boundary level

Reads only from visible draft, cached preset data, or frontend preset APIs. Never mutates.

## 5. Inputs

```json
{
  "preset_id": "optional",
  "use_visible_draft_if_available": true
}
```

## 6. Source of truth

Visible draft first, then cache, then frontend API.

## 7. Output schema

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "models": {
    "selected_models": [
      "anthropic:claude-sonnet-4",
      "openai:gpt-4.1"
    ],
    "by_engine": {
      "aiq": ["anthropic:claude-sonnet-4"],
      "fpf": ["openai:gpt-4.1"]
    },
    "has_any_models": true
  }
}
```

## 8. Semantics

- `selected_models` is the flat quick summary.
- `by_engine` helps the assistant explain engine-specific setup.
- `has_any_models` is a convenience boolean, not a full runnability judgment.

## 9. Allowed LLM interpretation

Allowed:

- explain which models are currently selected
- note that no models are selected if empty

Not allowed:

- infer full runnability from model presence alone

## 10. Failure and unavailable behavior

Standard:

- `unavailable`
- `not_found`
- `error`

## 11. Side effects

Read-only, cache population allowed.

## 12. Security / safety review

Low risk. The main concern is keeping model representation user-meaningful.

## 13. UI / UX expectations

Should let the assistant answer model questions cleanly without dumping the entire preset object.

## 14. Example call

```json
{}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "models": {
    "selected_models": [
      "anthropic:claude-sonnet-4",
      "openai:gpt-4.1"
    ],
    "by_engine": {
      "aiq": ["anthropic:claude-sonnet-4"],
      "fpf": ["openai:gpt-4.1"]
    },
    "has_any_models": true
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

"This preset currently has Claude Sonnet 4 selected for AIQ and GPT-4.1 selected for FPF."

## 18. Relationship to other tools

- `get_current_preset_summary`
- `get_current_preset_requirements`
- `get_current_preset_runnability`

## 19. Open questions

- How should multi-model or per-section model selections be flattened?
- Should model metadata like provider or section tags be exposed in version 1?
