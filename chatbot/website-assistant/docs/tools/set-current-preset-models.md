# Tool Plan: `set_current_preset_models`

Status: planning draft

Purpose:
Set the visible preset draft’s selected models through an explicit page-owned mutation path.

## 1. Tool name

`set_current_preset_models`

## 2. User-facing purpose

Use this tool to support:

- "Select Claude Sonnet 4."
- "Clear all models."
- "Replace the current model list with these two models."

## 3. Category

- visible-page mutation

## 4. Boundary level

Must act only through the mounted visible preset page bridge.

## 5. Inputs

```json
{
  "models": [
    "anthropic:claude-sonnet-4",
    "openai:gpt-4.1"
  ]
}
```

## 6. Source of truth

Visible preset draft via page bridge.

## 7. Output schema

```json
{
  "status": "updated",
  "selected_models": [
    "anthropic:claude-sonnet-4",
    "openai:gpt-4.1"
  ]
}
```

## 8. Semantics

- draft mutation only
- no save
- no execute

## 9. Allowed LLM interpretation

Allowed:

- explain what models are now selected

Not allowed:

- imply the preset was saved or validated

## 10. Failure and unavailable behavior

Unavailable if page bridge is absent.

## 11. Side effects

- visible draft mutation only

## 12. Security / safety review

Keep narrow and explicit. Avoid hidden raw config mutation outside the bridge.

## 13. UI / UX expectations

The assistant should clearly tell the user the visible draft changed and whether saving is still needed.

## 14. Example call

```json
{
  "models": [
    "anthropic:claude-sonnet-4",
    "openai:gpt-4.1"
  ]
}
```

## 15. Example success result

```json
{
  "status": "updated",
  "selected_models": [
    "anthropic:claude-sonnet-4",
    "openai:gpt-4.1"
  ]
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

"I updated the visible draft to use Claude Sonnet 4 and GPT-4.1. It isn’t saved yet."

## 18. Relationship to other tools

- `get_current_preset_models`
- `save_current_preset`
- `get_current_preset_runnability`

## 19. Open questions

- Should this replace the full list or support add/remove semantics too?
