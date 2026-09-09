# Tool Plan: `get_run_output_summary`

Status: planning draft

Purpose:
Give the assistant a compact, structured overview of the outputs produced by a run so it can answer:

"What came out of this run?"

This tool should help the assistant discuss output presence, output count, and output shape before diving into the full generated content itself.

## 1. Tool name

`get_run_output_summary`

## 2. User-facing purpose

This tool exists so the assistant can answer questions like:

- "Did this run produce anything?"
- "What outputs were generated?"
- "How many generated documents are there?"
- "Should I inspect the outputs next?"

This is a summary tool, not a full document-content retrieval tool.

## 3. Category

Primary category:

- lazy frontend fetch / read-only output inspection

Secondary role:

- explanation support

## 4. Boundary level

This tool should read only from frontend-owned sources:

- cached run data
- cached output data if already loaded
- frontend run/output APIs when needed

It must not:

- mutate anything
- retry anything
- perform hidden backend inspection outside the frontend path
- load all document bodies by default if a lighter summary is enough

The tool should stay inside the page-agent model and prefer metadata-first output inspection.

## 5. Inputs

Recommended inputs:

```json
{
  "run_id": "optional",
  "include_document_titles": true
}
```

Interpretation:

- If `run_id` is provided, summarize outputs for that run.
- If `run_id` is omitted, use the current active run from page context.
- `include_document_titles` controls whether light identifying labels are included in the summary.

Validation rules:

- If neither `run_id` nor `current_run_id` exists, return `unavailable`.
- If the run cannot be found, return `not_found`.

Optional future inputs:

- `include_document_types`
- `include_preview_snippets`
- `max_items`

## 6. Source of truth

Preferred resolution order:

1. Use cached run data if it already contains enough output metadata.
2. Use cached loaded outputs if they exist.
3. Otherwise load the run through frontend APIs and inspect generated document metadata.
4. Only load full output bodies if version 1 truly needs them for summary, which is probably unnecessary.

This tool should focus first on output metadata, not full content.

Examples of useful metadata:

- generated document count
- output names/titles
- output ids
- output types if available
- whether outputs appear empty or non-empty

## 7. Output schema

Recommended output shape:

```json
{
  "status": "loaded",
  "run_id": "abc123",
  "summary": {
    "outputs_available": true,
    "generated_document_count": 2,
    "documents": [
      {
        "id": "doc1",
        "title": "Executive Summary",
        "type": "report"
      },
      {
        "id": "doc2",
        "title": "Citations Appendix",
        "type": "appendix"
      }
    ]
  },
  "notes": [
    "This is an output summary only.",
    "Use a dedicated content tool to inspect the body of a generated document."
  ]
}
```

Recommended core fields:

- `outputs_available`
- `generated_document_count`
- `documents`

Each item in `documents` should stay lightweight.

Recommended per-document fields for version 1:

- `id`
- `title`
- `type` if available

Avoid loading or returning full body text here unless a future version explicitly calls for it.

## 8. Semantics

Important meaning rules:

- `outputs_available: true` means some generated output metadata exists for the run.
- `generated_document_count` is factual count only.
- A document being present does not imply it is high quality.
- A zero count does not by itself prove failure, but it is an important signal.

This tool should help the assistant answer:

"What outputs exist?"

It should not try to answer:

"Are these outputs good?" or "What exactly do they say?" without deeper tools.

## 9. Allowed LLM interpretation

The assistant may safely infer:

- whether there are outputs to inspect
- whether output review is the next logical step
- whether lack of outputs is an important signal

The assistant should not infer:

- output quality from existence alone
- detailed content meaning from titles alone
- final user value from document count alone

Good explanation:

"This run produced two generated documents, including an Executive Summary and a Citations Appendix. If you want, the next step is to inspect the content of one of those outputs."

Bad explanation:

"The output looks excellent because there are two documents."

## 10. Failure and unavailable behavior

Suggested response classes:

### Success

```json
{
  "status": "loaded",
  ...
}
```

### No active run available

```json
{
  "status": "unavailable",
  "message": "No active run is selected on the current page, and no run_id was provided."
}
```

### Run not found

```json
{
  "status": "not_found",
  "message": "The requested run could not be found."
}
```

### No outputs

```json
{
  "status": "loaded",
  "run_id": "abc123",
  "summary": {
    "outputs_available": false,
    "generated_document_count": 0,
    "documents": []
  },
  "notes": [
    "No generated outputs are currently available for this run."
  ]
}
```

### Unexpected error

```json
{
  "status": "error",
  "message": "Run output summary could not be loaded."
}
```

## 11. Side effects

This tool should be read-only.

Acceptable side effects:

- assistant-local cache population for run/output metadata

Not acceptable:

- navigation
- loading large full output bodies by default
- modifying run or preset state

## 12. Security / safety review

Why this tool is relatively safe:

- it is read-only
- it operates through frontend-owned output access
- it summarizes metadata rather than exposing giant full outputs by default

Potential risks:

- accidentally returning full output content in a summary tool
- returning too much output metadata when a compact summary would do
- conflating output presence with output quality

Mitigations:

- keep version 1 metadata-only
- make content retrieval a separate tool
- document interpretation boundaries clearly

## 13. UI / UX expectations

Desired user experience:

- The assistant can quickly answer whether a run produced outputs.
- The answer should make it obvious whether output inspection is worth doing next.
- The response should be compact and readable, not a huge artifact dump.

This tool should make the assistant feel more useful after a run finishes, whether the outcome was good or bad.

## 14. Example call

Using current visible run:

```json
{}
```

Using explicit run id:

```json
{
  "run_id": "a6e44c24-61e9-425d-861c-225dcb93eeee",
  "include_document_titles": true
}
```

## 15. Example success result

```json
{
  "status": "loaded",
  "run_id": "a6e44c24-61e9-425d-861c-225dcb93eeee",
  "summary": {
    "outputs_available": true,
    "generated_document_count": 2,
    "documents": [
      {
        "id": "doc_1",
        "title": "Executive Summary",
        "type": "report"
      },
      {
        "id": "doc_2",
        "title": "Source Appendix",
        "type": "appendix"
      }
    ]
  },
  "notes": [
    "This is an output summary only.",
    "Use a deeper content tool to inspect document bodies."
  ]
}
```

## 16. Example unavailable result

```json
{
  "status": "unavailable",
  "message": "No active run is selected on the current page, and no run_id was provided."
}
```

## 17. Example explanation behavior

Good explanation:

"This run produced two generated documents: an Executive Summary and a Source Appendix. If you want, I can next inspect one of those outputs in more detail."

Good follow-up:

"If there should have been outputs but there are none, the next useful step is to inspect the run’s failure signals or logs."

## 18. Relationship to other tools

This tool should complement, not replace:

- `get_run_status_summary`
- `get_run_failure_signals`
- `load_run_outputs_for_assistant`

Think of this one as:

- output presence and output inventory

while the others are:

- execution status
- failure clues
- deeper output/body retrieval

## 19. Open questions

1. What output metadata is stable enough to expose in version 1?
2. Should output titles always be included, or only when explicitly requested?
3. Should "empty but present" outputs be represented separately from "no outputs"?
4. Should output content previews ever belong here, or only in a separate document-inspection tool?

Current recommendation:

- keep version 1 metadata-first
- separate inventory from content inspection
- include titles when available because they improve explanation quality a lot
