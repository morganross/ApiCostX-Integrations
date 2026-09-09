# Tool Plan: `attach_eval_instructions_to_current_preset`

Status: planning draft

Purpose:
Attach one or more evaluation instruction assets to the visible preset draft through a page-owned mutation path.

## 1. Tool name

`attach_eval_instructions_to_current_preset`

## 2. User-facing purpose

Use this tool to support:

- "Attach single-eval instructions."
- "Attach pairwise-eval instructions."

## 3. Category

- visible-page mutation

## 4. Boundary level

Must act only through the mounted visible page bridge.

## 5. Inputs

```json
{
  "kind": "single_eval",
  "instruction_id": "eval1"
}
```

Allowed `kind` values in version 1:

- `single_eval`
- `pairwise_eval`

## 6. Source of truth

Visible draft via page bridge.

## 7. Output schema

```json
{
  "status": "updated",
  "kind": "single_eval",
  "instruction_id": "eval1"
}
```

## 8. Semantics

- updates visible draft only
- no save
- no execute

## 9. Allowed LLM interpretation

Allowed:

- explain which eval instruction category was attached

Not allowed:

- claim the evaluation setup is fully correct without further checks

## 10. Failure and unavailable behavior

Unavailable if bridge is absent.

## 11. Side effects

- visible draft mutation only

## 12. Security / safety review

Low risk if it stays a page-owned attachment operation.

## 13. UI / UX expectations

The assistant should make the category explicit so the user knows what changed.

## 14. Example call

```json
{
  "kind": "single_eval",
  "instruction_id": "eval1"
}
```

## 15. Example success result

```json
{
  "status": "updated",
  "kind": "single_eval",
  "instruction_id": "eval1"
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

"I attached the selected single-eval instructions to the visible draft. It isn’t saved yet."

## 18. Relationship to other tools

- `get_current_preset_instructions`
- `save_current_preset`

## 19. Open questions

- Should single-eval and pairwise-eval be split into separate tools?
