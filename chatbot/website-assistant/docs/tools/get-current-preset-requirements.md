# Tool Plan: `get_current_preset_requirements`

Status: planning draft

Purpose:
Return the explicit requirement checklist for the current or specified preset so the assistant can explain what classes of inputs or assets are expected, present, or missing.

## 1. Tool name

`get_current_preset_requirements`

## 2. User-facing purpose

Use this tool to answer:

- "What does this preset need?"
- "Which requirements are satisfied already?"
- "What categories of setup are still missing?"

## 3. Category

- read-only page state / deterministic requirement summary

## 4. Boundary level

Reads only from:

- visible preset draft if mounted
- cached preset data
- frontend preset APIs

Must not:

- mutate
- save
- execute
- use hidden runtime backend powers

## 5. Inputs

```json
{
  "preset_id": "optional",
  "use_visible_draft_if_available": true
}
```

## 6. Source of truth

Use visible draft first when mounted, otherwise cached or frontend-loaded preset data.

## 7. Output schema

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "requirements": {
    "models_required": true,
    "models_present": false,
    "documents_required": true,
    "documents_present": true,
    "generation_instructions_required": true,
    "generation_instructions_present": false,
    "eval_instructions_required": false,
    "eval_instructions_present": false
  },
  "missing_requirement_categories": [
    "models",
    "generation_instructions"
  ]
}
```

## 8. Semantics

- `required` means the preset configuration or mode implies the category is needed.
- `present` means the category is currently attached or selected.
- `missing_requirement_categories` is the fast path for the LLM.

## 9. Allowed LLM interpretation

Allowed:

- "This preset is missing models and generation instructions."

Not allowed:

- inventing deeper blockers not represented here

## 10. Failure and unavailable behavior

- `unavailable` if no active or specified preset exists
- `not_found` if requested preset is missing
- `error` only for unexpected failure

## 11. Side effects

- read-only
- cache fill allowed

## 12. Security / safety review

Safe because it is read-only and narrow. Risk is mostly drift between requirement logic and real frontend behavior.

## 13. UI / UX expectations

This should make the assistant sound concrete and checklist-oriented rather than vague.

## 14. Example call

```json
{}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "requirements": {
    "models_required": true,
    "models_present": false,
    "documents_required": true,
    "documents_present": true,
    "generation_instructions_required": true,
    "generation_instructions_present": false,
    "eval_instructions_required": false,
    "eval_instructions_present": false
  },
  "missing_requirement_categories": [
    "models",
    "generation_instructions"
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

"This preset currently needs models and generation instructions. Documents are already present."

## 18. Relationship to other tools

Pairs well with:

- `get_current_preset_summary`
- `get_current_preset_runnability`

## 19. Open questions

- Which requirement categories are universal versus engine-specific?
- Should required/present booleans also include explanatory notes?
