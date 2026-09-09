# Tool Plan: `get_current_preset_documents`

Status: planning draft

Purpose:
Return a structured summary of the document attachments relevant to the current or specified preset.

## 1. Tool name

`get_current_preset_documents`

## 2. User-facing purpose

Use this tool to answer:

- "What documents are attached?"
- "How many documents are in this preset?"
- "Are there any source documents selected?"

## 3. Category

- read-only page state / lazy frontend fetch

## 4. Boundary level

Reads only from visible draft, cached preset data, or frontend preset APIs. No mutation.

## 5. Inputs

```json
{
  "preset_id": "optional",
  "use_visible_draft_if_available": true,
  "include_document_names": true
}
```

## 6. Source of truth

Visible draft first, then cache, then frontend API.

## 7. Output schema

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "documents": {
    "document_count": 3,
    "items": [
      {"id": "doc1", "name": "sample-research.md"},
      {"id": "doc2", "name": "policy.pdf"},
      {"id": "doc3", "name": "notes.txt"}
    ]
  }
}
```

## 8. Semantics

- `document_count` is a factual count only.
- `items` should stay lightweight.
- Attachment presence is not by itself proof of good quality or sufficiency.

## 9. Allowed LLM interpretation

Allowed:

- describe how many documents are attached
- identify them by name if available

Not allowed:

- infer document quality or relevance from names alone

## 10. Failure and unavailable behavior

Standard:

- `unavailable`
- `not_found`
- `error`

## 11. Side effects

Read-only, cache fill allowed.

## 12. Security / safety review

Low risk, but do not over-return hidden document metadata.

## 13. UI / UX expectations

The assistant should be able to talk about document attachment state without searching the whole preset blob.

## 14. Example call

```json
{}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "preset_id": "abc",
  "documents": {
    "document_count": 3,
    "items": [
      {"id": "doc1", "name": "sample-research.md"},
      {"id": "doc2", "name": "policy.pdf"},
      {"id": "doc3", "name": "notes.txt"}
    ]
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

"This preset currently has three attached documents: sample-research.md, policy.pdf, and notes.txt."

## 18. Relationship to other tools

- `get_current_preset_summary`
- `get_current_preset_requirements`

## 19. Open questions

- Which document metadata is appropriate to expose?
- Should folder/path context ever be returned?
