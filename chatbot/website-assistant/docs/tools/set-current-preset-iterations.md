# Tool Plan: `set_current_preset_iterations`

Status: planning draft

Purpose:
Update a visible preset draft’s iteration-related setting through a narrow, page-owned mutation tool.

## 1. Tool name

`set_current_preset_iterations`

## 2. User-facing purpose

Use this tool to support:

- "Set iterations to 3."
- "Increase the iteration count."

## 3. Category

- visible-page mutation

## 4. Boundary level

Must use the mounted visible page bridge only.

## 5. Inputs

```json
{
  "iterations": 3
}
```

## 6. Source of truth

Visible draft via page bridge.

## 7. Output schema

```json
{
  "status": "updated",
  "iterations": 3
}
```

## 8. Semantics

- draft-only change
- no save
- no execute

## 9. Allowed LLM interpretation

Allowed:

- explain that the visible draft has been updated

Not allowed:

- imply deeper validation passed

## 10. Failure and unavailable behavior

Unavailable if page bridge is absent.

## 11. Side effects

- visible draft mutation only

## 12. Security / safety review

Low risk if the write path stays page-owned and scoped.

## 13. UI / UX expectations

The assistant should mention that the change is still unsaved.

## 14. Example call

```json
{
  "iterations": 3
}
```

## 15. Example success result

```json
{
  "status": "updated",
  "iterations": 3
}
```

## 16. Example unavailable result

```json
{
  "status": "unavailable",
  "message": "No visible preset page draft is mounted."
}
```

## 17. Example explanation behavior

"I set the visible draft’s iterations to 3. It isn’t saved yet."

## 18. Relationship to other tools

- `get_current_preset_summary`
- `save_current_preset`

## 19. Open questions

- Which iteration-like fields matter most across report modes?
