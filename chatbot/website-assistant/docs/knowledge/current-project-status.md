# ACM Assistant Current Project Status

Status: versioned frontend knowledge snapshot

Last reviewed: 2026-06-06

Purpose:
Give Assistant a concise status briefing about its own implementation.

## Current Architecture

Assistant is designed as a frontend-scoped ACM page agent.

The current frontend source shows:

- browser-side assistant tools are registered in `ui/src/components/assistant/useAssistantPageTools.ts`
- the assistant panel lives in `ui/src/components/assistant/AssistantPanel.tsx`
- runtime thread APIs are called through `ui/src/api/assistant.ts`
- runtime requests use `X-ACM2-Assistant-Token`
- the browser still has the normal ACM session for normal website API calls
- preset draft read/edit/save/execute behavior depends on `window.acm2AssistantPresetBridge`

The live design keeps ACM account data and mutations in browser-side tools operating with the logged-in user's website authority. The runtime has its own assistant services, thread storage, and public-search capability, but it must not receive independent privileged ACM backend access. Keep private hostnames, IP addresses, usernames, and operational access details out of frontend-bundled knowledge files.

## Current Tool Families

Orientation and knowledge:

- `get_assistant_knowledge_manifest`
- `get_available_assistant_actions`
- `get_visible_page_state`
- `get_current_route_context`
- `navigate_to_app_route`
- `refresh_current_page_data`

Content Library:

- `get_content_library_summary`
- `search_content_library_for_assistant`
- `load_content_for_assistant`
- `create_content_for_assistant`
- `update_content_for_assistant`
- `duplicate_content_for_assistant`
- `delete_content_for_assistant`
- `list_github_connections_for_assistant`
- `browse_github_connection_for_assistant`
- `import_github_file_to_content_library`

Preset read:

- `get_loaded_preset_list`
- `load_preset_for_assistant`
- `select_preset_and_wait_until_hydrated`
- `get_current_preset_summary`
- `get_current_preset_runnability`
- `get_current_preset_requirements`
- `get_current_preset_models`
- `get_current_preset_documents`
- `get_current_preset_instructions`
- `get_current_preset_draft`

Preset edit and execution:

- `attach_generation_instructions_to_current_preset`
- `attach_eval_instructions_to_current_preset`
- `attach_combine_instructions_to_current_preset`
- `set_current_preset_engine`
- `set_current_preset_iterations`
- `set_current_preset_search_provider`
- `set_current_preset_engine_models`
- `create_new_preset`
- `set_current_preset_name`
- `list_available_generation_models`
- `select_current_preset_input_documents`
- `save_current_preset`
- `execute_current_preset`

Run and output inspection:

- `get_loaded_history_rows`
- `get_recent_runs_for_assistant`
- `get_latest_run_context`
- `load_run_for_assistant`
- `get_run_status_summary`
- `get_run_failure_signals`
- `get_run_output_summary`
- `load_run_logs_for_assistant`
- `watch_run_logs_for_assistant`
- `load_run_outputs_for_assistant`

## Known Constraints

- Assistant should not preload all user data.
- Assistant should preload bounded app-wide recent/latest-run context when the chat opens, including recent run rows, latest run detail, latest event logs, latest output summary, and a bounded number of latest output bodies.
- Assistant should lazily load specific presets, runs, logs, and outputs beyond that preload only when useful.
- Assistant should treat route/page context as a hint for reads, not a read boundary. It can silently load frontend-accessible app-wide data without changing pages.
- Assistant can change the visible React route with `navigate_to_app_route` for known ACM app pages, but route navigation is not required for app-wide reads.
- Assistant should not claim hidden backend access.
- Assistant should not claim runtime-side knowledge injection until the runtime phase is verified.
- Assistant should not treat instruction attachment as proof of instruction quality.
- Assistant should not treat selected models as proof of execution success.
- Assistant should not treat empty local cache as proof that no data exists.

## Current Knowledge Layer

The frontend now bundles this knowledge pack into the assistant context:

- core system prompt
- ACM handbook
- ACM glossary
- tool reference
- diagnostic playbooks
- FPF preset quality doctrine
- current project status

The assistant now injects compact core guidance and a small topic index into every run. Detailed feature Markdown is kept in the allowlisted source bundle and is read only when Assistant calls `read_knowledge_topic`; CopilotKit context carries the topic manifest plus live page/thread context.

## Future Runtime Phase

When CopilotKit-node access is available:

1. Verify runtime has no ACM backend-facing assistant tools.
2. Verify runtime does not receive the real ACM backend session token.
3. Decide whether the same allowlisted topic reader should also be available to the runtime.
4. Keep frontend topic reads authoritative for website-specific knowledge until runtime-side loading is proven in a real request trace.
