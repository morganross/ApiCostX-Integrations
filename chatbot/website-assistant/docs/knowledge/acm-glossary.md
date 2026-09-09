# ACM Assistant Glossary

Status: authoritative v1

Purpose:
Define ACM terms so Assistant can interpret tool output in product language.

## Core Terms

Assistant:
The in-product assistant inside the ACM website. It reasons with knowledge, thread memory, page context, and browser-side tools.

Browser-side tool:
A tool registered by the React frontend. It runs in the browser context and uses frontend-owned APIs or page-owned bridges.

Runtime:
The CopilotKit assistant backend that hosts the LLM loop, thread persistence, memory, and assistant-token auth.

Frontend API client:
The normal React application API client used by the website to talk to ACM backend services.

Assistant-only token:
The token sent as `X-ACM2-Assistant-Token` to the assistant runtime. It is not the normal ACM backend session token.

Page bridge:
A mounted page-owned object, currently `window.acm2AssistantPresetBridge`, that lets Assistant read or mutate the visible preset page draft through the page workflow.

Visible draft:
The unsaved preset configuration currently mounted in the preset page.

Saved preset:
The persisted preset loaded through the frontend API client.

## Preset Terms

Preset:
A saved ACM configuration that can be inspected, edited, saved, and executed.

Runnability:
Whether the current preset configuration can be executed according to known validation checks.

Blocking reason:
A reason execution or action should not proceed. Blocking reasons prevent the action.

Warning:
A cautionary signal. Warnings may matter, but they do not necessarily prevent execution.

Generation model:
A model selected to generate content in a preset.

Judge model:
A model selected for evaluation.

Combine model:
A model selected to combine or synthesize generated outputs.

Generation instructions:
Instruction content used to guide generation.

Single-eval instructions:
Instruction content used to evaluate one output at a time.

Pairwise-eval instructions:
Instruction content used to compare outputs against each other.

Combine instructions:
Instruction content used to combine multiple outputs.

Input document:
A content asset selected as source material for a preset.

GitHub input path:
A repository path selected as source material when the preset uses GitHub input.

Search provider:
Preset configuration for retrieval or web-search-like behavior during execution. This is not the same as Assistant having internet search.

## Run Terms

Run:
An execution of a preset.

Run status:
The lifecycle state of a run, such as running, completed, completed with errors, failed, or cancelled.

Research completed:
A signal that the research phase of a run completed. It does not by itself prove every downstream step succeeded.

Generated document:
An output document produced by a run.

Winner document:
An output selected as the preferred result when evaluation or selection exists.

Combined document:
An output synthesized from other generated documents.

Run logs:
User-visible log entries associated with a run.

Failure signal:
A structured clue about run failure derived from run status, error messages, missing outputs, or logs.

Severity:
A coarse indication of how serious visible failure signals appear. It is not a complete root-cause analysis by itself.

## Tool Status Terms

`status: loaded`:
The tool successfully loaded or summarized the requested information.

`status: evaluated`:
The tool completed a validation or readiness evaluation.

`status: updated`:
The tool changed visible page draft state.

`status: saved`:
The visible preset page save handler completed.

`status: started`:
The visible preset page execute handler started a run.

`status: unavailable`:
The requested action is not available from the current page, state, or inputs.

`status: not_found`:
The requested entity was not found through the frontend-accessible path.

`status: error`:
The tool failed unexpectedly. Do not treat this as an ACM domain diagnosis unless the error itself says so.

`notes`:
Scope or limitation statements returned by a tool.

`next_steps`:
Suggested follow-up actions derived from visible facts.

`interpretation_notes`:
Tool-provided guidance about how Assistant should read a payload.

