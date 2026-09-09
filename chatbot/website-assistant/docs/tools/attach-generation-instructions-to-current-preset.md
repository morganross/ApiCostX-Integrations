# Tool Plan: `attach_generation_instructions_to_current_preset`

Status: planning draft

Purpose:
Attach a generation-instructions asset to the visible preset draft through a page-owned mutation path.

## 1. Tool name

`attach_generation_instructions_to_current_preset`

## 2. User-facing purpose

Use this tool to support:

- "Attach this generation instructions document."
- "Set the preset’s generation instructions to X."

## 3. Category

- visible-page mutation

## 4. Boundary level

Must act through the mounted page bridge only.

## 5. Inputs

```json
{
  "instruction_id": "gen1"
}
```

## 6. Source of truth

Visible draft via page bridge.

## 7. Output schema

```json
{
  "status": "updated",
  "generation_instructions_id": "gen1"
}
```

## 8. Semantics

- attachment to visible draft only
- no save
- no execute

## 9. Allowed LLM interpretation

Allowed:

- explain the visible draft now references the selected generation instructions

Not allowed:

- claim the content itself is correct or sufficient

## 10. Failure and unavailable behavior

Unavailable if bridge is absent.

## 11. Side effects

- visible draft mutation only

## 12. Security / safety review

Low risk if the instruction asset is selected through existing page-owned controls.

## 13. UI / UX expectations

The assistant should mention that saving is still required.

## 14. Example call

```json
{
  "instruction_id": "gen1"
}
```

## 15. Example success result

```json
{
  "status": "updated",
  "generation_instructions_id": "gen1"
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

"I attached the selected generation instructions to the visible draft. It isn’t saved yet."

## 18. Relationship to other tools

- `get_current_preset_instructions`
- `save_current_preset`
- `get_current_preset_runnability`

## 19. Open questions

- Should detaching instructions be a separate explicit action?
