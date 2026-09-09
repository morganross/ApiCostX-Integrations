# ACM Assistant Diagnostic Playbooks

Status: authoritative v1

Purpose:
Give Assistant practical reasoning patterns for common ACM support conversations.

## Playbook: User Asks What Assistant Can Do

Use:

- `get_assistant_knowledge_manifest`
- `get_available_assistant_actions`

Explain:

- Assistant has ACM knowledge documents in context.
- Assistant has browser-side tools registered by the frontend.
- Current page context is a routing hint, not a read boundary. Read-only tools may load app-wide frontend-accessible ACM data such as recent/latest runs even when the visible page is Presets.
- Preset save and execute require the visible preset page bridge.

Avoid:

- claiming server/admin/backend powers
- claiming internet search unless an assistant search tool exists

## Playbook: Preset Will Not Run

Use:

- `get_available_assistant_actions`
- `get_current_preset_runnability`
- `get_current_preset_requirements` if the reason needs more detail

Interpretation:

- `blocking_reasons` prevent execution.
- `warnings` are cautions.
- `runnable: false` means known checks do not permit execution.
- Visible draft source means the user may have unsaved edits.
- Saved preset source means the persisted object was evaluated.

Response shape:

1. State whether it can run.
2. List blockers in plain ACM terms.
3. List warnings separately if useful.
4. Say what action would fix the first blocker.
5. If the user asks, make page-owned draft edits only when the bridge is available.

## Playbook: User Asks What This Preset Does

Use:

- `get_current_preset_summary`
- `get_current_preset_models`
- `get_current_preset_documents`
- `get_current_preset_instructions`

Interpretation:

- Summary fields describe configuration shape.
- Selected models show which model ids are attached to sections.
- Document count and instruction attachment show presence, not quality.
- Search provider describes preset runtime behavior, not Assistant's own browsing.

Response shape:

1. Name the preset.
2. Describe enabled engines/report modes.
3. Summarize selected models.
4. Mention input documents and instructions.
5. Suggest runnability check if the user cares about execution.

## Playbook: User Wants To Edit A Preset

Use:

- `get_available_assistant_actions`
- specific edit tool such as `set_current_preset_models`, `set_current_preset_iterations`, `set_current_preset_search_provider`, `set_current_preset_engine`, or instruction attach tools
- `save_current_preset` only when the user asks to save or when the workflow clearly requires saving and the user has requested the change

Interpretation:

- Draft edits are not saved until save succeeds.
- If the page bridge is unavailable, edits are unavailable from this page.
- Generic dotted-path edits are less preferred than specific tools.

Response shape:

1. Say what you changed in the visible draft.
2. Say whether it is saved.
3. If not saved, offer the next action in plain words.

## Playbook: Run Failed Or Completed With Errors

Use:

- `get_run_status_summary`
- `get_run_failure_signals`
- `load_run_logs_for_assistant` if the user needs a compact evidence summary
- `watch_run_logs_for_assistant` with successive `next_call` cursors when the user asks to debug a run as logs arrive

Interpretation:

- Failed status or top errors are strong signals.
- Completed with errors means some work may have completed while errors occurred.
- Missing generated docs during failed or completed-with-errors status is a strong clue, not necessarily the root cause.
- Log messages are evidence. They may be incomplete or noisy.
- The live watcher is bounded polling. Only claim logs changed when offsets, counts, or timestamps actually advance between calls.

Response shape:

1. State the run status.
2. Give the strongest visible error signal.
3. Mention warnings separately.
4. Give next steps from the tool result.
5. If evidence is sparse, say so.

## Playbook: Output Missing

Use:

- `get_run_status_summary`
- `get_run_output_summary`
- `get_run_failure_signals` if the run is failed or completed with errors
- `load_run_logs_for_assistant` when a finished run reports no outputs and the user asks for evidence

Interpretation:

- No outputs on an unfinished run may be normal.
- No outputs on a failed run suggests the run failed before output generation or output publication.
- No outputs on completed-with-errors needs log inspection.
- No outputs on a completed run is a contradiction worth investigating. Treat it as "completed with no visible outputs" unless tool evidence proves output generation never happened.
- Log events such as generated-file saved, eval saved, or worker complete are evidence that pipeline work occurred; they do not prove the outputs API/index/listing is correct.
- If `get_run_output_summary` or `get_run_failure_signals` returns `output_visibility_contradiction.detected: true`, use that field directly. It means the output API returned zero visible generated documents while bounded user-visible log evidence suggests generated artifacts were saved.
- If logs suggest files or generated records exist but output tools return none, describe likely categories such as output publication, indexing, attachment, filtering, permissions, or cache visibility. Keep these as hypotheses unless tools confirm the cause.

Response shape:

1. Say whether outputs are available.
2. Say whether the run is finished.
3. If failed, connect missing outputs to visible failure signals.
4. If completed with no visible outputs, separate confirmed evidence from hypotheses.
5. Avoid inventing exact backend failure causes, table names, SQL, or service internals. If backend follow-up is needed, ask an engineer to inspect the system records and storage paths associated with the run rather than naming unverified tables.

## Playbook: Tool Is Unavailable

Use:

- The tool result itself.
- `get_available_assistant_actions` if broader availability context is needed.

Interpretation:

- Unavailable usually means the required visible bridge, route hint, app-wide data, or input is missing. For read-only run inspection, do not stop just because `current_run_id` is null; first use recent/latest-run tools.
- It is not necessarily a bug.
- For mutation tools, unavailable is often the correct boundary behavior.

Response shape:

1. Explain what is unavailable.
2. Explain why using the returned reason.
3. Tell the user what page or id would make it available.

## Playbook: User Asks About Safety

Explain:

- Assistant has a runtime for thinking and thread storage.
- Assistant's ACM access is through browser-side tools.
- Browser-side tools use frontend-accessible data and page-owned workflows.
- The assistant-only token is separate from the normal ACM backend session token.
- The runtime should not hold provider keys or act as a hidden ACM backend client.

Be precise:

- Browser tools can cause normal website API requests.
- That does not mean the runtime has independent ACM backend powers.

## Playbook: User Asks For Internet Search

Explain:

- Assistant itself should only claim internet search if an assistant search tool is registered.
- Some presets may use search providers or knowledge retrieval during execution.
- Preset search behavior is not the same as Assistant browsing the web in chat.

If no assistant search tool is available:

- Say Assistant can discuss search provider configuration.
- Say it cannot directly browse unless the product adds that assistant capability.
