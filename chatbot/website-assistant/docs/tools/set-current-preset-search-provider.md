# Tool Plan: `set_current_preset_search_provider`

Status: planning draft

Purpose:
Set the visible preset draft’s search or retrieval provider through a page-owned mutation path.

## 1. Tool name

`set_current_preset_search_provider`

## 2. User-facing purpose

Use this tool to support:

- "Switch this preset to Searchbox."
- "Use ChatGPT web search."
- "Change the current retrieval provider."

## 3. Category

- visible-page mutation

## 4. Boundary level

Must use the mounted page bridge only.

## 5. Inputs

```json
{
  "provider": "searchbox"
}
```

## 6. Source of truth

Visible draft via page bridge.

## 7. Output schema

```json
{
  "status": "updated",
  "provider": "searchbox"
}
```

## 8. Semantics

- updates visible draft only
- no save
- no execute

## 9. Allowed LLM interpretation

Allowed:

- state which provider is now selected

Not allowed:

- claim any runtime or web-search capability changed outside the preset draft

## 10. Failure and unavailable behavior

Unavailable if page bridge is absent.

## 11. Side effects

- visible draft mutation only

## 12. Security / safety review

Low risk if constrained to page-owned draft mutation.

## 13. UI / UX expectations

Should be explicit and reversible.

## 14. Example call

```json
{
  "provider": "searchbox"
}
```

## 15. Example success result

```json
{
  "status": "updated",
  "provider": "searchbox"
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

"I changed the visible draft’s search provider to Searchbox. It isn’t saved yet."

## 18. Relationship to other tools

- `get_current_preset_summary`
- `save_current_preset`

## 19. Open questions

- Which provider vocabulary should be exposed directly to users?
