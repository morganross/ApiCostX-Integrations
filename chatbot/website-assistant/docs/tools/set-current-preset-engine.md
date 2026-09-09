# Tool Plan: `set_current_preset_engine`

Status: planning draft

Purpose:
Set or toggle a specific engine in the visible preset draft through the mounted preset page bridge.

## 1. Tool name

`set_current_preset_engine`

## 2. User-facing purpose

Use this tool to answer or act on:

- "Enable AIQ for this preset."
- "Disable GPTR."
- "Switch this preset to use DR."

## 3. Category

- visible-page mutation

## 4. Boundary level

Must use:

- mounted preset page bridge only

Must not:

- mutate saved preset state outside visible page flow
- use alternate hidden mutation paths

## 5. Inputs

```json
{
  "engine": "aiq",
  "enabled": true
}
```

## 6. Source of truth

Visible preset draft through the mounted page bridge.

## 7. Output schema

```json
{
  "status": "updated",
  "engine": "aiq",
  "enabled": true
}
```

## 8. Semantics

- updates only the visible draft
- does not save automatically
- does not execute automatically

## 9. Allowed LLM interpretation

Allowed:

- "I enabled AIQ in the current draft."

Not allowed:

- "The preset is saved now."

## 10. Failure and unavailable behavior

If page bridge is absent:

```json
{
  "status": "unavailable",
  "message": "No visible preset page draft is mounted."
}
```

## 11. Side effects

- mutates visible draft only

## 12. Security / safety review

Safe only if it remains page-bridge-only.

## 13. UI / UX expectations

The assistant should say the draft changed, and if needed suggest saving next.

## 14. Example call

```json
{
  "engine": "aiq",
  "enabled": true
}
```

## 15. Example success result

```json
{
  "status": "updated",
  "engine": "aiq",
  "enabled": true
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

"I enabled AIQ in the visible draft. It isn’t saved yet."

## 18. Relationship to other tools

- `get_available_assistant_actions`
- `get_current_preset_draft`
- `save_current_preset`

## 19. Open questions

- Which engine identifiers should be first-class supported?
- Should engine toggles be split further by report family?
