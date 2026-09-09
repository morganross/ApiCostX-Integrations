"""
Minimal compiled LangGraph for the advanced assistant execution lane.
"""
from __future__ import annotations

import json
import logging
import re
import uuid

from langgraph.graph import END, START, StateGraph

from .llm import (
    AdvancedAssistantLlmUnavailable,
    answer_with_advanced_assistant_model,
    choose_website_tool_with_advanced_assistant_model,
    synthesize_tool_result_with_advanced_assistant_model,
)
from .state import AdvancedGraphState
from .shared_actions import SHARED_TOOLS, SHARED_WRITES, shared_arguments


ADVANCED_PLACEHOLDER_REPLY = (
    "Advanced mode is running through the backend LangGraph MVP. "
    "The logged-in website owns auth, chat-history saving, and future website actions; "
    "LangGraph only received bounded chat/page context and produced this reply."
)

RUN_MONITOR_STATUS_POLL_LIMIT = 2
RUN_MONITOR_LOG_POLL_LIMIT = 2
RUN_MONITOR_TERMINAL_STATES = {
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
    "canceled",
}

logger = logging.getLogger(__name__)

DETERMINISTIC_WRITE_OR_WORKFLOW_TOOLS = {
    "create_content_for_assistant",
    "update_content_for_assistant",
    "start_new_preset_draft",
    "configure_fpf_preset_draft",
    "save_current_preset_draft",
    "execute_current_preset",
    "attach_generation_instructions_to_current_preset",
    "attach_input_document_to_current_preset",
    "attach_eval_asset_to_current_preset",
    "attach_combine_instructions_to_current_preset",
    "set_current_preset_engine_models",
    "set_current_preset_iterations",
    "set_current_preset_engine",
    "set_current_preset_search_provider",
}


def build_advanced_assistant_graph():
    graph = StateGraph(AdvancedGraphState)
    graph.add_node("inspect_state", _inspect_state)
    graph.add_conditional_edges("inspect_state", _route_after_inspection)
    graph.add_node("request_tool", _request_tool)
    graph.add_node("final_response", _final_response)
    graph.add_edge(START, "inspect_state")
    graph.add_edge("request_tool", END)
    graph.add_edge("final_response", END)
    return graph.compile()


def _inspect_state(state: AdvancedGraphState) -> AdvancedGraphState:
    """Decide whether this turn needs a website tool or can answer now."""
    messages = state.get("messages") or []
    latest_role = str(messages[-1].get("role") or "") if messages else ""
    current_user_message = state.get("current_user_message") or ""
    requested_tool = None
    if latest_role != "tool" and not _no_website_context_requested(current_user_message):
        requested_tool = _choose_deterministic_write_or_workflow_tool(current_user_message)
        supervisor_args: dict[str, object] | None = None
        if requested_tool is None:
            supervisor_tool, supervisor_args, supervisor_available = _choose_website_tool_with_supervisor(state)
            requested_tool = supervisor_tool
            required_tool = _required_website_fact_tool(current_user_message) if supervisor_available else None
            if required_tool and (requested_tool is None or requested_tool in {"get_current_route_context", "get_visible_page_state"}):
                requested_tool = required_tool
                supervisor_args = None
            if requested_tool is None and not supervisor_available:
                requested_tool = _choose_website_tool(current_user_message)
                supervisor_args = None
    else:
        supervisor_args = None
    if requested_tool:
        return {
            "next_action": "request_tool",
            "requested_tool_name": requested_tool,
            "requested_tool_args": _tool_arguments(requested_tool, state, supervisor_args=supervisor_args),
        }

    tool_results = _tool_results(messages) if latest_role == "tool" else []
    if tool_results:
        follow_up_tool = _follow_up_website_tool(state, tool_results)
        if follow_up_tool:
            return {
                "next_action": "request_tool",
                "requested_tool_name": follow_up_tool,
                "requested_tool_args": _tool_arguments(follow_up_tool, state),
                "tool_results": tool_results,
            }
        return {"latest_tool_result": tool_results[-1], "tool_results": tool_results}

    return {"next_action": "final_response"}


def _choose_deterministic_write_or_workflow_tool(user_message: str) -> str | None:
    """Keep explicit writes and established workflows out of model-only routing."""
    requested_tool = _choose_website_tool(user_message)
    if requested_tool in DETERMINISTIC_WRITE_OR_WORKFLOW_TOOLS:
        return requested_tool
    return None


def _choose_website_tool_with_supervisor(state: AdvancedGraphState) -> tuple[str | None, dict[str, object], bool]:
    """Ask the model for a bounded website-capability choice.

    Deterministic routing still handles explicit writes and established
    workflows. The model leads read-only capability choice, while the graph
    still owns schemas, arguments, and the named website-tool boundary.

    Returns:
        (tool_name, args, True) when the supervisor lane was available.
        (None, {}, True) when the supervisor intentionally chose no tool.
        (None, {}, False) when the supervisor lane was unavailable or errored.
    """
    try:
        tool_name, tool_args = choose_website_tool_with_advanced_assistant_model(state=dict(state))
        logger.info(
            "[ADV_SUPERVISOR] decision=%s tool=%s args=%s thread=%s trace=%s",
            "tool" if tool_name else "no_tool",
            tool_name or "",
            sorted(tool_args.keys()) if isinstance(tool_args, dict) else [],
            state.get("thread_id") or "",
            state.get("trace_id") or "",
        )
        return tool_name, dict(tool_args or {}), True
    except AdvancedAssistantLlmUnavailable as exc:
        logger.info(
            "[ADV_SUPERVISOR] decision=unavailable reason=%s thread=%s trace=%s",
            str(exc)[:160],
            state.get("thread_id") or "",
            state.get("trace_id") or "",
        )
        return None, {}, False
    except Exception as exc:
        logger.warning(
            "[ADV_SUPERVISOR] decision=error error=%s thread=%s trace=%s",
            f"{type(exc).__name__}: {exc}"[:160],
            state.get("thread_id") or "",
            state.get("trace_id") or "",
        )
        return None, {}, False


def _required_website_fact_tool(user_message: str) -> str | None:
    """Hard evidence rail for private website-state questions.

    The model supervisor is allowed to decide most read-tool routing, but it
    must not answer private ACM website-state questions from memory. This guard
    catches the small set of turns where a no-tool decision would force the
    assistant to speculate about the current preset instead of inspecting it.
    """
    text = str(user_message or "").lower()
    if not any(token in text for token in ("current preset", "this preset", "the preset", "as-is", "as is")):
        return None
    if not any(
        token in text
        for token in (
            "good enough",
            "good fit",
            "fit",
            "fits",
            "use in",
            "use for",
            "as-is",
            "as is",
            "suitable",
            "appropriate",
            "ready",
            "quality",
            "should i use",
            "would you use",
        )
    ):
        return None
    return "get_current_preset_summary"


def _route_after_inspection(state: AdvancedGraphState) -> str:
    if state.get("latest_tool_result"):
        return "final_response"
    if state.get("next_action") == "request_tool":
        return "request_tool"
    return "final_response"


def _request_tool(state: AdvancedGraphState) -> AdvancedGraphState:
    requested_tool = state.get("requested_tool_name")
    if not isinstance(requested_tool, str) or not requested_tool:
        return {"response_text": _default_response(state)}
    requires_confirmation = requested_tool in SHARED_WRITES
    request_label = (
        _confirmation_tool_label(requested_tool)
        if requires_confirmation
        else (
            "I need to use a named website tool through the logged-in page. "
            "Advanced YOLO mode auto-runs the tool; LangGraph still receives no browser tokens, database keys, "
            "provider keys, or raw backend API authority."
        )
    )
    return {
        "response_text": request_label,
        "tool_request": {
            "type": "tool_request",
            "tool_name": requested_tool,
            "arguments": state.get("requested_tool_args") or {},
            "requires_confirmation": requires_confirmation,
            "request_id": f"advtool-{uuid.uuid4()}",
        },
    }


def _final_response(state: AdvancedGraphState) -> AdvancedGraphState:
    tool_result = state.get("latest_tool_result")
    if isinstance(tool_result, dict):
        return {"response_text": _tool_result_response(state, tool_result)}
    return {"response_text": _default_response(state)}


def _default_response(state: AdvancedGraphState) -> str:
    if _non_fpf_preset_builder_requested(state.get("current_user_message") or ""):
        return _non_fpf_preset_builder_response(state)
    preset_asset_concept_response = _preset_asset_concept_response(state.get("current_user_message") or "", state)
    if preset_asset_concept_response:
        return preset_asset_concept_response
    internet_capability_response = _internet_capability_response(state.get("current_user_message") or "", state)
    if internet_capability_response:
        return internet_capability_response
    security_boundary_response = _security_boundary_response(state.get("current_user_message") or "", state)
    if security_boundary_response:
        return security_boundary_response
    write_tool_capability_response = _write_tool_capability_response(state.get("current_user_message") or "", state)
    if write_tool_capability_response:
        return write_tool_capability_response
    acm_role_response = _acm_role_response(state.get("current_user_message") or "", state)
    if acm_role_response:
        return acm_role_response
    arithmetic_response = _simple_arithmetic_response(state.get("current_user_message") or "")
    if arithmetic_response:
        return arithmetic_response
    model_response = _model_default_response(state)
    if model_response:
        return model_response
    user_message = _compact_text(state.get("current_user_message") or "")
    route = _route_label(state.get("page_context"))
    parts = [
        "The advanced assistant model lane is not configured or returned an operational error.",
        "This is a deployment/configuration problem, not a conversation-policy refusal.",
    ]
    if route:
        parts.append(f"Current website context: {route}.")
    if user_message:
        parts.append(f"Your latest message was: {user_message}")
    return "\n\n".join(parts)


def _model_default_response(state: AdvancedGraphState) -> str:
    try:
        return answer_with_advanced_assistant_model(state=dict(state))
    except AdvancedAssistantLlmUnavailable as exc:
        return _model_unavailable_response(state, str(exc))
    except Exception as exc:
        return _model_unavailable_response(state, f"{type(exc).__name__}: {exc}")


def _model_unavailable_response(state: AdvancedGraphState, reason: str) -> str:
    user_message = _compact_text(state.get("current_user_message") or "")
    route = _route_label(state.get("page_context"))
    parts = [
        "The advanced assistant model lane is not available right now.",
        f"Reason: {reason}",
        "This is a backend model configuration/runtime issue, not an intentional restriction on what I am allowed to discuss.",
    ]
    if route:
        parts.append(f"Current website context: {route}.")
    if user_message:
        parts.append(f"Your latest message was: {user_message}")
    return "\n\n".join(parts)


def _security_boundary_response(user_message: str, state: AdvancedGraphState) -> str:
    text = str(user_message).lower()
    if not any(token in text for token in ("backend", "api", "database", "db key", "database key", "session token", "browser token", "secret", "provider key")):
        return ""
    if not any(token in text for token in ("can you", "do you", "access", "have", "see", "use", "know")):
        return ""
    route = _route_label(state.get("page_context"))
    parts = [
        "No. The advanced assistant graph should not receive your backend API authority, database keys, browser session token, provider keys, or raw backend access.",
        (
            "Its intended power comes from named website tools that run through the logged-in page. "
            "Those tools can do only what the website exposes through the current browser/page workflow."
        ),
        (
            "So the website may save drafts, inspect presets, or run page-owned actions, but the graph itself is not a hidden backend client and does not hold your secrets."
        ),
    ]
    if route:
        parts.append(f"Current website context: {route}.")
    return "\n\n".join(parts)


def _write_tool_capability_response(user_message: str, state: AdvancedGraphState) -> str:
    text = str(user_message).lower()
    if not _write_action_negated(text):
        return ""
    if not any(token in text for token in ("would need", "need a website tool", "need tool", "would you need", "would this need")):
        return ""
    if not any(token in text for token in ("content", "preset", "document", "instruction", "save", "execute", "run", "attach", "update", "rename")):
        return ""
    route = _route_label(state.get("page_context"))
    parts = [
        "Yes. To actually change website state, I would need to request a named website tool through the logged-in page.",
        "I will not run that tool because you explicitly told me not to perform the requested action.",
        "The advanced graph still would not receive browser tokens, database keys, provider keys, or raw backend API authority.",
    ]
    if route:
        parts.append(f"Current website context: {route}.")
    return "\n\n".join(parts)


def _preset_asset_concept_response(user_message: str, state: AdvancedGraphState) -> str:
    if not _preset_asset_concept_question(user_message):
        return ""
    route = _route_label(state.get("page_context"))
    parts = [
        "Generation instructions and input documents are different kinds of preset assets.",
        (
            "Generation instructions tell FPF how to generate the output: the tone, structure, constraints, "
            "source-use rules, output format, uncertainty handling, and forbidden behavior."
        ),
        (
            "Input documents tell FPF what to generate from: the topic, source material, brief, facts, examples, "
            "or documents that bound the generated work."
        ),
        (
            "Short version: instructions are the method and rules; input documents are the subject matter and source boundary."
        ),
    ]
    if route and not _no_website_context_requested(user_message):
        parts.append(f"Current website context: {route}.")
    parts.append("For an FPF preset from scratch, this milestone expects one generation-instructions asset and one input-document asset before saving and verifying the preset.")
    return "\n\n".join(parts)


def _no_website_context_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(
        token in text
        for token in (
            "do not inspect the website",
            "don't inspect the website",
            "dont inspect the website",
            "do not use any tools",
            "don't use any tools",
            "dont use any tools",
            "without using tools",
            "no tools",
            "answer without tools",
        )
    )


def _preset_asset_concept_question(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("difference", "different", "diff", "versus", " vs ")):
        return False
    has_instructions = any(token in text for token in ("generation instruction", "generation instructions", "instruction file", "instructions"))
    has_documents = any(token in text for token in ("input document", "input documents", "topic file", "topic files", "source document", "source material"))
    if not (has_instructions and has_documents):
        return False
    return any(
        token in text
        for token in (
            "what is",
            "what's",
            "explain",
            "tell me",
            "define",
            "how are",
        )
    )


def _acm_role_response(user_message: str, state: AdvancedGraphState) -> str:
    text = str(user_message).lower()
    role_question = any(
        token in text
        for token in (
            "who are you",
            "what are you",
            "what can you help",
            "what can you do",
            "how can you help",
            "what are you for",
            "what do you do",
        )
    )
    if not role_question:
        return ""
    if "acm" not in text and not any(token in text for token in ("who are you", "what are you", "what are you for")):
        return ""
    route = _route_label(state.get("page_context"))
    parts = [
        "I can help you use ACM from inside the logged-in website.",
        (
            "Right now my strongest advanced-mode lane is preset work: inspecting the current preset, "
            "checking whether it can run, reviewing attached content and models, reading run status or failure signals, "
            "and building FPF presets from scratch through the website tool bridge."
        ),
        (
            "For this milestone, preset creation is intentionally FPF-only and uses the website's existing logged-in "
            "frontend capabilities rather than giving the graph raw backend, database-key, or provider-key access."
        ),
    ]
    if route:
        parts.append(f"Current website context: {route}.")
    parts.append("If you want, ask me to inspect the current preset, explain what blocks it from running, or create an FPF preset from scratch.")
    return "\n\n".join(parts)


def _internet_capability_response(user_message: str, state: AdvancedGraphState) -> str:
    text = str(user_message).lower()
    mentions_browsing = any(token in text for token in ("internet", "web", "browse", "search"))
    asks_current_events = any(token in text for token in ("latest", "today", "current", "news", "recent")) and any(
        token in text for token in ("what is", "what's", "tell me", "summarize", "about")
    )
    if not mentions_browsing and not asks_current_events:
        return ""
    if mentions_browsing and not any(token in text for token in ("can you", "are you able", "do you have", "from this chat", "in this chat")) and not asks_current_events:
        return ""
    route = _route_label(state.get("page_context"))
    parts = [
        "No. I cannot directly search or browse the internet from this advanced chat right now.",
        "I can use the approved ACM website tools that are exposed by the logged-in page, but no general internet-search tool is currently wired into this advanced assistant.",
    ]
    if route:
        parts.append(f"Current website context: {route}.")
    parts.append(
        "Some ACM presets may run web/search workflows during preset execution, but that is different from this chat assistant browsing the web itself."
    )
    return "\n\n".join(parts)


def _simple_arithmetic_response(user_message: str) -> str:
    text = str(user_message).strip().lower()
    compact = re.sub(r"\s+", " ", text)
    match = re.search(r"\bwhat\s+is\s+(-?\d+)\s*([+])\s*(-?\d+)\b", compact)
    if not match:
        return ""
    left = int(match.group(1))
    right = int(match.group(3))
    return f"{left} + {right} = {left + right}."


def _confirmation_tool_label(tool_name: str) -> str:
    if tool_name == "save_current_preset_draft":
        return "I can save the current visible preset draft through the logged-in website tool bridge."
    if tool_name == "create_content_for_assistant":
        return "I can create a content-library record through the logged-in website tool bridge."
    if tool_name == "update_content_for_assistant":
        return "I can update a content-library record through the logged-in website tool bridge."
    if tool_name == "start_new_preset_draft":
        return "I can start a clean new visible preset draft through the logged-in website tool bridge."
    if tool_name == "configure_fpf_preset_draft":
        return "I can configure the visible preset draft as an FPF-only gpt-5-mini preset through the logged-in website tool bridge."
    if tool_name == "attach_generation_instructions_to_current_preset":
        return (
            "I can attach the selected generation-instructions content record to the current visible preset draft, "
            "through the logged-in website tool bridge."
        )
    if tool_name == "attach_input_document_to_current_preset":
        return (
            "I can attach the selected input-document, topic-file, or source-material content record to the current visible preset draft, "
            "through the logged-in website tool bridge."
        )
    if tool_name == "attach_eval_asset_to_current_preset":
        return (
            "I can attach the selected single-eval instructions, pairwise-eval instructions, or eval criteria to the current visible preset draft, "
            "through the logged-in website tool bridge."
        )
    if tool_name == "attach_combine_instructions_to_current_preset":
        return (
            "I can attach the selected combine-instructions content record to the current visible preset draft, "
            "through the logged-in website tool bridge."
        )
    if tool_name == "set_current_preset_engine_models":
        return (
            "I can replace the selected model list for the named engine in the current visible preset draft, "
            "through the logged-in website tool bridge."
        )
    if tool_name == "execute_current_preset":
        return (
            "I can execute the current visible preset through the logged-in website workflow, "
            "through the logged-in website tool bridge."
        )
    return "I can run this website action through the logged-in website tool bridge."


def _choose_website_tool(user_message: str) -> str | None:
    text = user_message.lower()
    if _non_fpf_preset_builder_requested(user_message):
        return None
    if _preset_asset_concept_question(user_message):
        return None
    if _negated_write_capability_question(user_message):
        return None
    if _fpf_preset_from_scratch_requested(user_message):
        return "create_content_for_assistant"
    if _direct_content_update_requested(user_message):
        return "update_content_for_assistant"
    if _direct_content_create_requested(user_message):
        return "create_content_for_assistant"
    if _knowledge_manifest_requested(user_message):
        return "get_assistant_knowledge_manifest"
    if _available_actions_requested(user_message):
        return "get_available_assistant_actions"
    if _run_monitor_requested(user_message):
        return "get_run_status_summary"
    if _conditional_save_requested(user_message):
        return "get_current_preset_runnability"
    if _execute_requested(user_message):
        return "get_current_preset_runnability"
    if _save_requested(user_message):
        return "save_current_preset_draft"
    if _attach_generation_instructions_requested(user_message):
        return "attach_generation_instructions_to_current_preset"
    if _attach_input_document_requested(user_message):
        return "attach_input_document_to_current_preset"
    if _attach_eval_asset_requested(user_message):
        return "attach_eval_asset_to_current_preset"
    if _attach_combine_instructions_requested(user_message):
        return "attach_combine_instructions_to_current_preset"
    if _engine_toggle_requested(user_message):
        return "set_current_preset_engine"
    if _search_provider_selection_requested(user_message):
        return "set_current_preset_search_provider"
    if _model_selection_requested(user_message):
        return "set_current_preset_engine_models"
    if _iterations_selection_requested(user_message):
        return "set_current_preset_iterations"
    if _attached_content_review_requested(user_message):
        return "get_current_preset_content_assets"
    if _preset_next_action_requested(user_message):
        return "get_current_preset_runnability"
    if _content_comparison_requested(user_message):
        return "load_content_for_assistant"
    if _content_name_query(user_message):
        return "load_content_for_assistant"
    if _content_library_search_requested(user_message):
        return "search_content_library_for_assistant"
    if _current_preset_runnability_requested(user_message):
        return "get_current_preset_runnability"
    if any(
        token in text
        for token in (
            "full log",
            "full logs",
            "detailed log",
            "detailed logs",
            "load logs",
            "run logs",
            "all logs",
            "queue evidence",
            "worker evidence",
            "task evidence",
            "job evidence",
        )
    ):
        return "load_run_logs_for_assistant"
    if _recent_runs_requested(user_message):
        return "get_recent_runs_for_assistant"
    if _latest_run_context_requested(user_message):
        return "get_latest_run_context"
    if _load_run_requested(user_message):
        return "load_run_for_assistant"
    if any(token in text for token in ("run status", "latest run", "current run", "run state", "is the run", "what happened to the run")):
        return "get_run_status_summary"
    if any(token in text for token in ("output", "outputs", "generated", "document produced", "result document", "artifact")):
        return "get_run_output_summary"
    if any(token in text for token in ("failure", "failed", "error", "errors", "why did", "what went wrong", "crash", "exception")):
        return "get_run_failure_signals"
    if _comparison_requested(user_message) and _preset_name_query(user_message):
        return "load_preset_for_assistant"
    if _preset_name_query(user_message):
        return "load_preset_for_assistant"
    if any(
        token in text
        for token in (
            "list presets",
            "loaded presets",
            "available presets",
            "all presets",
            "what presets",
            "which presets",
            "show presets",
            "preset list",
        )
    ):
        return "get_loaded_preset_list"
    if _current_preset_documents_requested(user_message):
        return "get_current_preset_documents"
    if _current_preset_instructions_requested(user_message):
        return "get_current_preset_instructions"
    if any(
        token in text
        for token in (
            "content library",
            "list content",
            "available content",
            "input documents",
            "instruction files",
            "instructions library",
            "document library",
            "library documents",
        )
    ):
        return "get_content_library_summary"
    if any(
        token in text
        for token in (
            "attached content",
            "content assets",
            "preset assets",
            "instruction assets",
            "document assets",
            "attached instruction names",
            "attached document names",
        )
    ):
        return "get_current_preset_content_assets"
    if any(token in text for token in ("model", "models", "llm", "provider", "engine selections")):
        return "get_current_preset_models"
    if any(token in text for token in ("document", "documents", "input docs", "source docs", "source material", "attached files")):
        return "get_current_preset_documents"
    if any(
        token in text
        for token in (
            "instruction",
            "instructions",
            "prompt",
            "prompts",
            "generation instruction",
            "eval instruction",
            "pairwise instruction",
            "combine instruction",
        )
    ):
        return "get_current_preset_instructions"
    if _preset_requirements_requested(user_message):
        return "get_current_preset_requirements"
    if any(
        token in text
        for token in (
            "preset",
            "selected config",
            "current config",
            "configuration summary",
            "what is configured",
        )
    ):
        return "get_current_preset_summary"
    if _refresh_current_page_requested(user_message):
        return "refresh_current_page_data"
    if any(token in text for token in ("visible", "page state", "what can you see", "browser state")):
        return "get_visible_page_state"
    if any(token in text for token in ("route", "current page", "what page", "which page", "where am i", "where are we")):
        return "get_current_route_context"
    return None


def _current_preset_runnability_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(
        token in text
        for token in (
            "runnable",
            "runable",
            "will run",
            "will it run",
            "will this run",
            "will the current preset run",
            "will this preset run",
            "will the preset run",
            "whether it will run",
            "whether this will run",
            "can run",
            "can i run",
            "can this run",
            "can the current preset run",
            "can this preset run",
            "can the preset run",
            "ready to run",
            "safe to run",
            "execute",
            "execution blocker",
            "blocker",
            "blocking",
            "what blocks it",
            "what is blocking it",
            "what blocks this",
        )
    )


def _current_preset_documents_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("document", "documents", "input docs", "source docs", "source material", "attached files")):
        return False
    return any(token in text for token in ("current preset", "attached", "selected preset", "this preset"))


def _direct_content_create_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(_direct_content_action_clause(user_message)):
        return False
    if not any(token in text for token in ("create", "make", "write", "draft", "add", "new")):
        return False
    if "preset" in text and not any(token in text for token in ("content", "input document", "topic file", "generation instruction")):
        return False
    return _direct_content_type(user_message) is not None


def _negated_write_capability_question(user_message: str) -> bool:
    text = str(user_message).lower()
    return _write_action_negated(text) and any(
        token in text
        for token in ("would need", "need a website tool", "need tool", "would you need", "would this need")
    )


def _direct_content_update_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(_direct_content_action_clause(user_message)):
        return False
    if not any(token in text for token in ("update", "edit", "change", "revise", "replace", "rename", "move")):
        return False
    if not any(token in text for token in ("content", "instruction", "document", "topic file", "source material")):
        return False
    return _content_id_query(user_message) is not None


def _direct_content_action_clause(user_message: str) -> str:
    text = " ".join(str(user_message).strip().split()).lower()
    cut_markers = (
        " with the text ",
        " with text ",
        " with the body ",
        " with body ",
        " with the content ",
        " with content ",
        " containing ",
        " that says ",
    )
    cut_positions = [text.find(marker) for marker in cut_markers if text.find(marker) != -1]
    if cut_positions:
        return text[: min(cut_positions)]
    return text


def _refresh_current_page_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("refresh", "reload", "update")):
        return False
    return any(token in text for token in ("current page", "page data", "current data", "assistant-local data", "local data"))


def _current_preset_instructions_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(
        token in text
        for token in (
            "instruction",
            "instructions",
            "prompt",
            "prompts",
            "generation instruction",
            "eval instruction",
            "pairwise instruction",
            "combine instruction",
        )
    ):
        return False
    return any(token in text for token in ("current preset", "attached", "selected preset", "this preset"))


def _preset_requirements_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(
        token in text
        for token in (
            "requirement",
            "requirements",
            "missing pieces",
            "missing setup",
            "missing categories",
            "still need",
            "needs before",
            "need before",
            "what does it need",
            "what does this need",
            "what does the current preset need",
        )
    ):
        return False
    return any(token in text for token in ("current preset", "this preset", "preset", "what", "which", "show", "list", "missing"))


def _attach_generation_instructions_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if _attached_asset_read_question(text):
        return False
    if not _attach_action_requested(text, ("attach", "use", "select", "set")):
        return False
    return any(
        token in text
        for token in (
            "generation instruction",
            "generation instructions",
            "generation-instructions",
            "writing instruction",
            "research directive",
        )
    )


def _attach_input_document_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if _attached_asset_read_question(text):
        return False
    if not _attach_action_requested(text, ("attach", "use", "select", "add", "set")):
        return False
    return any(
        token in text
        for token in (
            "input document",
            "input doc",
            "topic file",
            "topic document",
            "source document",
            "source material",
            "document",
        )
    )


def _attach_action_requested(text: str, actions: tuple[str, ...]) -> bool:
    return any(re.search(rf"\b{re.escape(action)}\b", text) for action in actions)


def _attached_asset_read_question(text: str) -> bool:
    if "attached" not in text and "current preset" not in text:
        return False
    if not any(token in text for token in ("what", "which", "list", "show", "tell me", "summarize", "review")):
        return False
    return any(
        token in text
        for token in (
            "input document",
            "input documents",
            "document",
            "documents",
            "generation instruction",
            "generation instructions",
            "instruction",
            "instructions",
        )
    )


def _attach_eval_asset_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if not any(token in text for token in ("attach", "use", "select", "add", "set")):
        return False
    return any(
        token in text
        for token in (
            "single eval",
            "single-eval",
            "pairwise eval",
            "pairwise-eval",
            "eval instruction",
            "eval instructions",
            "evaluation instruction",
            "evaluation instructions",
            "eval criteria",
            "evaluation criteria",
            "rubric",
            "judge instruction",
            "judge instructions",
        )
    )


def _attach_combine_instructions_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if not any(token in text for token in ("attach", "use", "select", "add", "set")):
        return False
    return any(
        token in text
        for token in (
            "combine instruction",
            "combine instructions",
            "combine-instructions",
            "combine prompt",
            "combine prompts",
            "gold standard instruction",
            "gold standard instructions",
        )
    )


def _model_selection_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if not any(token in text for token in ("set", "select", "use", "change", "replace", "clear")):
        return False
    if not any(token in text for token in ("model", "models", "judge", "evaluator")):
        return False
    return _model_engine_query(user_message) is not None


def _engine_toggle_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if _model_selection_requested(user_message):
        return False
    if _model_engine_query(user_message) is None:
        return False
    return any(
        token in text
        for token in (
            "enable",
            "disable",
            "turn on",
            "turn off",
            "switch on",
            "switch off",
            "use ",
            "switch this preset to",
            "switch the preset to",
        )
    )


def _search_provider_selection_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if not any(token in text for token in ("search provider", "retrieval provider", "retriever")):
        return False
    if not any(token in text for token in ("set", "use", "change", "switch", "select")):
        return False
    return _search_provider_query(user_message) is not None


def _iterations_selection_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if _comparison_requested(user_message):
        return False
    if "iteration" not in text:
        return False
    if not any(token in text for token in ("set", "use", "change", "make", "increase", "decrease")):
        return False
    return _iteration_count(user_message) is not None


def _iteration_count(user_message: str) -> int | None:
    text = str(user_message).lower()
    digit_match = re.search(r"\b([1-3])\s+iterations?\b", text)
    if digit_match:
        return int(digit_match.group(1))
    reverse_digit_match = re.search(r"\biterations?\s+(?:to|at|=)?\s*([1-3])\b", text)
    if reverse_digit_match:
        return int(reverse_digit_match.group(1))
    word_values = {
        "one": 1,
        "two": 2,
        "three": 3,
    }
    for word, value in word_values.items():
        if re.search(rf"\b{word}\s+iterations?\b", text):
            return value
        if re.search(rf"\biterations?\s+(?:to|at|=)?\s*{word}\b", text):
            return value
    return None


def _tool_arguments(
    tool_name: str,
    state: AdvancedGraphState,
    *,
    supervisor_args: dict[str, object] | None = None,
) -> dict[str, object]:
    if tool_name in SHARED_TOOLS:
        return shared_arguments(tool_name, supervisor_args or {})
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    supervisor_args = supervisor_args if isinstance(supervisor_args, dict) else None
    if tool_name in {
        "get_loaded_preset_list",
    }:
        return _merge_supervisor_read_args(tool_name, {"limit": 100}, supervisor_args)
    if tool_name == "load_preset_for_assistant":
        return _merge_supervisor_read_args(tool_name, {
            "preset_id": None,
            "name_query": _preset_name_query(user_message),
        }, supervisor_args)
    if tool_name == "get_content_library_summary":
        return _merge_supervisor_read_args(tool_name, _content_library_arguments(user_message), supervisor_args)
    if tool_name == "search_content_library_for_assistant":
        if _repair_continuation_requested(user_message):
            return _repair_candidate_search_arguments(state)
        if _preset_next_action_requested(user_message):
            return _candidate_content_search_arguments(state)
        return _merge_supervisor_read_args(tool_name, _content_search_arguments(user_message), supervisor_args)
    if tool_name == "load_content_for_assistant":
        if _fpf_preset_from_scratch_requested(user_message):
            return _fpf_load_content_arguments(state)
        deep_read = _deep_content_read_requested(user_message)
        content_id = _content_id_query(user_message)
        history_reference = _recent_content_reference_arguments(state, user_message) if not content_id else {}
        name_query = _content_compare_query(user_message) if _content_comparison_requested(user_message) else _content_name_query(user_message)
        return _merge_supervisor_read_args(tool_name, {
            "content_id": content_id or history_reference.get("content_id"),
            "name_query": None if content_id else (name_query or history_reference.get("name_query")),
            "content_type": _content_type_hint(user_message),
            "include_body_excerpt": True,
            "max_chars": 12000 if deep_read else 1200,
            "deep_read": deep_read,
        }, supervisor_args)
    if tool_name == "create_content_for_assistant":
        return _create_content_arguments(state)
    if tool_name == "update_content_for_assistant":
        return _update_content_arguments(state)
    if tool_name == "start_new_preset_draft":
        return {"reason": "advanced_fpf_preset_from_scratch"}
    if tool_name == "configure_fpf_preset_draft":
        return _configure_fpf_preset_arguments(state)
    if tool_name == "get_current_preset_content_assets":
        return _merge_supervisor_read_args(tool_name, {"include_previews": True}, supervisor_args)
    if tool_name == "attach_generation_instructions_to_current_preset":
        return _attach_generation_instructions_arguments(state)
    if tool_name == "attach_input_document_to_current_preset":
        return _attach_input_document_arguments(state)
    if tool_name == "attach_eval_asset_to_current_preset":
        return _attach_eval_asset_arguments(state)
    if tool_name == "attach_combine_instructions_to_current_preset":
        return _attach_combine_instructions_arguments(state)
    if tool_name == "set_current_preset_engine":
        return _engine_toggle_arguments(state)
    if tool_name == "set_current_preset_search_provider":
        return _search_provider_arguments(state)
    if tool_name == "set_current_preset_engine_models":
        return _model_selection_arguments(state)
    if tool_name == "set_current_preset_iterations":
        return {"iterations": _iteration_count(user_message)}
    if tool_name == "get_recent_runs_for_assistant":
        return _merge_supervisor_read_args(tool_name, {"limit": 10}, supervisor_args)
    if tool_name == "get_latest_run_context":
        return _merge_supervisor_read_args(
            tool_name,
            {"include_failure_signals": True, "include_output_summary": True},
            supervisor_args,
        )
    if tool_name == "load_run_for_assistant":
        return _merge_supervisor_read_args(tool_name, {"run_id": _run_id_query(user_message)}, supervisor_args)
    if tool_name in {
        "get_current_preset_summary",
        "get_current_preset_runnability",
        "get_current_preset_requirements",
        "get_current_preset_models",
        "get_current_preset_documents",
        "get_current_preset_instructions",
        "save_current_preset_draft",
        "execute_current_preset",
    }:
        page_context = state.get("page_context")
        preset_id = page_context.get("active_preset_id") if isinstance(page_context, dict) else None
        args: dict[str, object] = {
            "preset_id": preset_id if isinstance(preset_id, str) and preset_id else None,
            "use_visible_draft_if_available": True,
        }
        if tool_name == "save_current_preset_draft":
            args["verify_after_save"] = True
        if tool_name == "execute_current_preset":
            args["preflight_required"] = True
        if tool_name == "get_current_preset_documents":
            args["include_document_names"] = True
        if tool_name == "get_current_preset_instructions":
            args["include_titles"] = True
        return _merge_supervisor_read_args(tool_name, args, supervisor_args)
    if tool_name in {"get_run_status_summary", "get_run_failure_signals", "get_run_output_summary", "load_run_logs_for_assistant"}:
        page_context = state.get("page_context")
        started_run_id = _started_run_id(state.get("tool_results") or _tool_results(state.get("messages") or []))
        context_run_id = page_context.get("current_run_id") if isinstance(page_context, dict) else None
        run_id = started_run_id or context_run_id
        args = {"run_id": run_id if isinstance(run_id, str) and run_id else None}
        if tool_name == "get_run_failure_signals":
            args["classification"] = "event"
        if tool_name == "load_run_logs_for_assistant":
            user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
            args["classification"] = "all" if _wants_all_logs(user_message) else "event"
            args["limit"] = 300 if args["classification"] == "all" else 200
        if tool_name == "get_run_output_summary":
            args["include_document_titles"] = True
        return _merge_supervisor_read_args(tool_name, args, supervisor_args)
    return {}


def _merge_supervisor_read_args(
    tool_name: str,
    base_args: dict[str, object],
    supervisor_args: dict[str, object] | None,
) -> dict[str, object]:
    """Merge sanitized supervisor arguments for read-only tools only."""
    if not supervisor_args:
        return base_args
    if tool_name in DETERMINISTIC_WRITE_OR_WORKFLOW_TOOLS:
        return base_args
    merged = dict(base_args)
    for key, value in supervisor_args.items():
        if value is None:
            continue
        # Preserve visible-page defaults unless the supervisor has a concrete id.
        if key == "preset_id" and not value:
            continue
        if key == "run_id" and not value:
            continue
        if key == "content_id" and not value:
            continue
        if key == "name_query" and not value:
            continue
        merged[key] = value
    return merged


def _attach_generation_instructions_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if _best_candidate_attach_requested(user_message, "generation_instructions"):
        candidate_item = _best_candidate_content(_tool_results(state.get("messages") or []), "generation_instructions")
        if isinstance(candidate_item, dict):
            candidate_id = candidate_item.get("id")
            candidate_name = candidate_item.get("name")
            return {
                "instruction_id": candidate_id if isinstance(candidate_id, str) else None,
                "content_id": candidate_id if isinstance(candidate_id, str) else None,
                "name_query": candidate_name if isinstance(candidate_name, str) else None,
            }
    recent_reference = _recent_content_reference_arguments(state, user_message)
    if recent_reference:
        return {
            "instruction_id": recent_reference.get("content_id"),
            "content_id": recent_reference.get("content_id"),
            "name_query": recent_reference.get("name_query"),
        }
    candidate = _content_compare_query(user_message) or _quoted_query(user_message) or _attach_name_query(user_message)
    instruction_id = _content_id_query(user_message)
    return {
        "instruction_id": instruction_id,
        "content_id": instruction_id,
        "name_query": candidate,
    }


def _create_content_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if _direct_content_create_requested(user_message) and not _fpf_preset_from_scratch_requested(user_message):
        return _direct_content_create_arguments(user_message)
    tool_results = _tool_results(state.get("messages") or [])
    goal = _fpf_preset_goal(user_message)
    preset_name = _fpf_preset_name(goal)
    if not _created_content_result(tool_results, "generation_instructions"):
        return {
            "name": f"{preset_name} - FPF Generation Instructions",
            "content_type": "generation_instructions",
            "description": f"Generation instructions created by the advanced assistant for an FPF preset about {goal}.",
            "folder_path": "/assistant-created/fpf",
            "tags": ["assistant-created", "fpf", "generation-instructions"],
            "body": _fpf_generation_instructions_body(user_message),
        }
    return {
        "name": f"{preset_name} - Topic Brief",
        "content_type": "input_document",
        "description": f"Input topic brief created by the advanced assistant for an FPF preset about {goal}.",
        "folder_path": "/assistant-created/fpf",
        "tags": ["assistant-created", "fpf", "input-document", "topic-brief"],
        "body": _fpf_input_document_body(user_message),
    }


def _direct_content_create_arguments(user_message: str) -> dict[str, object]:
    content_type = _direct_content_type(user_message) or "input_document"
    name = _direct_content_name(user_message) or _direct_content_default_name(user_message, content_type)
    body = _direct_content_body(user_message) or _direct_content_default_body(user_message, content_type)
    tag_type = content_type.replace("_", "-")
    folder_path = _direct_content_folder_path(user_message) or "/assistant-created/direct"
    tags = _direct_content_tags(user_message) or ["assistant-created", "direct-create", tag_type]
    description = _direct_content_description(user_message) or "Created by the advanced assistant from a direct content-library request."
    return {
        "name": name,
        "content_type": content_type,
        "description": description,
        "folder_path": folder_path,
        "tags": tags,
        "body": body,
    }


def _direct_content_type(user_message: str) -> str | None:
    text = str(user_message).lower()
    if any(token in text for token in ("generation instruction", "generation instructions", "instruction file", "instructions file", "writing instruction", "writing instructions")):
        return "generation_instructions"
    if any(token in text for token in ("input document", "input doc", "topic file", "topic document", "source document", "source material")):
        return "input_document"
    return None


def _direct_content_name(user_message: str) -> str | None:
    text = " ".join(str(user_message).strip().split())
    patterns = (
        r"\brename\s+content\s+id\s+\S+\s+to\s+(.+?)(?:,\s*(?:move|set|tag|with|and)\b|\s+and\s+(?:move|set|tag)\b|[.!?]?$)",
        r"\brename\s+.+?\s+to\s+(.+?)(?:,\s*(?:move|set|tag|with|and)\b|\s+and\s+(?:move|set|tag)\b|[.!?]?$)",
        r"\bname\s+content\s+id\s+\S+\s+(.+?)(?:[.!?]?$)",
        r"\bnamed\s+(.+?)(?:\s+with\s+(?:the\s+)?(?:text|body|content)\b|\s+containing\b|\s+that says\b|[.!?]?$)",
        r"\bcalled\s+(.+?)(?:\s+with\s+(?:the\s+)?(?:text|body|content)\b|\s+containing\b|\s+that says\b|[.!?]?$)",
        r"\btitled\s+(.+?)(?:\s+with\s+(?:the\s+)?(?:text|body|content)\b|\s+containing\b|\s+that says\b|[.!?]?$)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            candidate = match.group(1).strip(" .,?!:\"'")
            if candidate:
                return _compact_text(candidate, limit=120)
    quoted = _quoted_query(user_message)
    if quoted:
        return quoted
    return None


def _direct_content_body(user_message: str) -> str | None:
    text = " ".join(str(user_message).strip().split())
    patterns = (
        r"\bwith\s+(?:the\s+)?text\s+(.+)$",
        r"\bwith\s+(?:the\s+)?body\s+(.+)$",
        r"\bwith\s+(?:the\s+)?content\s+(.+)$",
        r"\bcontaining\s+(.+)$",
        r"\bthat says\s+(.+)$",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            candidate = match.group(1).strip()
            candidate = re.split(
                r",\s*(?:in|to|under)\s+folder\b|,\s*with\s+tags?\b|,\s*set\s+tags?\b|,\s*description\b|\s+and\s+set\s+tags?\b",
                candidate,
                maxsplit=1,
                flags=re.IGNORECASE,
            )[0].strip()
            candidate = re.sub(r"^[:\-]\s*", "", candidate).strip(" \"'")
            if candidate:
                return candidate
    return None


def _direct_content_description(user_message: str) -> str | None:
    text = " ".join(str(user_message).strip().split())
    patterns = (
        r"\bdescription\s+to\s+(.+)$",
        r"\bset\s+(?:the\s+)?description\s+to\s+(.+)$",
        r"\bwith\s+(?:the\s+)?description\s+(.+)$",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            candidate = match.group(1).strip()
            candidate = re.sub(r"^[:\-]\s*", "", candidate).strip(" \"'")
            if candidate:
                return candidate
    return None


def _direct_content_folder_path(user_message: str) -> str | None:
    text = " ".join(str(user_message).strip().split())
    patterns = (
        r"\bto\s+folder\s+(\S+)",
        r"\bfolder\s+to\s+(\S+)",
        r"\bin\s+folder\s+(\S+)",
        r"\bunder\s+folder\s+(\S+)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            candidate = match.group(1).strip(" .,?!:\"'")
            if candidate:
                return candidate[:240]
    return None


def _direct_content_tags(user_message: str) -> list[str]:
    text = " ".join(str(user_message).strip().split())
    patterns = (
        r"\btags?\s+to\s+(.+)$",
        r"\bset\s+(?:the\s+)?tags?\s+to\s+(.+)$",
        r"\bwith\s+(?:the\s+)?tags?\s+(.+)$",
        r"\btag\s+(?:it|content)?\s*(?:as|with)?\s+(.+)$",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        candidate = match.group(1).strip(" .?!:\"'")
        if not candidate:
            continue
        parts = [
            part.strip(" .?!:\"'")
            for part in re.split(r"\s*(?:,|\band\b)\s*", candidate)
            if part.strip(" .?!:\"'")
        ]
        return _unique_nonempty(parts)[:24]
    return []


def _direct_content_default_name(user_message: str, content_type: str) -> str:
    body = _direct_content_body(user_message) or _fpf_preset_goal(user_message)
    suffix = "Generation Instructions" if content_type == "generation_instructions" else "Topic Brief"
    return f"{_compact_text(body, limit=80)} - {suffix}"


def _direct_content_default_body(user_message: str, content_type: str) -> str:
    goal = _fpf_preset_goal(user_message)
    if content_type == "generation_instructions":
        return (
            f"Generate a clear, useful response about {goal}. "
            "Use only the attached input material as the source boundary, preserve uncertainty, "
            "and avoid inventing unsupported facts."
        )
    return goal


def _update_content_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if _direct_content_update_requested(user_message):
        return _direct_content_update_arguments(user_message)
    tool_results = _tool_results(state.get("messages") or [])
    content_type = "generation_instructions"
    if _updated_created_content_result(tool_results, "generation_instructions") or (
        _loaded_created_content_result(tool_results, "input_document")
        and _fpf_created_content_needs_improvement(tool_results, "input_document")
    ):
        content_type = "input_document"
    loaded = _loaded_created_content_result(tool_results, content_type)
    created = _created_content_result(tool_results, content_type)
    content_id = _content_result_id(created)
    content = loaded.get("content") if isinstance(loaded, dict) else None
    current_body = content.get("body_excerpt") if isinstance(content, dict) else ""
    improved_body = _fpf_improved_content_body(
        user_message,
        current_body if isinstance(current_body, str) else "",
        content_type,
    )
    return {
        "content_id": content_id,
        "body": improved_body,
        "description": f"Improved by the advanced assistant after a doctrine quality read-back pass for {content_type}.",
        "tags": ["assistant-created", "fpf", "quality-improved", content_type],
    }


def _direct_content_update_arguments(user_message: str) -> dict[str, object]:
    args: dict[str, object] = {
        "content_id": _content_id_query(user_message),
    }
    body = _direct_content_body(user_message)
    if body:
        args["body"] = body
    name = _direct_content_name(user_message)
    if name:
        args["name"] = name
    description = _direct_content_description(user_message)
    if description:
        args["description"] = description
    else:
        args["description"] = "Updated by the advanced assistant from a direct content-library request."
    folder_path = _direct_content_folder_path(user_message)
    if folder_path:
        args["folder_path"] = folder_path
    tags = _direct_content_tags(user_message)
    args["tags"] = tags if tags else ["assistant-updated", "direct-update"]
    return args


def _configure_fpf_preset_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    tool_results = _tool_results(state.get("messages") or [])
    goal = _fpf_preset_goal(user_message)
    generation_content = _created_content_result(tool_results, "generation_instructions")
    input_content = _created_content_result(tool_results, "input_document")
    generation_id = _content_result_id(generation_content)
    input_id = _content_result_id(input_content)
    return {
        "preset_name": _fpf_preset_name(goal),
        "run_description": f"FPF preset created by the advanced assistant for: {goal}",
        "generation_instructions_id": generation_id,
        "input_document_ids": [input_id] if input_id else [],
        "model": "openai:gpt-5-mini",
    }


def _attach_input_document_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if _best_candidate_attach_requested(user_message, "input_document"):
        candidate_item = _best_candidate_content(_tool_results(state.get("messages") or []), "input_document")
        if isinstance(candidate_item, dict):
            candidate_id = candidate_item.get("id")
            candidate_name = candidate_item.get("name")
            return {
                "document_id": candidate_id if isinstance(candidate_id, str) else None,
                "content_id": candidate_id if isinstance(candidate_id, str) else None,
                "name_query": candidate_name if isinstance(candidate_name, str) else None,
            }
    candidate = _content_compare_query(user_message) or _quoted_query(user_message) or _attach_name_query(user_message)
    document_id = _content_id_query(user_message)
    return {
        "document_id": document_id,
        "content_id": document_id,
        "name_query": candidate,
    }


def _attach_eval_asset_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    content_id = _content_id_query(user_message)
    content_type = _eval_asset_content_type(user_message)
    return {
        "instruction_id": content_id,
        "criteria_id": content_id,
        "content_id": content_id,
        "name_query": _content_compare_query(user_message) or _quoted_query(user_message) or _attach_name_query(user_message),
        "content_type": content_type,
        "kind": content_type,
    }


def _eval_asset_content_type(user_message: str) -> str | None:
    text = str(user_message).lower()
    if "pairwise" in text:
        return "pairwise_eval_instructions"
    if "single" in text:
        return "single_eval_instructions"
    if "criteria" in text or "criterion" in text or "rubric" in text:
        return "eval_criteria"
    if "eval" in text or "evaluation" in text or "judge" in text:
        return "single_eval_instructions"
    return None


def _attach_combine_instructions_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    instruction_id = _content_id_query(user_message)
    return {
        "instruction_id": instruction_id,
        "content_id": instruction_id,
        "name_query": _content_compare_query(user_message) or _quoted_query(user_message) or _attach_name_query(user_message),
    }


def _model_selection_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    return {
        "engine": _model_engine_query(user_message),
        "models": _model_list_query(user_message),
    }


def _engine_toggle_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    text = str(user_message).lower()
    disabled = any(token in text for token in ("disable", "turn off", "switch off"))
    return {
        "engine": _model_engine_query(user_message),
        "enabled": not disabled,
    }


def _search_provider_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    return {
        "provider": _search_provider_query(user_message),
    }


def _search_provider_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    for quote in ('"', "'"):
        if quote in text:
            parts = text.split(quote)
            for index in range(1, len(parts), 2):
                candidate = parts[index].strip()
                if candidate:
                    return candidate[:80]
    lower = text.lower()
    markers = (
        "search provider to ",
        "retrieval provider to ",
        "retriever to ",
        "use search provider ",
        "use retrieval provider ",
        "use retriever ",
        "switch search provider to ",
        "switch retrieval provider to ",
        "switch retriever to ",
        "change search provider to ",
        "change retrieval provider to ",
        "change retriever to ",
    )
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = _trim_trailing_instruction_clause(text[start + len(marker):]).strip(" .?!:")
        if candidate:
            return candidate[:80]
    return None


def _model_engine_query(user_message: str) -> str | None:
    text = str(user_message).lower().replace("-", "_")
    aliases = (
        ("translation_agent", ("translation_agent", "translation agent", "translationagent")),
        ("pdfmathtranslate", ("pdfmathtranslate", "pdf_math_translate", "pdf math translate")),
        ("msagent", ("msagent", "ms_agent", "ms agent")),
        ("gptr", ("gptr", "gpt_researcher", "gpt researcher")),
        ("dr", ("deep_research", "deep research", "dr")),
        ("aiq", ("aiq", "ai question", "aiq")),
        ("fpf", ("file_prompt_forge", "file prompt forge", "fpf")),
        ("owl", ("owl",)),
        ("marian", ("marian",)),
        ("eval", ("evaluation", "evaluator", "judge", "eval")),
        ("combine", ("gold_standard", "gold standard", "combine")),
    )
    for engine, tokens in aliases:
        if any(token in text for token in tokens):
            return engine
    return None


def _model_list_query(user_message: str) -> list[str]:
    text = str(user_message)
    quoted = [
        match.group(1) or match.group(2)
        for match in re.finditer(r'"([^"]+)"|`([^`]+)`', text)
    ]
    models = []
    for item in quoted:
        models.extend(_split_model_tokens(item))
    if models:
        return _unique_nonempty(models)[:12]

    lower = text.lower()
    for marker in (" models to ", " model to ", " judges to ", " judge to ", " evaluators to ", " evaluator to ", " use "):
        index = lower.find(marker)
        if index == -1:
            continue
        tail = text[index + len(marker):]
        tail = re.split(r"\b(?:for|on|in)\b", tail, maxsplit=1, flags=re.IGNORECASE)[0]
        models = _split_model_tokens(tail)
        if models:
            return _unique_nonempty(models)[:12]
    return []


def _split_model_tokens(value: str) -> list[str]:
    cleaned = str(value).strip(" .?!:")
    if not cleaned:
        return []
    return [
        part.strip(" .?!:")
        for part in re.split(r"\s*(?:,|\band\b)\s*", cleaned)
        if part.strip(" .?!:")
    ]


def _unique_nonempty(values: list[str]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        normalized = str(value).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _content_id_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    lower = text.lower()
    markers = (
        "content id ",
        "content_id ",
        "instruction id ",
        "instruction_id ",
        "id ",
    )
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = text[start + len(marker):].strip(" .,?!:")
        if candidate:
            return candidate.split()[0][:120].strip(",.;:")
    return None


def _attach_name_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    lower = text.lower()
    markers = (
        "named ",
        "called ",
        "instruction named ",
        "instructions named ",
        "document named ",
        "content named ",
    )
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = _trim_trailing_instruction_clause(text[start + len(marker):])
        candidate = re.split(r"\b(?:to|into|onto|for)\s+(?:the\s+)?current preset\b", candidate, maxsplit=1, flags=re.IGNORECASE)[0]
        candidate = candidate.strip(" .?!:")
        if candidate:
            return candidate[:120]
    return None


def _follow_up_website_tool(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str | None:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    tool_names = {
        result.get("tool_name")
        for result in tool_results
        if isinstance(result.get("tool_name"), str)
    }
    if _fpf_preset_from_scratch_requested(user_message):
        follow_up_tool = _fpf_preset_from_scratch_follow_up(user_message, tool_results, tool_names)
        if follow_up_tool:
            return follow_up_tool
    if _repair_best_candidate_attach_requested(user_message):
        candidate = _best_candidate_content(tool_results, "input_document")
        if candidate and "attach_input_document_to_current_preset" not in tool_names:
            return "attach_input_document_to_current_preset"
        return None
    if _repair_continuation_requested(user_message):
        repair_tool = _repair_continuation_tool(tool_results, tool_names)
        if repair_tool:
            return repair_tool
        if _repair_candidate_search_needed(tool_results):
            return "search_content_library_for_assistant"
        return None
    if _run_monitor_requested(user_message):
        latest_status = _latest_run_status_result(tool_results)
        latest_tool_name = tool_results[-1].get("tool_name") if tool_results else None
        if latest_tool_name == "get_run_status_summary":
            return "load_run_logs_for_assistant"
        if latest_tool_name == "load_run_logs_for_assistant" and isinstance(latest_status, dict) and _run_is_terminal_from_status(latest_status):
            terminal_follow_up_tool = _terminal_run_follow_up_tool(tool_results, tool_names)
            if terminal_follow_up_tool:
                return terminal_follow_up_tool
            terminal_repair_tool = _terminal_repair_follow_up_tool(tool_results, tool_names)
            if terminal_repair_tool:
                return terminal_repair_tool
        return None
    if _conditional_save_requested(user_message):
        if "save_current_preset_draft" in tool_names:
            return None
        runnability = _result_for_tool(tool_results, "get_current_preset_runnability")
        if isinstance(runnability, dict) and _runnability_allows_save(runnability):
            return "save_current_preset_draft"
        return None
    if _execute_requested(user_message):
        execute_result = _result_for_tool(tool_results, "execute_current_preset")
        if isinstance(execute_result, dict):
            started_run_id = _started_run_id(tool_results)
            if started_run_id and "get_run_status_summary" not in tool_names:
                return "get_run_status_summary"
            if started_run_id and "load_run_logs_for_assistant" not in tool_names:
                return "load_run_logs_for_assistant"
            terminal_follow_up_tool = _terminal_run_follow_up_tool(tool_results, tool_names)
            if started_run_id and terminal_follow_up_tool:
                return terminal_follow_up_tool
            terminal_repair_tool = _terminal_repair_follow_up_tool(tool_results, tool_names)
            if started_run_id and terminal_repair_tool:
                return terminal_repair_tool
            if started_run_id and _run_monitoring_should_continue(tool_results):
                status_count = len(_run_status_results(tool_results))
                log_count = len(_run_log_results(tool_results))
                if status_count <= log_count and status_count < RUN_MONITOR_STATUS_POLL_LIMIT:
                    return "get_run_status_summary"
                if log_count < status_count and log_count < RUN_MONITOR_LOG_POLL_LIMIT:
                    return "load_run_logs_for_assistant"
            return None
        runnability = _result_for_tool(tool_results, "get_current_preset_runnability")
        if isinstance(runnability, dict) and _runnability_allows_save(runnability):
            return "execute_current_preset"
        return None
    if _content_comparison_requested(user_message):
        if "load_content_for_assistant" in tool_names and "get_current_preset_summary" not in tool_names:
            return "get_current_preset_summary"
        if "get_current_preset_summary" in tool_names and "load_content_for_assistant" not in tool_names:
            return "load_content_for_assistant"
        return None
    if _attached_content_review_requested(user_message):
        if "get_current_preset_content_assets" in tool_names and "get_current_preset_summary" not in tool_names:
            return "get_current_preset_summary"
        if "get_current_preset_summary" in tool_names and "get_current_preset_content_assets" not in tool_names:
            return "get_current_preset_content_assets"
        return None
    if _preset_next_action_requested(user_message):
        if "get_current_preset_runnability" not in tool_names:
            return "get_current_preset_runnability"
        if "get_current_preset_content_assets" not in tool_names:
            return "get_current_preset_content_assets"
        if "get_current_preset_summary" not in tool_names:
            return "get_current_preset_summary"
        if _candidate_content_search_needed(tool_results):
            return "search_content_library_for_assistant"
        return None
    if not _comparison_requested(user_message):
        return None
    if "load_preset_for_assistant" in tool_names and "get_current_preset_summary" not in tool_names:
        return "get_current_preset_summary"
    if "get_current_preset_summary" in tool_names and "load_preset_for_assistant" not in tool_names:
        return "load_preset_for_assistant"
    return None


def _latest_tool_result(messages: list[dict[str, object]]) -> dict[str, object] | None:
    results = _tool_results(messages)
    return results[-1] if results else None


def _tool_results(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for message in reversed(messages):
        if message.get("role") != "tool":
            continue
        content = message.get("content")
        if not isinstance(content, str):
            continue
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed.get("type") == "tool_result":
            results.append(parsed)
    return list(reversed(results))


def _fpf_preset_from_scratch_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _non_fpf_preset_builder_requested(user_message):
        return False
    if _write_action_negated(text) and not _only_execution_negated(text):
        return False
    if not any(token in text for token in ("create", "make", "build", "set up", "setup", "draft")):
        return False
    if not any(token in text for token in ("preset", "fpf", "file prompt forge", "file-prompt-forge")):
        return False
    return any(token in text for token in ("from scratch", "new preset", "new fpf", "for ", "about ", "on "))


def _non_fpf_preset_builder_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text) and not _only_execution_negated(text):
        return False
    if not any(token in text for token in ("create", "make", "build", "set up", "setup", "draft")):
        return False
    if "preset" not in text:
        return False
    return any(
        token in text
        for token in (
            "deep research",
            "deep-research",
            "gpt researcher",
            "gpt-researcher",
            "gptr",
            "aiq",
            "ms-agent",
            "ms agent",
            "dr preset",
            "research agent",
        )
    )


def _only_execution_negated(text: str) -> bool:
    if not any(
        token in text
        for token in (
            "do not execute",
            "don't execute",
            "dont execute",
            "do not run",
            "don't run",
            "dont run",
            "not execute",
            "not run",
            "do not start",
            "don't start",
            "dont start",
            "not yet",
        )
    ):
        return False
    return not any(
        token in text
        for token in (
            "do not create",
            "don't create",
            "dont create",
            "do not make",
            "don't make",
            "dont make",
            "do not build",
            "don't build",
            "dont build",
            "read only",
            "read-only",
            "recommendation only",
            "recommend only",
            "just recommend",
            "only recommend",
        )
    )


def _non_fpf_preset_builder_response(state: AdvancedGraphState) -> str:
    route = _route_label(state.get("page_context"))
    user_message = _compact_text(state.get("current_user_message") or "")
    parts = [
        "I understand the request as preset creation, but it is outside the advanced builder that is wired today.",
        "Current implemented builder: FPF preset-from-scratch only, using `openai:gpt-5-mini`, one generated instruction asset, one generated input-document asset, a clean draft, save, and verification.",
        "Not implemented yet: Deep Research, GPT Researcher, AIQ, MS-Agent, DR, eval, combine, translation, OWL, Marian, or PDF translation preset creation.",
        "So I should not auto-create a Deep Research preset from this request yet, and I should not pretend that an FPF preset is the same thing.",
    ]
    if route:
        parts.append(f"Current website context: {route}.")
    if user_message:
        parts.append(f"Received request: {user_message}")
    parts.append(
        "Safe next options: ask me to create an FPF starter preset for the topic, or have an engineer add the Deep Research preset-builder workflow and website tools next."
    )
    parts.append(
        "No database key, browser session token, provider key, or raw backend API power was passed into the graph."
    )
    return "\n\n".join(parts)


def _fpf_preset_from_scratch_follow_up(
    user_message: str,
    tool_results: list[dict[str, object]],
    tool_names: set[object],
) -> str | None:
    failed_create_repair = _fpf_failed_tool_repair(tool_results, "create_content_for_assistant", max_attempts=2)
    if failed_create_repair:
        return failed_create_repair
    failed_update_repair = _fpf_failed_tool_repair(tool_results, "update_content_for_assistant", max_attempts=2)
    if failed_update_repair:
        return failed_update_repair
    failed_save_repair = _fpf_failed_tool_repair(tool_results, "save_current_preset_draft", max_attempts=2)
    if failed_save_repair:
        return failed_save_repair
    if _fpf_verification_contradiction(tool_results) and _tool_count(tool_results, "configure_fpf_preset_draft") < 2:
        return "configure_fpf_preset_draft"
    if _fpf_verification_contradiction(tool_results) and _tool_count(tool_results, "save_current_preset_draft") < 2:
        return "save_current_preset_draft"
    if _fpf_verification_contradiction(tool_results):
        for verification_tool in (
            "get_current_preset_runnability",
            "get_current_preset_summary",
            "get_current_preset_models",
            "get_current_preset_documents",
            "get_current_preset_instructions",
            "get_current_preset_content_assets",
        ):
            if _tool_count(tool_results, verification_tool) < 2:
                return verification_tool
    if not _created_content_result(tool_results, "generation_instructions"):
        return "create_content_for_assistant"
    if not _loaded_created_content_result(tool_results, "generation_instructions"):
        return "load_content_for_assistant"
    if _fpf_created_content_needs_improvement(tool_results, "generation_instructions"):
        return "update_content_for_assistant"
    if not _created_content_result(tool_results, "input_document"):
        return "create_content_for_assistant"
    if not _loaded_created_content_result(tool_results, "input_document"):
        return "load_content_for_assistant"
    if _fpf_created_content_needs_improvement(tool_results, "input_document"):
        return "update_content_for_assistant"
    if "start_new_preset_draft" not in tool_names:
        return "start_new_preset_draft"
    if "configure_fpf_preset_draft" not in tool_names:
        return "configure_fpf_preset_draft"
    if "save_current_preset_draft" not in tool_names:
        return "save_current_preset_draft"
    for verification_tool in (
        "get_current_preset_runnability",
        "get_current_preset_summary",
        "get_current_preset_models",
        "get_current_preset_documents",
        "get_current_preset_instructions",
        "get_current_preset_content_assets",
    ):
        if verification_tool not in tool_names:
            return verification_tool
    if _execute_requested(user_message) and "execute_current_preset" not in tool_names:
        return "execute_current_preset"
    if _execute_requested(user_message):
        execute_result = _result_for_tool(tool_results, "execute_current_preset")
        if isinstance(execute_result, dict):
            started_run_id = _started_run_id(tool_results)
            if started_run_id and "get_run_status_summary" not in tool_names:
                return "get_run_status_summary"
            if started_run_id and "load_run_logs_for_assistant" not in tool_names:
                return "load_run_logs_for_assistant"
    return None


def _fpf_preset_goal(user_message: str) -> str:
    text = " ".join(str(user_message).strip().split())
    if not text:
        return "the requested topic"
    lower = text.lower()
    markers = (
        "from scratch for ",
        "from scratch about ",
        "fpf preset for ",
        "fpf preset about ",
        "preset for ",
        "preset about ",
        "about ",
        "for ",
    )
    for marker in markers:
        index = lower.find(marker)
        if index == -1:
            continue
        candidate = text[index + len(marker):].strip(" .?!:")
        candidate = re.sub(r"\b(?:and )?(?:run|execute|test|launch) (?:it|the preset)\b.*$", "", candidate, flags=re.IGNORECASE).strip(" .?!:")
        if candidate:
            return _compact_text(candidate, limit=180)
    return _compact_text(text, limit=180)


def _fpf_goal_profile(user_message: str) -> dict[str, object]:
    goal = _fpf_preset_goal(user_message)
    text = " ".join(str(user_message).strip().split())
    lower = text.lower()
    audience = _extract_after_markers(text, ("for an audience of ", "for audience ", "audience:", "audience ")) or "informed general reader"
    tone = _extract_after_markers(text, ("in a ", "with a ", "tone:", "tone ")) if "tone" in lower or " in a " in lower or " with a " in lower else None
    length = _extract_after_markers(text, ("about ", "around ", "roughly ", "length:", "length ")) if any(token in lower for token in ("pages", "words", "paragraphs", "length:")) else None
    sections = _extract_after_markers(text, ("sections:", "include sections ", "include sections:", "required sections:", "with sections "))
    constraints = _extract_after_markers(text, ("constraints:", "constraint:", "must ", "must include ", "must not "))
    source_assumptions = _extract_after_markers(text, ("using sources ", "source assumptions:", "sources:", "source material:", "from sources "))
    return {
        "goal": goal,
        "audience": _compact_text(audience or "informed general reader", limit=160),
        "tone": _compact_text(tone or "clear, practical, and source-grounded", limit=160),
        "length": _compact_text(length or "as long as needed to satisfy the requested structure without padding", limit=160),
        "sections": _split_profile_list(sections) if sections else [
            "answer-first summary",
            "main analysis",
            "practical implications",
            "uncertainties and missing information",
        ],
        "constraints": _split_profile_list(constraints) if constraints else [
            "stay inside the attached input document",
            "label assumptions and missing details",
            "do not invent citations or external research",
        ],
        "source_assumptions": _compact_text(source_assumptions or "the initial topic brief is thin until the user adds richer source material", limit=220),
    }


def _extract_after_markers(text: str, markers: tuple[str, ...]) -> str | None:
    lower = text.lower()
    for marker in markers:
        index = lower.find(marker)
        if index == -1:
            continue
        candidate = text[index + len(marker):].strip(" .?!:")
        candidate = re.split(r"\b(?:and make|and create|and run|and execute|for |about )\b", candidate, maxsplit=1, flags=re.IGNORECASE)[0].strip(" .?!:")
        if candidate:
            return candidate[:240]
    return None


def _split_profile_list(value: object) -> list[str]:
    if not isinstance(value, str) or not value.strip():
        return []
    parts = re.split(r"\s*(?:,|;|\band\b)\s*", value)
    return [part.strip(" .?!:") for part in parts if part.strip(" .?!:")][:8]


def _fpf_preset_name(goal: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 ,._-]+", "", str(goal)).strip(" ,._-")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        cleaned = "Assistant Created Topic"
    words = cleaned.split()
    short = " ".join(words[:10])
    return f"FPF - {short}"[:100]


def _created_content_result(tool_results: list[dict[str, object]], content_type: str) -> dict[str, object] | None:
    for tool_result in reversed(tool_results):
        if tool_result.get("tool_name") != "create_content_for_assistant":
            continue
        result = tool_result.get("result")
        if not isinstance(result, dict) or result.get("status") != "created":
            continue
        content = result.get("content")
        if isinstance(content, dict) and content.get("content_type") == content_type:
            return result
    return None


def _content_result_id(result: object) -> str | None:
    if not isinstance(result, dict):
        return None
    content = result.get("content")
    if isinstance(content, dict):
        content_id = content.get("id")
        if isinstance(content_id, str) and content_id:
            return content_id
    content_id = result.get("id")
    return content_id if isinstance(content_id, str) and content_id else None


def _tool_count(tool_results: list[dict[str, object]], tool_name: str) -> int:
    return sum(1 for result in tool_results if result.get("tool_name") == tool_name)


def _fpf_failed_tool_repair(
    tool_results: list[dict[str, object]],
    tool_name: str,
    *,
    max_attempts: int,
) -> str | None:
    if _tool_count(tool_results, tool_name) >= max_attempts:
        return None
    latest = None
    for tool_result in reversed(tool_results):
        if tool_result.get("tool_name") == tool_name:
            latest = tool_result.get("result")
            break
    if not isinstance(latest, dict):
        return None
    status = latest.get("status")
    if status in {"created", "updated", "configured", "started_new_draft", "started", "saved", "loaded"}:
        return None
    if tool_name == "create_content_for_assistant":
        return "create_content_for_assistant"
    if tool_name == "update_content_for_assistant":
        return "update_content_for_assistant"
    if tool_name == "save_current_preset_draft":
        if _tool_after_latest(tool_results, "get_current_preset_runnability", "save_current_preset_draft"):
            return "save_current_preset_draft"
        return "get_current_preset_runnability"
    return None


def _tool_after_latest(tool_results: list[dict[str, object]], target_tool: str, after_tool: str) -> bool:
    latest_after_index = -1
    for index, tool_result in enumerate(tool_results):
        if tool_result.get("tool_name") == after_tool:
            latest_after_index = index
    if latest_after_index < 0:
        return False
    return any(
        tool_result.get("tool_name") == target_tool
        for tool_result in tool_results[latest_after_index + 1 :]
    )


def _fpf_verification_contradiction(tool_results: list[dict[str, object]]) -> bool:
    if _tool_count(tool_results, "configure_fpf_preset_draft") == 0:
        return False
    models = _result_for_tool(tool_results, "get_current_preset_models")
    if isinstance(models, dict):
        text = json.dumps(models, default=str)
        if "openai:gpt-5-mini" not in text:
            return True
    documents = _result_for_tool(tool_results, "get_current_preset_documents")
    if isinstance(documents, dict):
        text = json.dumps(documents, default=str).lower()
        if "document_count" in text and re.search(r'"document_count"\s*:\s*0', text):
            return True
    instructions = _result_for_tool(tool_results, "get_current_preset_instructions")
    if isinstance(instructions, dict):
        text = json.dumps(instructions, default=str)
        generation_id = _content_result_id(_created_content_result(tool_results, "generation_instructions"))
        if generation_id and generation_id not in text:
            return True
    return False


def _fpf_load_content_arguments(state: AdvancedGraphState) -> dict[str, object]:
    tool_results = _tool_results(state.get("messages") or [])
    content_type = "generation_instructions"
    if _loaded_created_content_result(tool_results, "generation_instructions") and not _loaded_created_content_result(tool_results, "input_document"):
        content_type = "input_document"
    content = _created_content_result(tool_results, content_type)
    content_id = _content_result_id(content)
    return {
        "content_id": content_id,
        "name_query": None,
        "content_type": content_type,
        "include_body_excerpt": True,
        "max_chars": 12000,
        "deep_read": True,
    }


def _loaded_created_content_result(tool_results: list[dict[str, object]], content_type: str) -> dict[str, object] | None:
    created_id = _content_result_id(_created_content_result(tool_results, content_type))
    if not created_id:
        return None
    for tool_result in reversed(tool_results):
        if tool_result.get("tool_name") != "load_content_for_assistant":
            continue
        result = tool_result.get("result")
        if not isinstance(result, dict) or result.get("status") != "loaded":
            continue
        content = result.get("content")
        if isinstance(content, dict) and content.get("id") == created_id and content.get("content_type") == content_type:
            return result
    return None


def _updated_created_content_result(tool_results: list[dict[str, object]], content_type: str) -> dict[str, object] | None:
    created_id = _content_result_id(_created_content_result(tool_results, content_type))
    if not created_id:
        return None
    for tool_result in reversed(tool_results):
        if tool_result.get("tool_name") != "update_content_for_assistant":
            continue
        result = tool_result.get("result")
        if not isinstance(result, dict) or result.get("status") != "updated":
            continue
        content = result.get("content")
        if isinstance(content, dict) and content.get("id") == created_id and content.get("content_type") == content_type:
            return result
    return None


def _fpf_created_content_needs_improvement(tool_results: list[dict[str, object]], content_type: str) -> bool:
    if _updated_created_content_result(tool_results, content_type):
        return False
    loaded = _loaded_created_content_result(tool_results, content_type)
    if not isinstance(loaded, dict):
        return False
    content = loaded.get("content")
    if not isinstance(content, dict):
        return True
    body = content.get("body_excerpt")
    return bool(_fpf_content_missing_quality_sections(body if isinstance(body, str) else "", content_type))


def _fpf_content_missing_quality_sections(body: str, content_type: str) -> list[str]:
    if content_type == "generation_instructions":
        required = (
            "## Mission",
            "## Goal Decomposition",
            "## Source-Use Rules",
            "## Required Output Structure",
            "## Forbidden Behavior",
            "## Semantic Quality Contract",
            "## Quality Checklist Before Finishing",
            "## Improvement Pass",
        )
    else:
        required = (
            "## User Goal",
            "## Goal Decomposition",
            "## Known Source Material",
            "## Starter Questions To Answer",
            "## Source Boundaries",
            "## Semantic Quality Contract",
            "## Future Refinements",
            "## Improvement Pass",
        )
    return [section for section in required if section not in body]


def _fpf_improved_content_body(user_message: str, current_body: str, content_type: str) -> str:
    profile = _fpf_goal_profile(user_message)
    base_body = current_body.strip() or (
        _fpf_generation_instructions_body(user_message)
        if content_type == "generation_instructions"
        else _fpf_input_document_body(user_message)
    )
    missing = _fpf_content_missing_quality_sections(base_body, content_type)
    improvement_lines = [
        "",
        "## Improvement Pass",
        "",
        "The advanced assistant re-read this newly created content asset before saving the preset and checked it against the FPF Preset Quality Doctrine.",
        "",
        "Detected weak or missing sections before this update:",
        *[f"- {item}" for item in (missing or ["none"])],
        "",
        "Added or confirmed goal decomposition:",
        f"- Audience: {profile['audience']}",
        f"- Desired length/depth: {profile['length']}",
        f"- Tone: {profile['tone']}",
        f"- Source assumptions: {profile['source_assumptions']}",
        "- Required or inferred sections:",
        *[f"  - {item}" for item in profile["sections"]],
        "- Constraints:",
        *[f"  - {item}" for item in profile["constraints"]],
        "",
        "Semantic verification rule:",
        "- This asset is acceptable only if it keeps FPF grounded in the input document, labels uncertainty, avoids invented research, and gives the generated output a reusable structure.",
    ]
    if "## Improvement Pass" in base_body:
        return base_body
    return "\n".join([*improvement_lines, "", base_body])


def _fpf_generation_instructions_body(goal: str) -> str:
    profile = _fpf_goal_profile(goal)
    safe_goal = _compact_text(str(profile["goal"]), limit=220)
    return "\n".join(
        [
            "# FPF Generation Instructions",
            "",
            "## Mission",
            "",
            f"Generate a useful, repeatable, source-grounded output about {safe_goal}.",
            "",
            "This is an FPF-only preset. Use the attached input document as the source material and topic authority. Do not behave as GPT Researcher, Deep Research, MS-Agent, eval, combine, translation, OWL, Marian, or PDF translation.",
            "",
            "## Assumed Audience",
            "",
            f"Write for {profile['audience']}. If the input document names a more specific audience, follow that audience instead.",
            "",
            "## Goal Decomposition",
            "",
            f"- Desired length/depth: {profile['length']}",
            f"- Tone: {profile['tone']}",
            f"- Source assumptions: {profile['source_assumptions']}",
            "- Required or inferred sections:",
            *[f"  - {item}" for item in profile["sections"]],
            "- Constraints:",
            *[f"  - {item}" for item in profile["constraints"]],
            "",
            "## Source-Use Rules",
            "",
            "- Treat the attached input document as the main authority.",
            "- Preserve important names, constraints, definitions, examples, and terminology from the input document.",
            "- Separate user-provided facts from reasonable inferences.",
            "- Do not invent citations, sources, tool results, private project facts, external research, or statistics not present in the input document.",
            "- If the input document is thin, say what is known from the brief and what would need more source material.",
            "",
            "## Required Output Structure",
            "",
            "1. Title",
            "2. Answer-first summary",
            "3. Main sections that fit the topic and user goal",
            "4. Practical implications or recommendations",
            "5. Uncertainties, assumptions, and missing information",
            "",
            "## Tone And Style",
            "",
            "- Be direct, concrete, and useful.",
            "- Prefer specific headings over generic essay flow.",
            "- Avoid filler, throat-clearing, and vague claims.",
            "- Keep the structure readable enough to reuse across future runs.",
            "",
            "## Forbidden Behavior",
            "",
            "- Do not claim the preset performed research unless research material is actually present in the input document.",
            "- Do not imply access to ACM internals, browser tokens, backend data, provider keys, or private files.",
            "- Do not switch engines or recommend non-FPF behavior inside the generated output.",
            "- Do not hide uncertainty when the input document lacks enough facts.",
            "",
            "## Quality Checklist Before Finishing",
            "",
            "- The output directly answers the topic goal.",
            "- The output uses the input document as its source boundary.",
            "- The output has a clear reader, structure, and purpose.",
            "- Important assumptions and missing details are labeled.",
            "- The final document would still make sense if this preset were reused later with a richer input document.",
            "",
            "## Semantic Quality Contract",
            "",
            "This preset is good only if the generated output is not merely grammatical, but useful for the user's goal. The output must have a clear purpose, declared source boundary, appropriate audience, concrete structure, labeled uncertainty, and no invented research.",
        ]
    )


def _fpf_input_document_body(goal: str) -> str:
    profile = _fpf_goal_profile(goal)
    safe_goal = _compact_text(str(profile["goal"]), limit=600)
    return "\n".join(
        [
            "# Topic Brief",
            "",
            "## User Goal",
            "",
            f"Topic: {safe_goal}",
            "",
            "Create a reusable FPF preset that can generate a useful document about this topic from the material attached to the preset.",
            "",
            "## Desired Output Objective",
            "",
            "Produce a clear, structured document that explains the topic, identifies the most important points, and gives practical takeaways for a reader who wants to understand or act on the topic.",
            "",
            "## Assumed Audience",
            "",
            f"{profile['audience']}. If the user later specifies a more precise audience, update this topic brief and the generation instructions.",
            "",
            "## Goal Decomposition",
            "",
            f"- Desired length/depth: {profile['length']}",
            f"- Tone: {profile['tone']}",
            f"- Source assumptions: {profile['source_assumptions']}",
            "- Required or inferred sections:",
            *[f"  - {item}" for item in profile["sections"]],
            "- Constraints:",
            *[f"  - {item}" for item in profile["constraints"]],
            "",
            "## Known Source Material",
            "",
            "The user supplied only the topic goal in chat. This brief is therefore a starter source document, not a completed research dossier.",
            "",
            "## Starter Questions To Answer",
            "",
            "- What is the topic and why does it matter?",
            "- What are the most important facts or concepts the reader needs first?",
            "- What tensions, tradeoffs, risks, or decisions are likely relevant?",
            "- What should the reader do, consider, or investigate next?",
            "- What information is missing from this starter brief?",
            "",
            "## Source Boundaries",
            "",
            "- Do not pretend this topic brief contains verified external research.",
            "- Do not invent named sources, statistics, citations, or private facts.",
            "- If the generated output needs stronger evidence, say what source material should be added to the content library before rerunning.",
            "",
            "## Future Refinements",
            "",
            "A stronger version of this preset would add audience details, desired length, required sections, real source documents, examples of good output, and facts or claims that must not be invented.",
            "",
            "## Semantic Quality Contract",
            "",
            "This topic brief is useful only if it preserves the user's goal while clearly labeling what is known, assumed, and missing. Future richer source documents should replace assumptions with concrete evidence.",
        ]
    )


def _latest_user_message(messages: list[dict[str, object]]) -> str:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
    return ""


def _started_run_id(tool_results: list[dict[str, object]]) -> str | None:
    execute_result = _result_for_tool(tool_results, "execute_current_preset")
    if not isinstance(execute_result, dict):
        return None
    if execute_result.get("status") != "started":
        return None
    run_id = execute_result.get("run_id")
    result_payload = execute_result.get("result")
    if not isinstance(run_id, str) and isinstance(result_payload, dict):
        run_id = result_payload.get("run_id")
    return run_id if isinstance(run_id, str) and run_id else None


def _run_status_results(tool_results: list[dict[str, object]]) -> list[dict[str, object]]:
    return _results_for_tool(tool_results, "get_run_status_summary")


def _run_log_results(tool_results: list[dict[str, object]]) -> list[dict[str, object]]:
    return _results_for_tool(tool_results, "load_run_logs_for_assistant")


def _run_monitoring_should_continue(tool_results: list[dict[str, object]]) -> bool:
    latest_status = _latest_run_status_result(tool_results)
    if not isinstance(latest_status, dict):
        return False
    if _run_is_terminal_from_status(latest_status):
        return False
    return (
        len(_run_status_results(tool_results)) < RUN_MONITOR_STATUS_POLL_LIMIT
        or len(_run_log_results(tool_results)) < RUN_MONITOR_LOG_POLL_LIMIT
    )


def _latest_run_status_result(tool_results: list[dict[str, object]]) -> dict[str, object] | None:
    status_results = _run_status_results(tool_results)
    return status_results[-1] if status_results else None


def _run_is_terminal_from_status(result: dict[str, object]) -> bool:
    summary = result.get("summary")
    if isinstance(summary, dict):
        if summary.get("finished") is True:
            return True
        state = summary.get("state")
    else:
        state = result.get("state")
    return isinstance(state, str) and state.lower() in RUN_MONITOR_TERMINAL_STATES


def _terminal_run_follow_up_tool(
    tool_results: list[dict[str, object]],
    tool_names: set[object],
) -> str | None:
    latest_status = _latest_run_status_result(tool_results)
    if not isinstance(latest_status, dict) or not _run_is_terminal_from_status(latest_status):
        return None
    if _terminal_run_needs_failure_signals(latest_status) and "get_run_failure_signals" not in tool_names:
        return "get_run_failure_signals"
    if _terminal_run_has_outputs(latest_status) and "get_run_output_summary" not in tool_names:
        return "get_run_output_summary"
    return None


def _terminal_repair_follow_up_tool(
    tool_results: list[dict[str, object]],
    tool_names: set[object],
) -> str | None:
    latest_status = _latest_run_status_result(tool_results)
    if not isinstance(latest_status, dict) or not _run_is_terminal_from_status(latest_status):
        return None
    failure_result = _result_for_tool(tool_results, "get_run_failure_signals")
    if not isinstance(failure_result, dict):
        return None
    log_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")
    category = _classify_run_failure(failure_result, log_result).get("category")
    if category == "missing_input_or_config" and "get_current_preset_documents" not in tool_names:
        return "get_current_preset_documents"
    if category == "model_or_provider_failure" and "get_current_preset_models" not in tool_names:
        return "get_current_preset_models"
    return None


def _repair_continuation_tool(
    tool_results: list[dict[str, object]],
    tool_names: set[object],
) -> str | None:
    failure_result = _result_for_tool(tool_results, "get_run_failure_signals")
    log_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")
    category = _classify_run_failure(failure_result, log_result).get("category")
    if category == "missing_input_or_config":
        if "get_current_preset_documents" not in tool_names:
            return "get_current_preset_documents"
        if "get_current_preset_instructions" not in tool_names:
            return "get_current_preset_instructions"
        if "get_current_preset_content_assets" not in tool_names:
            return "get_current_preset_content_assets"
        return None
    if category == "model_or_provider_failure":
        if "get_current_preset_models" not in tool_names:
            return "get_current_preset_models"
        if "load_run_logs_for_assistant" not in tool_names:
            return "load_run_logs_for_assistant"
        if "get_run_failure_signals" not in tool_names:
            return "get_run_failure_signals"
        return None
    return None


def _terminal_run_state(result: dict[str, object]) -> str:
    summary = result.get("summary")
    state = summary.get("state") if isinstance(summary, dict) else result.get("state")
    return state.lower() if isinstance(state, str) else ""


def _terminal_run_needs_failure_signals(result: dict[str, object]) -> bool:
    state = _terminal_run_state(result)
    return state in {"failed", "cancelled", "canceled", "completed_with_errors"}


def _terminal_run_has_outputs(result: dict[str, object]) -> bool:
    summary = result.get("summary")
    if not isinstance(summary, dict):
        return False
    if summary.get("outputs_available") is True:
        return True
    generated_count = summary.get("generated_document_count")
    return isinstance(generated_count, int) and generated_count > 0


def _tool_result_response(
    state: AdvancedGraphState,
    tool_result: dict[str, object],
) -> str:
    tool_name = tool_result.get("tool_name")
    result = tool_result.get("result")
    if tool_name in SHARED_TOOLS:
        return synthesize_tool_result_with_advanced_assistant_model(state=dict(state), tool_summary=json.dumps(result, default=str)[:30000])
    page_context = state.get("page_context")
    tool_results = state.get("tool_results") or _tool_results(state.get("messages") or [])
    preset_next_action_summary = _preset_next_action_text(state, tool_results)
    candidate_content_summary = _candidate_content_recommendation_text(state, tool_results)
    attached_content_review_summary = _attached_content_review_text(state, tool_results)
    content_comparison_summary = _content_comparison_text(state, tool_results)
    comparison_summary = _comparison_text(state, tool_results)
    conditional_save_summary = _conditional_save_preflight_text(
        state,
        tool_results,
    )
    execution_summary = _execution_preflight_text(state, tool_results)
    fpf_from_scratch_summary = _fpf_preset_from_scratch_text(state, tool_results)
    parts = [
        "I inspected the logged-in website through the approved website tool bridge.",
        f"Tool used: {tool_name}" if isinstance(tool_name, str) else "Tool used: unknown",
    ]
    if fpf_from_scratch_summary:
        parts.append(fpf_from_scratch_summary)
    if preset_next_action_summary:
        parts.append(preset_next_action_summary)
    if candidate_content_summary:
        parts.append(candidate_content_summary)
    if content_comparison_summary:
        parts.append(content_comparison_summary)
    if attached_content_review_summary:
        parts.append(attached_content_review_summary)
    if comparison_summary:
        parts.append(comparison_summary)
    if conditional_save_summary:
        parts.append(conditional_save_summary)
    if execution_summary:
        parts.append(execution_summary)
    if tool_name != "execute_current_preset":
        execute_result = _result_for_tool(tool_results, "execute_current_preset")
        execution_result_summary = _preset_execution_text(execute_result)
        if execution_result_summary:
            parts.append(execution_result_summary)
    if tool_name == "save_current_preset_draft":
        summary = _preset_save_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "create_content_for_assistant":
        summary = _content_create_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "update_content_for_assistant":
        summary = _content_update_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "start_new_preset_draft":
        summary = _start_new_preset_draft_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "configure_fpf_preset_draft":
        summary = _configure_fpf_preset_draft_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "execute_current_preset":
        summary = _preset_execution_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "attach_generation_instructions_to_current_preset":
        summary = _attach_generation_instructions_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "attach_input_document_to_current_preset":
        summary = _attach_input_document_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "attach_eval_asset_to_current_preset":
        summary = _attach_eval_asset_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "attach_combine_instructions_to_current_preset":
        summary = _attach_combine_instructions_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "set_current_preset_engine_models":
        summary = _model_selection_text(result)
        if summary:
            parts.append(summary)
    if tool_name != "get_run_status_summary":
        run_status_result = _result_for_tool(tool_results, "get_run_status_summary")
        run_status_summary = _run_status_text(run_status_result)
        if run_status_summary:
            parts.append(run_status_summary)
    if tool_name != "load_run_logs_for_assistant":
        run_logs_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")
        run_logs_summary = _run_logs_text(run_logs_result)
        if run_logs_summary:
            parts.append(run_logs_summary)
    if _repair_continuation_requested(state.get("current_user_message") or _latest_user_message(state.get("messages") or [])):
        if tool_name != "get_current_preset_documents":
            documents_summary = _preset_documents_text(_result_for_tool(tool_results, "get_current_preset_documents"))
            if documents_summary:
                parts.append(documents_summary)
        if tool_name != "get_current_preset_instructions":
            instructions_summary = _preset_instructions_text(_result_for_tool(tool_results, "get_current_preset_instructions"))
            if instructions_summary:
                parts.append(instructions_summary)
        if tool_name != "get_current_preset_content_assets":
            assets_summary = _preset_content_assets_text(_result_for_tool(tool_results, "get_current_preset_content_assets"))
            if assets_summary:
                parts.append(assets_summary)
    if tool_name == "get_available_assistant_actions":
        summary = _available_actions_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_loaded_preset_list":
        summary = _preset_list_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "load_preset_for_assistant":
        summary = _loaded_preset_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_content_library_summary":
        summary = _content_library_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "search_content_library_for_assistant":
        summary = _content_search_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "load_content_for_assistant":
        summary = _loaded_content_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_current_preset_content_assets":
        summary = _preset_content_assets_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_current_preset_runnability":
        summary = _preset_runnability_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_current_preset_summary":
        summary = _preset_summary_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_current_preset_models":
        summary = _preset_models_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_current_preset_documents":
        summary = _preset_documents_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_current_preset_instructions":
        summary = _preset_instructions_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_run_status_summary":
        summary = _run_status_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_recent_runs_for_assistant":
        summary = _recent_runs_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_latest_run_context":
        summary = _latest_run_context_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "load_run_for_assistant":
        summary = _loaded_run_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_run_failure_signals":
        summary = _run_failure_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "get_run_output_summary":
        summary = _run_output_text(result)
        if summary:
            parts.append(summary)
    if tool_name == "load_run_logs_for_assistant":
        summary = _run_logs_text(result)
        if summary:
            parts.append(summary)
    run_monitoring_summary = _run_monitoring_text(state, tool_results)
    if run_monitoring_summary:
        parts.append(run_monitoring_summary)
    repair_follow_up_summary = _repair_follow_up_text(tool_results)
    if repair_follow_up_summary:
        parts.append(repair_follow_up_summary)
    repair_continuation_summary = _repair_continuation_text(state, tool_results)
    if repair_continuation_summary:
        parts.append(repair_continuation_summary)
    missing_input_repair_summary = _missing_input_repair_recommendation_text(state, tool_results)
    if missing_input_repair_summary:
        parts.append(missing_input_repair_summary)
    terminal_recommendation_summary = _terminal_run_recommendation_text(tool_results)
    if terminal_recommendation_summary:
        parts.append(terminal_recommendation_summary)
    if page_context:
        route = _route_label(page_context)
        if route:
            parts.append(f"Current website context: {route}.")
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if _raw_tool_result_requested(user_message):
        parts.extend(
            [
                "Raw tool result:",
                "```json",
                json.dumps(result, indent=2, sort_keys=True, default=str)[:4000],
                "```",
            ]
        )
    else:
        parts.append(f"Evidence used: named website tool `{tool_name}`." if isinstance(tool_name, str) else "Evidence used: named website tool result.")
    parts.append(
        "No database key, browser session token, provider key, or raw backend API power was passed into the graph."
    )
    deterministic_summary = "\n\n".join(parts)
    if _raw_tool_result_requested(user_message):
        return deterministic_summary
    try:
        synthesized = synthesize_tool_result_with_advanced_assistant_model(
            state=dict(state),
            tool_summary=deterministic_summary,
        )
        if synthesized:
            return synthesized
    except Exception:
        pass
    return deterministic_summary


def _comparison_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(token in text for token in ("compare", "difference", "differences", "diff", "versus", " vs "))


def _raw_tool_result_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(
        token in text
        for token in (
            "raw json",
            "raw tool result",
            "full tool result",
            "show json",
            "show payload",
            "debug payload",
            "exact payload",
        )
    )


def _content_comparison_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not (
        _comparison_requested(user_message)
        or any(
            token in text
            for token in (
                "should i use",
                "good enough",
                "would this fit",
                "does this fit",
                "does content",
                "does instruction",
                "does document",
                "is this a good fit",
                "use in the current preset",
                "use in current preset",
                "use for the current preset",
                "use for current preset",
                "recommend whether",
                "recommend if",
            )
        )
    ):
        return False
    return any(
        token in text
        for token in (
            "content",
            "instruction",
            "instructions",
            "document",
            "topic file",
            "topic document",
            "template fragment",
            "eval criteria",
            "prompt",
        )
    )


def _attached_content_review_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(
        token in text
        for token in (
            "attached content",
            "attached assets",
            "attached documents",
            "attached instructions",
            "content assets",
            "preset assets",
            "instruction assets",
            "document assets",
            "current attachments",
            "attached to this preset",
            "attached to the preset",
        )
    ):
        return False
    return any(
        token in text
        for token in (
            "review",
            "audit",
            "compare",
            "fit",
            "fits",
            "good",
            "missing",
            "recommend",
            "ready",
            "should",
            "check",
            "validate",
        )
    )


def _preset_next_action_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _save_requested(user_message):
        return False
    if _attached_content_review_requested(user_message):
        return False
    has_preset_context = any(
        token in text
        for token in (
            "preset",
            "current config",
            "this config",
            "configuration",
            "draft",
            "run setup",
            "setup",
        )
    )
    if not has_preset_context:
        return False
    return any(
        token in text
        for token in (
            "what should i do next",
            "what should we do next",
            "what do i do next",
            "next action",
            "next step",
            "fix next",
            "fix first",
            "what should i fix",
            "what needs fixing",
            "what needs to change",
            "what is missing",
            "what's missing",
            "make it ready",
            "make this ready",
            "get it ready",
            "ready to run",
            "run readiness",
            "before running",
            "before i run",
            "should i run",
            "can i run",
            "what still looks weak",
            "what looks weak",
            "what is weak",
            "what's weak",
            "weak spot",
            "weak spots",
            "weakness",
            "weaknesses",
            "quality audit",
            "quality check",
            "quality review",
            "limitations",
            "what should i improve",
            "what should we improve",
            "improve next",
        )
    )


def _available_actions_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(
        token in text
        for token in (
            "what tools",
            "which tools",
            "available tools",
            "website tools",
            "what website tools",
            "which website tools",
            "tool list",
            "list the tools",
            "available actions",
            "available assistant actions",
            "assistant actions",
            "assistant actions are available",
            "actions are available",
            "what actions",
            "which actions",
            "actions can you",
            "what can you do",
            "inspect availability",
        )
    )


def _knowledge_manifest_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("knowledge", "docs", "documents", "manifest")):
        return False
    return any(
        token in text
        for token in (
            "what acm knowledge",
            "what knowledge",
            "knowledge documents",
            "knowledge docs",
            "knowledge manifest",
            "what docs",
            "what documents",
            "what were you given",
            "how do you know acm",
        )
    )


def _recent_runs_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("recent runs", "run history", "history rows", "past runs", "previous runs")):
        return False
    return any(token in text for token in ("show", "list", "what", "which", "load", "get", "tell me"))


def _latest_run_context_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("latest run", "last run", "most recent run", "latest execution", "last execution", "most recent execution")):
        return False
    return any(token in text for token in ("what happened", "result", "results", "outcome", "summarize", "summary", "overview", "tell me about", "explain"))


def _load_run_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("load", "open", "inspect", "read")):
        return False
    return any(token in text for token in ("run ", "latest run", "last run", "most recent run", "run id", "run_id"))


def _run_id_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    lower = text.lower()
    markers = ("run id ", "run_id ", "run ")
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = text[start + len(marker):].strip(" .?!:")
        if not candidate:
            continue
        first = candidate.split()[0].strip(",.;:")
        if first and first.lower() not in {"latest", "last", "most", "current"}:
            return first[:120]
    return None


def _wants_all_logs(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(
        token in text
        for token in (
            "all logs",
            "full logs",
            "full log",
            "detailed logs",
            "detailed log",
            "detailed run logs",
            "verbose logs",
            "verbose log",
            "verbose",
        )
    )


def _save_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    return any(
        token in text
        for token in (
            "save preset",
            "save this preset",
            "save current preset",
            "save draft",
            "save this draft",
            "save current draft",
            "save the preset",
            "save the current preset",
        )
    )


def _execute_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if any(token in text for token in ("run status", "run logs", "run output", "recent run", "latest run")):
        return False
    normalized = re.sub(r"[^a-z0-9\s]", " ", text)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if normalized in {
        "run it",
        "run this",
        "execute it",
        "execute this",
        "start it",
        "start this",
        "launch it",
        "launch this",
    }:
        return True
    return any(
        token in text
        for token in (
            "execute current preset",
            "execute the current preset",
            "execute this preset",
            "execute the preset",
            "run current preset",
            "run the current preset",
            "run this preset",
            "run the preset",
            "run a preset",
            "run an fpf preset",
            "run a fpf preset",
            "run fpf preset",
            "start current preset",
            "start the current preset",
            "start this preset",
            "start the preset",
            "start an fpf preset",
            "start a fpf preset",
            "launch current preset",
            "launch the current preset",
            "launch this preset",
            "launch the preset",
            "launch an fpf preset",
            "launch a fpf preset",
        )
    )


def _run_monitor_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if any(
        token in text
        for token in (
            "continue monitoring",
            "monitor again",
            "keep monitoring",
            "check again",
            "check it again",
            "check the run again",
            "check this run again",
            "poll again",
            "watch the run",
            "watch this run",
            "monitor this run",
            "monitor the run",
        )
    ):
        return True
    return "continue" in text and any(token in text for token in ("run", "status", "logs", "monitor"))


def _repair_continuation_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(
        token in text
        for token in (
            "continue the repair",
            "continue repair",
            "continue the audit",
            "continue audit",
            "continue the missing-input repair",
            "continue missing-input repair",
            "continue the model repair",
            "continue model repair",
            "repair audit",
            "repair follow-up",
            "next repair check",
            "keep checking the repair",
        )
    )


def _repair_best_candidate_attach_requested(user_message: str) -> bool:
    return _best_candidate_attach_requested(user_message, "input_document")


def _best_candidate_attach_requested(user_message: str, content_type: str) -> bool:
    text = str(user_message).lower()
    if _write_action_negated(text):
        return False
    if not any(token in text for token in ("attach", "use", "select", "add")):
        return False
    if not any(token in text for token in ("best", "top", "first", "recommended", "matching", "candidate")):
        return False
    if content_type == "generation_instructions":
        return any(
            token in text
            for token in (
                "generation instruction",
                "generation instructions",
                "generation-instructions",
                "writing instruction",
                "research directive",
            )
        )
    if content_type == "input_document":
        return any(token in text for token in ("input document", "input doc", "topic file", "topic document", "source document", "source material"))
    return False


def _write_action_negated(text: str) -> bool:
    negation_tokens = (
        "do not",
        "don't",
        "dont",
        "never",
        "without",
        "not yet",
        "no write",
        "read only",
        "read-only",
        "recommendation only",
        "recommend only",
        "just recommend",
        "only recommend",
    )
    write_tokens = (
        "attach",
        "use",
        "select",
        "create",
        "make",
        "write",
        "draft",
        "add",
        "set",
        "save",
        "execute",
        "run",
        "start",
        "launch",
        "update",
        "edit",
        "revise",
        "rename",
        "move",
        "change",
        "replace",
        "clear",
    )
    if not any(negation in text for negation in negation_tokens):
        return False
    return any(token in text for token in write_tokens)


def _conditional_save_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not _save_requested(user_message):
        return False
    return any(
        token in text
        for token in (
            "if ready",
            "if it is ready",
            "if it's ready",
            "if runnable",
            "if runable",
            "if safe",
            "if good",
            "if valid",
            "if no blockers",
            "if there are no blockers",
            "after checking",
            "check first",
            "check blockers",
            "make sure",
            "only if",
        )
    )


def _conditional_save_preflight_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _conditional_save_requested(user_message):
        return ""
    runnability = _result_for_tool(tool_results, "get_current_preset_runnability")
    if not isinstance(runnability, dict):
        return ""
    save_result = _result_for_tool(tool_results, "save_current_preset_draft")
    if isinstance(save_result, dict):
        if save_result.get("cancelled") is True or save_result.get("status") == "cancelled":
            return "Conditional save preflight passed, but the save was cancelled by the website workflow."
        return "Conditional save preflight passed before the save tool ran."
    if _runnability_allows_save(runnability):
        return "Conditional save preflight passed: the visible preset has no blocking runnability issues, so advanced YOLO mode can run the save tool."

    blocking_reasons = runnability.get("blocking_reasons")
    return (
        "Conditional save preflight stopped the save request: the visible preset is not ready yet. "
        f"Blocking reasons: {_join_list(blocking_reasons)}."
    )


def _execution_preflight_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _execute_requested(user_message):
        return ""
    runnability = _result_for_tool(tool_results, "get_current_preset_runnability")
    if not isinstance(runnability, dict):
        return ""
    execute_result = _result_for_tool(tool_results, "execute_current_preset")
    if isinstance(execute_result, dict):
        if execute_result.get("cancelled") is True or execute_result.get("status") == "cancelled":
            return "Execution preflight passed, but execution was cancelled by the website workflow."
        return "Execution preflight passed before the execution tool ran."
    if _runnability_allows_save(runnability):
        return "Execution preflight passed: the visible preset has no blocking runnability issues, so advanced YOLO mode can run the execution tool."

    blocking_reasons = runnability.get("blocking_reasons")
    return (
        "Execution preflight stopped the run request: the visible preset is not ready yet. "
        f"Blocking reasons: {_join_list(blocking_reasons)}."
    )


def _run_monitoring_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not (_execute_requested(user_message) or _run_monitor_requested(user_message)):
        return ""
    if not _monitored_run_id(state, tool_results):
        return ""
    status_results = _run_status_results(tool_results)
    log_results = _run_log_results(tool_results)
    latest_status = status_results[-1] if status_results else None
    if not isinstance(latest_status, dict):
        return ""
    if _run_is_terminal_from_status(latest_status):
        return (
            "Run monitoring reached a terminal state. "
            f"Status polls used: {len(status_results)}. Log inspections used: {len(log_results)}."
        )
    if len(status_results) >= RUN_MONITOR_STATUS_POLL_LIMIT and len(log_results) >= RUN_MONITOR_LOG_POLL_LIMIT:
        state_label = "unknown"
        summary = latest_status.get("summary")
        if isinstance(summary, dict) and isinstance(summary.get("state"), str):
            state_label = summary["state"]
        return (
            "Run monitoring paused at the bounded follow-up cap. "
            f"Latest known state: {state_label}. "
            f"Status polls used: {len(status_results)} of {RUN_MONITOR_STATUS_POLL_LIMIT}. "
            f"Log inspections used: {len(log_results)} of {RUN_MONITOR_LOG_POLL_LIMIT}. "
            "Ask me to continue monitoring if you want another bounded check."
        )
    return ""


def _monitored_run_id(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str | None:
    started_run_id = _started_run_id(tool_results)
    if started_run_id:
        return started_run_id
    latest_status = _latest_run_status_result(tool_results)
    if isinstance(latest_status, dict):
        run_id = latest_status.get("run_id")
        if isinstance(run_id, str) and run_id:
            return run_id
    page_context = state.get("page_context")
    if isinstance(page_context, dict):
        run_id = page_context.get("current_run_id")
        if isinstance(run_id, str) and run_id:
            return run_id
    return None


def _terminal_run_recommendation_text(tool_results: list[dict[str, object]]) -> str:
    latest_status = _latest_run_status_result(tool_results)
    if not isinstance(latest_status, dict) or not _run_is_terminal_from_status(latest_status):
        return ""
    state = _terminal_run_state(latest_status) or "terminal"
    failure_result = _result_for_tool(tool_results, "get_run_failure_signals")
    output_result = _result_for_tool(tool_results, "get_run_output_summary")
    log_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")

    recommendations: list[str] = []
    if state == "completed":
        if isinstance(output_result, dict) and _run_output_available(output_result):
            title = _first_output_title(output_result)
            if title:
                recommendations.append(f"Open or review the generated output first: {title}.")
            else:
                recommendations.append("Open or review the generated outputs before rerunning the preset.")
            recommendations.append("If the output is good, save or export it through the normal website workflow.")
        elif _terminal_run_has_outputs(latest_status):
            recommendations.append("Outputs appear to exist; load the run output summary before deciding what to do next.")
        else:
            recommendations.append("The run completed but no outputs were reported; inspect logs before trusting this run.")
    elif state in {"failed", "cancelled", "canceled", "completed_with_errors"}:
        failure_message = _top_failure_message(failure_result) or _top_log_failure_message(log_result)
        failure_classification = _classify_run_failure(failure_result, log_result)
        if failure_message:
            recommendations.append(f"Fix the first concrete failure before rerunning: {failure_message}")
        else:
            recommendations.append("Inspect the failure evidence before rerunning; the bounded facts did not include a single concrete root-cause line.")
        if failure_classification.get("category") != "unknown":
            recommendations.append(str(failure_classification["recommendation"]))
            playbook = failure_classification.get("playbook")
            if playbook:
                recommendations.append(str(playbook))
        if state == "completed_with_errors" and isinstance(output_result, dict) and _run_output_available(output_result):
            recommendations.append("Review the generated outputs too, because this run produced artifacts despite errors.")
        recommendations.append("Do not rerun unchanged unless the failure was clearly transient.")
    else:
        recommendations.append("Review the terminal run facts before taking another action.")

    if not recommendations:
        return ""
    lines = ["Recommended next action:"]
    lines.extend(f"- {item}" for item in recommendations[:6])
    lines.append("- Recommendation is based only on bounded website tool facts; I did not change anything.")
    return "\n".join(lines)


def _repair_follow_up_text(tool_results: list[dict[str, object]]) -> str:
    failure_result = _result_for_tool(tool_results, "get_run_failure_signals")
    if not isinstance(failure_result, dict):
        return ""
    log_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")
    category = _classify_run_failure(failure_result, log_result).get("category")
    if category == "missing_input_or_config" and isinstance(_result_for_tool(tool_results, "get_current_preset_documents"), dict):
        return (
            "Repair follow-up inspection:\n"
            "- Failure type: missing_input_or_config.\n"
            "- I inspected current preset documents as the first bounded repair check.\n"
            "- If document state remains unclear, ask me to inspect preset instructions and attached content next."
        )
    if category == "model_or_provider_failure" and isinstance(_result_for_tool(tool_results, "get_current_preset_models"), dict):
        return (
            "Repair follow-up inspection:\n"
            "- Failure type: model_or_provider_failure.\n"
            "- I inspected current preset model selections as the first bounded repair check.\n"
            "- If provider evidence still points outside the preset, verify provider availability outside the assistant before rerunning."
        )
    return ""


def _repair_continuation_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _repair_continuation_requested(user_message):
        return ""
    failure_result = _result_for_tool(tool_results, "get_run_failure_signals")
    log_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")
    category = _classify_run_failure(failure_result, log_result).get("category")
    if category == "missing_input_or_config":
        checked: list[str] = []
        if isinstance(_result_for_tool(tool_results, "get_current_preset_documents"), dict):
            checked.append("documents")
        if isinstance(_result_for_tool(tool_results, "get_current_preset_instructions"), dict):
            checked.append("instructions")
        if isinstance(_result_for_tool(tool_results, "get_current_preset_content_assets"), dict):
            checked.append("attached content")
        return (
            "Repair continuation:\n"
            "- Failure type: missing_input_or_config.\n"
            f"- Checked so far: {_join_list(checked)}.\n"
            "- This stayed read-only; no preset draft was changed."
        )
    if category == "model_or_provider_failure":
        checked = []
        if isinstance(_result_for_tool(tool_results, "get_current_preset_models"), dict):
            checked.append("model selections")
        if isinstance(log_result, dict):
            checked.append("run logs")
        if isinstance(failure_result, dict):
            checked.append("failure signals")
        return (
            "Repair continuation:\n"
            "- Failure type: model_or_provider_failure.\n"
            f"- Checked so far: {_join_list(checked)}.\n"
            "- This stayed read-only; no model selection or preset draft was changed."
        )
    return ""


def _missing_input_repair_recommendation_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _repair_continuation_requested(user_message):
        return ""
    failure_result = _result_for_tool(tool_results, "get_run_failure_signals")
    log_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")
    category = _classify_run_failure(failure_result, log_result).get("category")
    if category != "missing_input_or_config":
        return ""
    documents_result = _result_for_tool(tool_results, "get_current_preset_documents")
    instructions_result = _result_for_tool(tool_results, "get_current_preset_instructions")
    assets_result = _result_for_tool(tool_results, "get_current_preset_content_assets")
    if not all(isinstance(result, dict) for result in (documents_result, instructions_result, assets_result)):
        return ""

    document_count = _document_count_from_result(documents_result)
    has_generation = _instructions_have_generation(instructions_result) or _assets_have_type(assets_result, "generation_instructions")
    missing_slots = assets_result.get("missing_slots") if isinstance(assets_result, dict) else None
    missing_input_slot = isinstance(missing_slots, list) and any("input" in str(slot).lower() or "document" in str(slot).lower() for slot in missing_slots)

    recommendations: list[str] = []
    if document_count == 0 or missing_input_slot:
        if has_generation:
            recommendations.append("Attach an input document or topic/source file next; generation instructions appear present, but source material is missing.")
        else:
            recommendations.append("Attach or create generation instructions, then attach an input document or topic/source file before rerunning.")
    elif document_count > 0 and not has_generation:
        recommendations.append("Attach or create generation instructions next; source documents appear present, but the writing/research directive is missing.")
    elif document_count > 0 and has_generation:
        recommendations.append("Documents and generation instructions appear present; inspect runnability again before rerunning to find the remaining blocker.")
    else:
        recommendations.append("The bounded audit did not identify the exact missing piece; inspect preset runnability again before rerunning.")

    if missing_input_slot:
        recommendations.append(f"Visible missing slot evidence: {_join_list(missing_slots)}.")
    recommendations.append("Do not rerun until the missing preset setup piece is attached and saved through the normal website workflow.")

    lines = ["Missing-input repair recommendation:"]
    lines.extend(f"- {item}" for item in recommendations[:4])
    lines.append("- Recommendation is based only on read-only website tool facts; I did not change the preset draft.")
    return "\n".join(lines)


def _document_count_from_result(result: object) -> int | None:
    if not isinstance(result, dict):
        return None
    documents = result.get("documents")
    if not isinstance(documents, dict):
        return None
    count = documents.get("document_count")
    return count if isinstance(count, int) else None


def _instructions_have_generation(result: object) -> bool:
    if not isinstance(result, dict):
        return False
    instructions = result.get("instructions")
    if not isinstance(instructions, dict):
        return False
    generation = instructions.get("generation")
    if not isinstance(generation, dict):
        return False
    return generation.get("attached") is True or any(isinstance(generation.get(key), str) and generation.get(key) for key in ("id", "title", "name"))


def _assets_have_type(result: object, content_type: str) -> bool:
    if not isinstance(result, dict):
        return False
    assets = result.get("assets")
    if not isinstance(assets, list):
        return False
    for item in assets:
        if not isinstance(item, dict):
            continue
        if item.get("content_type") == content_type:
            return True
    return False


def _run_output_available(result: dict[str, object]) -> bool:
    if result.get("status") != "loaded":
        return False
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        return False
    if outputs.get("outputs_available") is True:
        return True
    generated_count = outputs.get("generated_document_count")
    return isinstance(generated_count, int) and generated_count > 0


def _first_output_title(result: dict[str, object]) -> str:
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        return ""
    items = outputs.get("items")
    if not isinstance(items, list):
        return ""
    for item in items:
        if not isinstance(item, dict):
            continue
        title = item.get("title") or item.get("name") or item.get("id")
        if isinstance(title, str) and title:
            return _compact_text(title, limit=160)
    return ""


def _top_failure_message(result: object) -> str:
    if not isinstance(result, dict) or result.get("status") != "loaded":
        return ""
    signals = result.get("signals")
    if not isinstance(signals, dict):
        return ""
    top_errors = signals.get("top_errors")
    if isinstance(top_errors, list):
        for item in top_errors:
            if isinstance(item, str) and item:
                return _compact_text(item, limit=240)
    evidence = signals.get("evidence")
    if isinstance(evidence, list):
        for item in evidence:
            if not isinstance(item, dict):
                continue
            message = item.get("message")
            if isinstance(message, str) and message:
                return _compact_text(message, limit=240)
    return ""


def _top_log_failure_message(result: object) -> str:
    if not isinstance(result, dict) or result.get("status") != "loaded":
        return ""
    for key in ("concrete_failure_evidence", "warnings", "queue_or_worker_samples", "sampled_entries"):
        items = result.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            message = item.get("message")
            if isinstance(message, str) and message:
                return _compact_text(message, limit=240)
    return ""


def _classify_run_failure(failure_result: object, log_result: object) -> dict[str, str]:
    text = _failure_classification_text(failure_result, log_result)
    rules = [
        (
            "missing_input_or_config",
            (
                "missing input",
                "no input",
                "input document",
                "source document",
                "document is required",
                "missing model",
                "no model",
                "missing instruction",
                "required field",
                "not configured",
            ),
            "Fix the missing preset input/configuration before rerunning.",
            "Repair playbook: ask me to inspect current preset runnability, documents, instructions, and attached content before trying another run.",
        ),
        (
            "worker_crash",
            (
                "worker failed",
                "worker crash",
                "worker crashed",
                "exception",
                "traceback",
                "stack trace",
                "process exited",
                "segmentation fault",
                "killed",
            ),
            "Treat this as a worker/runtime failure; inspect worker logs or fix the runtime error before rerunning.",
            "Repair playbook: ask me for detailed run logs first; if the evidence still points to a worker/runtime exception, inspect the worker service logs outside the assistant before rerunning.",
        ),
        (
            "timeout",
            ("timeout", "timed out", "deadline", "exceeded time", "time limit"),
            "Treat this as a timeout; reduce workload, check provider latency, or rerun with a smaller/bounded job.",
            "Repair playbook: ask me to inspect run logs and outputs, then consider reducing source size, model workload, or retrying with a smaller bounded run.",
        ),
        (
            "model_or_provider_failure",
            (
                "provider",
                "openai",
                "anthropic",
                "model",
                "rate limit",
                "quota",
                "api key",
                "unauthorized",
                "permission",
                "bad request",
                "context length",
                "token limit",
            ),
            "Check the selected model/provider and retry only after the provider-side issue or model configuration is corrected.",
            "Repair playbook: ask me to inspect current preset models and provider-facing failure evidence before changing model selections or rerunning.",
        ),
        (
            "queue_starvation",
            (
                "queued",
                "queue",
                "starvation",
                "no worker",
                "worker unavailable",
                "stuck in queue",
                "pending too long",
            ),
            "Treat this as a queue/worker availability issue; check workers before rerunning.",
            "Repair playbook: ask me to continue monitoring the run status later, and check worker availability if the run remains queued or starved.",
        ),
        (
            "transient_retry",
            (
                "retry",
                "retriable",
                "temporarily unavailable",
                "temporary",
                "connection reset",
                "network",
                "503",
                "502",
                "504",
            ),
            "This may be transient; retry is reasonable after confirming the queue and provider are healthy.",
            "Repair playbook: ask me to re-check status/logs once; if the retry evidence clears and the queue/provider are healthy, a rerun may be reasonable.",
        ),
    ]
    for category, needles, recommendation, playbook in rules:
        if any(needle in text for needle in needles):
            return {
                "category": category,
                "recommendation": recommendation,
                "playbook": playbook,
            }
    return {
        "category": "unknown",
        "recommendation": "The bounded facts do not classify this failure yet; inspect the raw evidence before rerunning.",
        "playbook": "Repair playbook: ask me for detailed run logs and failure signals, then decide based on the strongest concrete evidence.",
    }


def _failure_classification_text(failure_result: object, log_result: object) -> str:
    pieces: list[str] = []
    if isinstance(failure_result, dict):
        signals = failure_result.get("signals")
        if isinstance(signals, dict):
            for key in ("severity", "top_errors", "warnings", "evidence"):
                _collect_text_fragments(signals.get(key), pieces)
    if isinstance(log_result, dict):
        for key in (
            "classification",
            "summary",
            "run_summary",
            "concrete_failure_evidence",
            "warnings",
            "notable_events",
            "queue_or_worker_samples",
            "sampled_entries",
        ):
            _collect_text_fragments(log_result.get(key), pieces)
    return " ".join(pieces).lower()


def _collect_text_fragments(value: object, pieces: list[str]) -> None:
    if isinstance(value, str):
        if value:
            pieces.append(value)
        return
    if isinstance(value, (int, float, bool)):
        pieces.append(str(value))
        return
    if isinstance(value, list):
        for item in value[:12]:
            _collect_text_fragments(item, pieces)
        return
    if isinstance(value, dict):
        for item in list(value.values())[:16]:
            _collect_text_fragments(item, pieces)


def _runnability_allows_save(result: dict[str, object]) -> bool:
    if result.get("status") not in {"evaluated", "loaded"}:
        return False
    if result.get("runnable") is not True:
        return False
    blocking_reasons = result.get("blocking_reasons")
    return not (isinstance(blocking_reasons, list) and blocking_reasons)


def _comparison_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _comparison_requested(user_message) or _content_comparison_requested(user_message):
        return ""
    loaded_preset = _result_for_tool(tool_results, "load_preset_for_assistant")
    current_preset = _result_for_tool(tool_results, "get_current_preset_summary")
    if not isinstance(loaded_preset, dict) or not isinstance(current_preset, dict):
        return ""
    if loaded_preset.get("status") != "loaded" or current_preset.get("status") != "loaded":
        return ""

    loaded_summary = loaded_preset.get("summary")
    current_summary = current_preset.get("summary")
    if not isinstance(loaded_summary, dict) or not isinstance(current_summary, dict):
        return ""

    differences: list[str] = []
    _append_difference(differences, "Enabled engines", current_summary.get("enabled_engines"), loaded_summary.get("enabled_engines"))
    _append_difference(differences, "Selected models", current_summary.get("selected_models"), loaded_summary.get("selected_models"))
    _append_difference(differences, "Document count", current_summary.get("document_count"), loaded_summary.get("document_count"))
    _append_difference(differences, "Input source", current_summary.get("input_source_type"), loaded_summary.get("input_source_type"))
    _append_difference(differences, "Active search provider", current_summary.get("active_search_provider"), loaded_summary.get("active_search_provider"))
    _append_difference(
        differences,
        "Generation instruction attachment",
        current_summary.get("selected_instruction_id") or current_summary.get("generation_instructions_attached"),
        loaded_summary.get("generation_instructions_attached"),
    )

    lines = [
        "Preset comparison:",
        f"- Current visible preset: {current_preset.get('name') or current_preset.get('preset_id') or 'unnamed'}",
        f"- Loaded stored preset: {loaded_preset.get('name') or loaded_preset.get('preset_id') or 'unnamed'}",
    ]
    if differences:
        lines.append("- Main differences:")
        lines.extend(f"  - {item}" for item in differences[:8])
    else:
        lines.append("- The bounded summaries did not show major differences in engines, models, document count, input source, search provider, or generation-instruction attachment.")
    lines.append("- This comparison uses bounded website summaries, not the full raw preset records.")
    return "\n".join(lines)


def _content_comparison_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _content_comparison_requested(user_message):
        return ""
    loaded_content = _result_for_tool(tool_results, "load_content_for_assistant")
    current_preset = _result_for_tool(tool_results, "get_current_preset_summary")
    if not isinstance(loaded_content, dict) or not isinstance(current_preset, dict):
        return ""
    if loaded_content.get("status") != "loaded" or current_preset.get("status") != "loaded":
        return ""

    content = loaded_content.get("content")
    current_summary = current_preset.get("summary")
    if not isinstance(content, dict) or not isinstance(current_summary, dict):
        return ""

    content_type = _normalize_compare_value(content.get("content_type"))
    variables = content.get("variable_names")
    body_excerpt = content.get("body_excerpt")
    document_count = current_summary.get("document_count")
    selected_instruction_id = current_summary.get("selected_instruction_id")
    recommendations = _content_fit_recommendations(content, current_summary)

    lines = [
        "Preset/content comparison:",
        f"- Current visible preset: {current_preset.get('name') or current_preset.get('preset_id') or 'unnamed'}",
        f"- Loaded content: {content.get('name') or content.get('id') or 'unnamed'}",
        f"- Content type: {content_type}",
        f"- Current selected models: {_join_list(current_summary.get('selected_models'))}",
        f"- Current document count: {document_count}" if isinstance(document_count, int) else "",
        f"- Current generation instruction selected: {_yes_no(bool(selected_instruction_id))}",
    ]
    if isinstance(variables, list) and variables:
        lines.append(f"- Content variables to verify before use: {_join_list(variables)}")
    if isinstance(body_excerpt, str) and body_excerpt:
        lines.append(f"- Content excerpt evidence: {_compact_text(body_excerpt, limit=320)}")
    if recommendations:
        lines.append("- Recommendation notes:")
        lines.extend(f"  - {item}" for item in recommendations[:8])
    lines.append("- Recommendation only: I did not request a write tool and nothing was changed.")
    lines.append("- This comparison uses bounded website summaries plus a bounded content excerpt, not full raw records.")
    return "\n".join(line for line in lines if line)


def _content_fit_recommendations(content: dict[str, object], current_summary: dict[str, object]) -> list[str]:
    content_type = str(content.get("content_type") or "").lower()
    recommendations: list[str] = []

    if content_type == "generation_instructions":
        if current_summary.get("selected_instruction_id"):
            recommendations.append("This is a generation-instruction candidate; the current preset already has a generation instruction, so treat it as a replacement candidate rather than an additive document.")
        else:
            recommendations.append("This is a generation-instruction candidate and the current preset does not show a selected generation instruction, so it looks like a plausible missing setup piece.")
    elif content_type == "input_document":
        document_count = current_summary.get("document_count")
        if isinstance(document_count, int) and document_count > 0:
            recommendations.append("This is an input-document/topic candidate; the current preset already has documents, so compare it against the existing source set before adding it.")
        else:
            recommendations.append("This is an input-document/topic candidate and the current preset has no documents, so it looks like a plausible source-material candidate.")
    elif content_type in {"single_eval_instructions", "pairwise_eval_instructions", "eval_criteria"}:
        recommendations.append("This appears to belong to evaluation behavior, not generation or source documents; attach it only if the preset's evaluation flow needs that role.")
    elif content_type == "combine_instructions":
        recommendations.append("This appears to belong to combine/synthesis behavior; it should not replace source documents or generation instructions unless that is the intended slot.")
    elif content_type == "template_fragment":
        recommendations.append("This looks like a reusable template fragment; it may inform an instruction draft, but it is probably not a direct preset attachment by itself.")
    else:
        recommendations.append("The content type does not map cleanly to a known preset slot from the bounded facts; inspect the content role before using it.")

    variables = content.get("variable_names")
    if isinstance(variables, list) and variables:
        recommendations.append("The content declares variables, so confirm the preset or run form can provide values for them before execution.")

    enabled_engines = current_summary.get("enabled_engines")
    if not isinstance(enabled_engines, list) or not enabled_engines:
        recommendations.append("The current preset summary does not show enabled engines; even good content will not make the preset runnable by itself.")

    return recommendations


def _attached_content_review_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _attached_content_review_requested(user_message):
        return ""
    assets_result = _result_for_tool(tool_results, "get_current_preset_content_assets")
    current_preset = _result_for_tool(tool_results, "get_current_preset_summary")
    if not isinstance(assets_result, dict) or not isinstance(current_preset, dict):
        return ""
    if assets_result.get("status") != "loaded" or current_preset.get("status") != "loaded":
        return ""

    current_summary = current_preset.get("summary")
    assets = assets_result.get("assets")
    if not isinstance(current_summary, dict) or not isinstance(assets, list):
        return ""

    missing_slots = assets_result.get("missing_slots")
    unavailable_assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("status") == "unavailable"]
    available_assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("status") != "unavailable"]
    by_type = _asset_counts_by_type(available_assets)
    recommendations = _attached_content_recommendations(current_summary, assets, missing_slots)

    lines = [
        "Preset attached-content audit:",
        f"- Current visible preset: {current_preset.get('name') or current_preset.get('preset_id') or 'unnamed'}",
        f"- Attached content records loaded: {len(available_assets)}",
        f"- Unavailable attachment records: {len(unavailable_assets)}",
        f"- Asset type counts: {_compact_mapping(by_type)}",
        f"- Current preset document count: {current_summary.get('document_count')}" if isinstance(current_summary.get("document_count"), int) else "",
        f"- Current selected models: {_join_list(current_summary.get('selected_models'))}",
        f"- Current enabled engines: {_join_list(current_summary.get('enabled_engines'))}",
    ]
    if isinstance(missing_slots, list) and missing_slots:
        lines.append(f"- Missing visible slots: {_join_list(missing_slots)}")
    if available_assets:
        lines.append("- Attached assets:")
        for asset in available_assets[:12]:
            if not isinstance(asset, dict):
                continue
            slot = asset.get("slot")
            name = asset.get("name") or asset.get("id")
            content_type = asset.get("content_type")
            preview = asset.get("body_preview")
            label = f"{slot}: {name} ({content_type})" if slot else f"{name} ({content_type})"
            if isinstance(preview, str) and preview:
                label = f"{label} - preview: {_compact_text(preview, limit=180)}"
            lines.append(f"  - {label}")
    if unavailable_assets:
        lines.append("- Unavailable assets:")
        for asset in unavailable_assets[:8]:
            if not isinstance(asset, dict):
                continue
            lines.append(f"  - {asset.get('slot')}: {asset.get('id')} ({asset.get('content_type')})")
    if recommendations:
        lines.append("- Recommendation notes:")
        lines.extend(f"  - {item}" for item in recommendations[:10])
    lines.append("- Recommendation only: I did not request a write tool and nothing was changed.")
    lines.append("- This audit uses bounded website summaries and content previews, not full raw content bodies.")
    return "\n".join(line for line in lines if line)


def _preset_next_action_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _preset_next_action_requested(user_message):
        return ""
    runnability = _result_for_tool(tool_results, "get_current_preset_runnability")
    assets_result = _result_for_tool(tool_results, "get_current_preset_content_assets")
    current_preset = _result_for_tool(tool_results, "get_current_preset_summary")
    if not isinstance(runnability, dict) or not isinstance(assets_result, dict) or not isinstance(current_preset, dict):
        return ""
    if runnability.get("status") not in {"evaluated", "loaded"}:
        return ""
    if assets_result.get("status") != "loaded" or current_preset.get("status") != "loaded":
        return ""

    current_summary = current_preset.get("summary")
    checks = runnability.get("checks")
    assets = assets_result.get("assets")
    if not isinstance(current_summary, dict) or not isinstance(assets, list):
        return ""

    actions = _preset_next_actions(runnability, current_summary, assets, assets_result.get("missing_slots"))
    lines = [
        "Preset next-action plan:",
        f"- Current visible preset: {current_preset.get('name') or current_preset.get('preset_id') or 'unnamed'}",
        f"- Runnable now: {'yes' if runnability.get('runnable') is True else 'no' if runnability.get('runnable') is False else 'unknown'}",
        f"- Blocking reasons: {_join_list(runnability.get('blocking_reasons'))}",
        f"- Warnings: {_join_list(runnability.get('warnings'))}",
        f"- Enabled engines: {_join_list(current_summary.get('enabled_engines'))}",
        f"- Selected models: {_join_list(current_summary.get('selected_models'))}",
        f"- Document count: {current_summary.get('document_count')}" if isinstance(current_summary.get("document_count"), int) else "",
    ]
    if isinstance(checks, dict):
        check_bits = []
        for key in ("has_models", "has_generation_instructions", "has_documents", "has_visible_page_bridge"):
            value = checks.get(key)
            if isinstance(value, bool):
                check_bits.append(f"{key}={'yes' if value else 'no'}")
        if check_bits:
            lines.append(f"- Readiness checks: {', '.join(check_bits)}")
    if actions:
        lines.append("- Prioritized next actions:")
        lines.extend(f"  {index}. {item}" for index, item in enumerate(actions[:8], start=1))
    lines.append("- Recommendation only: I did not request a save, run, or other write tool.")
    lines.append("- If you ask me to perform one of these write actions later, advanced YOLO mode can run the named website tool without a confirmation card.")
    return "\n".join(line for line in lines if line)


def _candidate_content_recommendation_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not (_preset_next_action_requested(user_message) or _repair_continuation_requested(user_message)):
        return ""
    search_results = _candidate_search_results(tool_results)
    if not search_results:
        return ""
    lines = ["Candidate content recommendations:"]
    for search_result in search_results:
        filter_info = search_result.get("filter")
        items = search_result.get("items")
        if not isinstance(filter_info, dict) or not isinstance(items, list):
            continue
        content_type = filter_info.get("content_type")
        candidate_slot = filter_info.get("candidate_slot") or content_type or "any"
        lines.extend(
            [
                f"- Candidate slot type searched: {candidate_slot}",
                f"  - Search text: {filter_info.get('search') or 'none'}",
                f"  - Total matches: {search_result.get('total')}",
            ]
        )
        if not items:
            lines.append("  - No candidate content records were returned by the bounded search.")
            continue
        lines.append("  - Best visible candidates:")
        for item in items[:5]:
            if not isinstance(item, dict):
                continue
            name = item.get("name") or item.get("id")
            item_type = item.get("content_type")
            tags = _join_list(item.get("tags"))
            preview = item.get("body_preview")
            line = f"{name} ({item_type})"
            if tags != "none":
                line = f"{line}; tags: {tags}"
            if isinstance(preview, str) and preview:
                line = f"{line}; preview: {_compact_text(preview, limit=220)}"
            lines.append(f"    - {line}")
    lines.append("- Recommendation only: I did not attach any candidate content record.")
    return "\n".join(line for line in lines if line)


def _candidate_content_search_arguments(state: AdvancedGraphState) -> dict[str, object]:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    tool_results = _tool_results(state.get("messages") or [])
    content_type = _next_candidate_content_type(tool_results) or _content_type_hint(user_message)
    return {
        "content_type": content_type,
        "candidate_slot": content_type,
        "search": _candidate_content_search_query(user_message),
        "tag": _content_tag_query(user_message),
        "folder_path": _content_folder_query(user_message),
        "limit": 75,
    }


def _repair_candidate_search_arguments(state: AdvancedGraphState) -> dict[str, object]:
    return {
        "content_type": "input_document",
        "candidate_slot": "input_document",
        "search": _repair_candidate_search_query(state),
        "tag": None,
        "folder_path": None,
        "limit": 75,
    }


def _repair_candidate_search_needed(tool_results: list[dict[str, object]]) -> bool:
    failure_result = _result_for_tool(tool_results, "get_run_failure_signals")
    log_result = _result_for_tool(tool_results, "load_run_logs_for_assistant")
    category = _classify_run_failure(failure_result, log_result).get("category")
    if category != "missing_input_or_config":
        return False
    if "input_document" in set(_searched_candidate_content_types(tool_results)):
        return False
    return all(
        isinstance(_result_for_tool(tool_results, tool_name), dict)
        for tool_name in (
            "get_current_preset_documents",
            "get_current_preset_instructions",
            "get_current_preset_content_assets",
        )
    )


def _repair_candidate_search_query(state: AdvancedGraphState) -> str | None:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    explicit_query = _candidate_content_search_query(user_message)
    if explicit_query:
        return explicit_query
    tool_results = _tool_results(state.get("messages") or [])
    failure_message = _top_failure_message(_result_for_tool(tool_results, "get_run_failure_signals"))
    if failure_message:
        return failure_message[:120]
    return None


def _candidate_content_search_needed(tool_results: list[dict[str, object]]) -> bool:
    return _next_candidate_content_type(tool_results) is not None


def _next_candidate_content_type(tool_results: list[dict[str, object]]) -> str | None:
    searched = set(_searched_candidate_content_types(tool_results))
    for content_type in _candidate_content_types(tool_results):
        if content_type not in searched:
            return content_type
    return None


def _candidate_content_types(tool_results: list[dict[str, object]]) -> list[str]:
    runnability = _result_for_tool(tool_results, "get_current_preset_runnability")
    assets_result = _result_for_tool(tool_results, "get_current_preset_content_assets")
    current_preset = _result_for_tool(tool_results, "get_current_preset_summary")
    if not isinstance(runnability, dict) or not isinstance(assets_result, dict) or not isinstance(current_preset, dict):
        return []

    checks = runnability.get("checks")
    assets = assets_result.get("assets")
    current_summary = current_preset.get("summary")
    if not isinstance(assets, list) or not isinstance(current_summary, dict):
        return []
    available_assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("status") != "unavailable"]
    counts = _asset_counts_by_type(available_assets)
    content_types: list[str] = []

    selected_instruction_id = current_summary.get("selected_instruction_id")
    if isinstance(checks, dict) and checks.get("has_generation_instructions") is False:
        content_types.append("generation_instructions")
    if not selected_instruction_id and counts.get("generation_instructions", 0) == 0:
        content_types.append("generation_instructions")

    document_count = current_summary.get("document_count")
    if isinstance(checks, dict) and checks.get("has_documents") is False:
        content_types.append("input_document")
    if isinstance(document_count, int) and document_count == 0 and counts.get("input_document", 0) == 0:
        content_types.append("input_document")
    return _unique_lines(content_types)


def _candidate_content_type(tool_results: list[dict[str, object]]) -> str | None:
    types = _candidate_content_types(tool_results)
    return types[0] if types else None


def _searched_candidate_content_types(tool_results: list[dict[str, object]]) -> list[str]:
    searched: list[str] = []
    for search_result in _candidate_search_results(tool_results):
        filter_info = search_result.get("filter")
        if not isinstance(filter_info, dict):
            continue
        content_type = filter_info.get("candidate_slot") or filter_info.get("content_type")
        if isinstance(content_type, str) and content_type:
            searched.append(content_type)
    return searched


def _candidate_search_results(tool_results: list[dict[str, object]]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for tool_result in tool_results:
        if tool_result.get("tool_name") != "search_content_library_for_assistant":
            continue
        result = tool_result.get("result")
        if isinstance(result, dict) and result.get("status") == "loaded":
            results.append(result)
    return results


def _best_candidate_content(tool_results: list[dict[str, object]], content_type: str) -> dict[str, object] | None:
    for search_result in reversed(_candidate_search_results(tool_results)):
        filter_info = search_result.get("filter")
        items = search_result.get("items")
        if not isinstance(filter_info, dict) or not isinstance(items, list):
            continue
        searched_type = filter_info.get("candidate_slot") or filter_info.get("content_type")
        if searched_type != content_type:
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("content_type") == content_type:
                return item
    return None


def _candidate_content_search_query(user_message: str) -> str | None:
    quoted = _quoted_query(user_message)
    if quoted:
        return quoted
    text = str(user_message).strip()
    lower = text.lower()
    markers = (
        "for topic ",
        "for scenario ",
        "about topic ",
        "about scenario ",
        "related to ",
    )
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = text[start + len(marker):].strip(" .?!:")
        if candidate:
            return candidate[:120]
    return None


def _quoted_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    for quote in ('"', "'"):
        if quote not in text:
            continue
        parts = text.split(quote)
        for index in range(1, len(parts), 2):
            candidate = parts[index].strip()
            if candidate:
                return candidate[:120]
    return None


def _preset_next_actions(
    runnability: dict[str, object],
    current_summary: dict[str, object],
    assets: list[object],
    missing_slots: object,
) -> list[str]:
    actions: list[str] = []
    blocking_reasons = runnability.get("blocking_reasons")
    if isinstance(blocking_reasons, list):
        for reason in blocking_reasons[:5]:
            if reason:
                actions.append(f"Resolve blocker: {reason}.")

    checks = runnability.get("checks")
    if isinstance(checks, dict):
        if checks.get("has_models") is False:
            actions.append("Select at least one model for the enabled engine or engine section before trying to run.")
        if checks.get("has_generation_instructions") is False:
            actions.append("Attach or create generation instructions so the preset has a clear writing/research directive.")
        if checks.get("has_documents") is False:
            actions.append("Attach at least one input document/topic file, or switch the preset to a valid non-document input source.")
        if checks.get("has_visible_page_bridge") is False:
            actions.append("Open the preset editor page so the website can expose the current draft to the assistant tools.")

    available_assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("status") != "unavailable"]
    unavailable_assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("status") == "unavailable"]
    counts = _asset_counts_by_type(available_assets)
    document_count = current_summary.get("document_count")
    selected_instruction_id = current_summary.get("selected_instruction_id")

    if not selected_instruction_id and counts.get("generation_instructions", 0) == 0:
        actions.append("Find or draft a generation-instructions content record, then attach it to the generation instruction slot.")
    if isinstance(document_count, int) and document_count > counts.get("input_document", 0):
        actions.append("Inspect the missing or unavailable input-document attachments because the visible loaded asset count is lower than the preset document count.")
    if unavailable_assets:
        actions.append("Reload or repair unavailable content attachments before trusting the preset audit.")
    if isinstance(missing_slots, list) and any(str(slot).endswith("instructions") for slot in missing_slots):
        actions.append("Decide whether the empty eval/combine instruction slots are intentionally unused or should be filled for quality-control workflows.")

    enabled_engines = current_summary.get("enabled_engines")
    selected_models = current_summary.get("selected_models")
    if isinstance(enabled_engines, list) and enabled_engines and (not isinstance(selected_models, list) or not selected_models):
        actions.append("Enabled engines are present but selected models are missing; choose models before running.")

    if runnability.get("runnable") is True and not actions:
        actions.append("The bounded checks say the preset is runnable; the safest next step is a human review of instructions and source documents before requesting execution.")
    elif runnability.get("runnable") is True:
        actions.append("After the recommendation notes are reviewed, this preset appears runnable from the bounded checks.")

    return _unique_lines(actions)


def _unique_lines(lines: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for line in lines:
        normalized = line.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(normalized)
    return unique


def _asset_counts_by_type(assets: list[object]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        content_type = str(asset.get("content_type") or "unknown")
        counts[content_type] = counts.get(content_type, 0) + 1
    return counts


def _attached_content_recommendations(
    current_summary: dict[str, object],
    assets: list[object],
    missing_slots: object,
) -> list[str]:
    available_assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("status") != "unavailable"]
    unavailable_assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("status") == "unavailable"]
    counts = _asset_counts_by_type(available_assets)
    recommendations: list[str] = []

    generation_count = counts.get("generation_instructions", 0)
    input_count = counts.get("input_document", 0)
    document_count = current_summary.get("document_count")
    selected_instruction_id = current_summary.get("selected_instruction_id")

    if generation_count == 0 and not selected_instruction_id:
        recommendations.append("No loaded generation instruction was visible, and the preset summary does not show a selected generation instruction.")
    elif generation_count > 1:
        recommendations.append("More than one generation-instruction asset is visible; confirm which one is the actual active generation slot before making changes.")
    elif generation_count == 1:
        recommendations.append("One generation-instruction asset is visible, which matches the expected single active generation-instruction role.")

    if isinstance(document_count, int):
        if document_count == 0 and input_count == 0:
            recommendations.append("No input documents are visible in either the preset summary or attached content assets.")
        elif input_count != document_count:
            recommendations.append("The attached input-document asset count does not match the preset summary document count, so the visible bridge may be incomplete or some documents could not be loaded.")
        else:
            recommendations.append("The attached input-document asset count matches the preset summary document count.")

    if unavailable_assets:
        recommendations.append("Some attachment ids could not be loaded from the content library; inspect those records before trusting the preset as complete.")

    if isinstance(missing_slots, list) and missing_slots:
        recommendations.append("The visible draft reported empty attachment slots; this may be normal for optional eval/combine roles, but required generation/source roles should be checked.")

    enabled_engines = current_summary.get("enabled_engines")
    if not isinstance(enabled_engines, list) or not enabled_engines:
        recommendations.append("The current preset summary does not show enabled engines; attached content alone is not enough for execution readiness.")

    if not recommendations:
        recommendations.append("The bounded facts did not reveal obvious attached-content gaps, but this is still a preview-level audit.")

    return recommendations


def _result_for_tool(tool_results: list[dict[str, object]], tool_name: str) -> object:
    for tool_result in reversed(tool_results):
        if tool_result.get("tool_name") == tool_name:
            return tool_result.get("result")
    return None


def _results_for_tool(tool_results: list[dict[str, object]], tool_name: str) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for tool_result in tool_results:
        if tool_result.get("tool_name") != tool_name:
            continue
        result = tool_result.get("result")
        if isinstance(result, dict):
            results.append(result)
    return results


def _append_difference(lines: list[str], label: str, current_value: object, loaded_value: object) -> None:
    current_normalized = _normalize_compare_value(current_value)
    loaded_normalized = _normalize_compare_value(loaded_value)
    if current_normalized == loaded_normalized:
        return
    lines.append(f"{label}: current={current_normalized}; loaded={loaded_normalized}")


def _normalize_compare_value(value: object) -> str:
    if isinstance(value, list):
        return ", ".join(str(item) for item in value if str(item)) or "none"
    if value is True:
        return "yes"
    if value is False:
        return "no"
    if value is None or value == "":
        return "none"
    return str(value)


def _run_status_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The run status tool did not return loaded run facts."
    run_id = result.get("run_id")
    summary = result.get("summary")
    if not isinstance(summary, dict):
        return ""
    lines = [
        "Run status:",
        f"- Run ID: {run_id}" if isinstance(run_id, str) and run_id else "",
        f"- State: {summary.get('state')}",
        f"- Finished: {_yes_no(summary.get('finished'))}",
        f"- Research completed: {_yes_no(summary.get('research_completed'))}",
        f"- Outputs available: {_yes_no(summary.get('outputs_available'))}",
        f"- Generated document count: {summary.get('generated_document_count')}",
    ]
    return "\n".join(line for line in lines if line)


def _recent_runs_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    status = result.get("status")
    if status not in {None, "loaded", "ok"}:
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The recent-runs tool did not return loaded run facts."
    raw_items = result.get("runs")
    if not isinstance(raw_items, list):
        raw_items = result.get("items")
    if not isinstance(raw_items, list):
        raw_items = result.get("recent_runs")
    lines = [
        "Recent runs:",
        f"- Total visible: {result.get('total')}" if result.get("total") is not None else "",
        f"- Source: {result.get('source')}" if isinstance(result.get("source"), str) else "",
    ]
    if isinstance(raw_items, list):
        if not raw_items:
            lines.append("- No recent runs were returned by the website tool.")
        for item in raw_items[:10]:
            if not isinstance(item, dict):
                continue
            run_id = item.get("id") or item.get("run_id")
            state = item.get("state") or item.get("status")
            preset_name = item.get("preset_name") or item.get("preset") or item.get("name")
            created_at = item.get("created_at") or item.get("started_at") or item.get("updated_at")
            label_parts = [
                str(preset_name) if isinstance(preset_name, str) and preset_name else "",
                str(state) if isinstance(state, str) and state else "",
                str(run_id) if isinstance(run_id, str) and run_id else "",
                str(created_at) if isinstance(created_at, str) and created_at else "",
            ]
            label = " | ".join(part for part in label_parts if part)
            if label:
                lines.append(f"- {label}")
        if len(raw_items) > 10:
            lines.append(f"- ...and {len(raw_items) - 10} more returned by the website tool.")
    return "\n".join(line for line in lines if line)


def _latest_run_context_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The latest-run tool did not return loaded run facts."

    run = result.get("run")
    status_summary = result.get("status_summary")
    failure_signals = result.get("failure_signals")
    output_summary = result.get("output_summary")

    lines = ["Latest run result:"]
    if isinstance(run, dict):
        run_id = run.get("id") or result.get("latest_run_id")
        lines.extend(
            [
                f"- Run ID: {run_id}" if isinstance(run_id, str) and run_id else "",
                f"- Name: {run.get('name')}" if isinstance(run.get("name"), str) and run.get("name") else "",
                f"- State: {run.get('status')}",
                f"- Finished: {_yes_no(run.get('finished'))}",
                f"- Outputs available: {_yes_no(run.get('outputs_available'))}",
                f"- Generated document count: {run.get('generated_document_count')}",
            ]
        )
        error_message = run.get("error_message")
        if isinstance(error_message, str) and error_message:
            lines.append(f"- Error: {error_message}")
    elif isinstance(result.get("latest_run_id"), str):
        lines.append(f"- Run ID: {result.get('latest_run_id')}")

    if isinstance(status_summary, dict):
        status_text = _run_status_text(status_summary)
        if status_text:
            lines.extend(["", status_text])
    if isinstance(failure_signals, dict):
        failure_text = _run_failure_text(failure_signals)
        if failure_text:
            lines.extend(["", failure_text])
    if isinstance(output_summary, dict):
        output_text = _run_output_text(output_summary)
        if output_text:
            lines.extend(["", output_text])

    return "\n".join(line for line in lines if line)


def _loaded_run_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The run load tool did not return loaded run facts."
    run = result.get("run")
    if not isinstance(run, dict):
        return ""
    lines = [
        "Loaded run:",
        f"- Run ID: {run.get('id')}",
        f"- Name: {run.get('name')}" if isinstance(run.get("name"), str) and run.get("name") else "",
        f"- State: {run.get('status')}",
        f"- Finished: {_yes_no(run.get('finished'))}",
        f"- Outputs available: {_yes_no(run.get('outputs_available'))}",
        f"- Generated document count: {run.get('generated_document_count')}",
    ]
    error_message = run.get("error_message")
    if isinstance(error_message, str) and error_message:
        lines.append(f"- Error: {error_message}")
    return "\n".join(line for line in lines if line)


def _preset_list_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The preset list tool did not return loaded preset facts."
    items = result.get("items")
    lines = [
        "Loaded presets:",
        f"- Total: {result.get('total')}",
        f"- Source: {result.get('source')}",
    ]
    if isinstance(items, list):
        for item in items[:12]:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            preset_id = item.get("id")
            runnable = item.get("runnable")
            label = name if isinstance(name, str) and name else preset_id
            if label:
                suffix = " runnable" if runnable is True else " not runnable" if runnable is False else ""
                lines.append(f"- {label}{suffix}")
        if len(items) > 12:
            lines.append(f"- ...and {len(items) - 12} more shown by the website tool.")
    return "\n".join(line for line in lines if line)


def _loaded_preset_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    status = result.get("status")
    if status != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The requested preset could not be loaded."
    summary = result.get("summary")
    if not isinstance(summary, dict):
        return ""
    lines = [
        "Loaded preset:",
        f"- Name: {result.get('name')}",
        f"- Preset ID: {result.get('preset_id')}",
        f"- Enabled engines: {_join_list(summary.get('enabled_engines'))}",
        f"- Selected models: {_join_list(summary.get('selected_models'))}",
        f"- Document count: {summary.get('document_count')}",
        f"- Generation instructions attached: {_yes_no(summary.get('generation_instructions_attached'))}",
        f"- Single-eval instructions attached: {_yes_no(summary.get('single_eval_instructions_attached'))}",
        f"- Pairwise-eval instructions attached: {_yes_no(summary.get('pairwise_eval_instructions_attached'))}",
        f"- Combine instructions attached: {_yes_no(summary.get('combine_instructions_attached'))}",
        f"- Input source: {summary.get('input_source_type')}",
        f"- Active search provider: {summary.get('active_search_provider')}",
    ]
    return "\n".join(line for line in lines if line)


def _content_library_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The content library tool did not return loaded content facts."
    lines = [
        "Content library summary:",
        f"- Total: {result.get('total')}",
        f"- Source: {result.get('source')}",
    ]
    filter_info = result.get("filter")
    if isinstance(filter_info, dict):
        content_type = filter_info.get("content_type")
        search = filter_info.get("search")
        if content_type:
            lines.append(f"- Content type filter: {content_type}")
        if search:
            lines.append(f"- Search: {search}")
    items = result.get("items")
    if isinstance(items, list):
        for item in items[:12]:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            content_type = item.get("content_type")
            item_id = item.get("id")
            label = name if isinstance(name, str) and name else item_id
            if label:
                lines.append(f"- {label} ({content_type})")
    return "\n".join(line for line in lines if line)


def _available_actions_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The website action list was not available."
    readonly = result.get("readonly_tools")
    mutations = result.get("mutation_tools")
    tools = result.get("tools")
    lines = ["Website tools available right now:"]
    if isinstance(readonly, list):
        lines.append(f"- Read-only tools: {_join_list(readonly)}")
    elif isinstance(tools, list):
        lines.append(f"- Tools: {_join_list(tools)}")
    if isinstance(mutations, list):
        lines.append(f"- YOLO write tools: {_join_list(mutations)}")
    yolo_mode = result.get("yolo_mode")
    if isinstance(yolo_mode, bool):
        lines.append(f"- Advanced YOLO mode: {'on' if yolo_mode else 'off'}")
    note = result.get("note")
    if isinstance(note, str) and note:
        lines.append(f"- Boundary: {_compact_text(note, limit=240)}")
    return "\n".join(lines)


def _content_search_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The content search tool did not return loaded content facts."
    lines = [
        "Content library search:",
        f"- Total matches: {result.get('total')}",
    ]
    filter_info = result.get("filter")
    if isinstance(filter_info, dict):
        filter_bits = []
        for key in ("content_type", "search", "tag", "folder_path", "limit"):
            value = filter_info.get(key)
            if value not in (None, ""):
                filter_bits.append(f"{key}={value}")
        if filter_bits:
            lines.append(f"- Filters: {', '.join(filter_bits)}")
    returned_summary = result.get("returned_summary")
    if isinstance(returned_summary, dict):
        lines.append(f"- Returned count: {returned_summary.get('returned_count')}")
        lines.append(f"- Returned by type: {_compact_mapping(returned_summary.get('by_type'))}")
        lines.append(f"- Returned by folder: {_compact_mapping(returned_summary.get('by_folder'))}")
        top_tags = returned_summary.get("top_tags")
        if isinstance(top_tags, list) and top_tags:
            tag_labels = []
            for tag in top_tags[:10]:
                if isinstance(tag, dict) and tag.get("name"):
                    tag_labels.append(f"{tag.get('name')}={tag.get('count')}")
            if tag_labels:
                lines.append(f"- Top tags: {', '.join(tag_labels)}")
    folders = result.get("folders")
    if isinstance(folders, list) and folders:
        lines.append(f"- Known folders: {_join_list(folders[:12])}")
    items = result.get("items")
    if isinstance(items, list):
        lines.append("- Matching content:")
        for item in items[:12]:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            content_type = item.get("content_type")
            folder_path = item.get("folder_path")
            tags = item.get("tags")
            preview = item.get("body_preview")
            label = name if isinstance(name, str) and name else item.get("id")
            if not label:
                continue
            suffix_parts = [str(content_type) if content_type else "", str(folder_path) if folder_path else ""]
            suffix = " / ".join(part for part in suffix_parts if part)
            lines.append(f"  - {label}" + (f" ({suffix})" if suffix else ""))
            if isinstance(tags, list) and tags:
                lines.append(f"    tags: {_join_list(tags[:8])}")
            if isinstance(preview, str) and preview:
                lines.append(f"    preview: {_compact_text(preview, limit=180)}")
    return "\n".join(line for line in lines if line)


def _loaded_content_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The requested content record could not be loaded."
    content = result.get("content")
    if not isinstance(content, dict):
        return ""
    lines = [
        "Loaded content:",
        f"- Name: {content.get('name')}",
        f"- Content ID: {content.get('id')}",
        f"- Type: {content.get('content_type')}",
        f"- Folder: {content.get('folder_path')}",
        f"- Body length: {content.get('body_length')}",
        f"- Excerpt character limit: {content.get('excerpt_char_limit')}",
        f"- Excerpt complete: {_yes_no(bool(content.get('body_excerpt_complete')))}",
        f"- Excerpt truncated: {_yes_no(bool(content.get('body_excerpt_truncated')))}",
        f"- Variables: {_join_list(content.get('variable_names'))}",
    ]
    excerpt = content.get("body_excerpt")
    if isinstance(excerpt, str) and excerpt:
        excerpt_limit = content.get("excerpt_char_limit")
        response_limit = 6000 if isinstance(excerpt_limit, int) and excerpt_limit > 4000 else 1600
        lines.extend(["- Body excerpt:", excerpt[:response_limit]])
    return "\n".join(line for line in lines if line)


def _preset_content_assets_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The preset content-asset tool did not return loaded facts."
    lines = [
        "Current preset content assets:",
        f"- Preset ID: {result.get('preset_id')}",
        f"- Attached count: {result.get('attached_count')}",
    ]
    assets = result.get("assets")
    if isinstance(assets, list):
        for item in assets[:20]:
            if not isinstance(item, dict):
                continue
            slot = item.get("slot")
            name = item.get("name") or item.get("id")
            content_type = item.get("content_type")
            status = item.get("status")
            if name:
                suffix = f" ({content_type})" if content_type else ""
                unavailable = " unavailable" if status == "unavailable" else ""
                lines.append(f"- {slot}: {name}{suffix}{unavailable}")
    missing = result.get("missing_slots")
    if isinstance(missing, list) and missing:
        lines.append(f"- Missing slots: {_join_list(missing)}")
    return "\n".join(line for line in lines if line)


def _preset_save_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("cancelled") is True or result.get("status") == "cancelled":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "Preset save was cancelled. I did not save anything."
    status = result.get("status")
    if status not in {"saved", "updated", "created"}:
        message = result.get("message")
        result_payload = result.get("result")
        if not isinstance(message, str) and isinstance(result_payload, dict):
            message = result_payload.get("message")
        if isinstance(message, str) and message:
            return f"Preset save was blocked: {message}"
        return "The preset save tool did not report a successful save."
    result_payload = result.get("result")
    verification = result.get("verification")
    preset_name = None
    preset_id = None
    if isinstance(result_payload, dict):
        preset_name = result_payload.get("preset_name") or result_payload.get("name")
        preset_id = result_payload.get("preset_id") or result_payload.get("id")
    if isinstance(verification, dict):
        preset_name = preset_name or verification.get("name")
        preset_id = preset_id or verification.get("preset_id")
    lines = [
        "Preset save result:",
        f"- Status: {status}",
        f"- Preset name: {preset_name}" if isinstance(preset_name, str) and preset_name else "",
        f"- Preset ID: {preset_id}" if isinstance(preset_id, str) and preset_id else "",
        "- Verification: visible draft was re-read after save." if isinstance(verification, dict) else "",
    ]
    return "\n".join(line for line in lines if line)


def _content_create_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    status = result.get("status")
    if status != "created":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The content creation tool did not report a successful create."
    content = result.get("content")
    if not isinstance(content, dict):
        return "Content creation result: created."
    lines = [
        "Content creation result:",
        "- Status: created",
        f"- Name: {content.get('name')}" if isinstance(content.get("name"), str) else "",
        f"- Content ID: {content.get('id')}" if isinstance(content.get("id"), str) else "",
        f"- Type: {content.get('content_type')}" if isinstance(content.get("content_type"), str) else "",
        f"- Body length: {content.get('body_length')}" if isinstance(content.get("body_length"), int) else "",
        "- The logged-in website created this content-library record through its normal frontend client.",
    ]
    return "\n".join(line for line in lines if line)


def _content_update_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    status = result.get("status")
    if status != "updated":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The content update tool did not report a successful update."
    content = result.get("content")
    name = content.get("name") if isinstance(content, dict) else None
    content_id = content.get("id") if isinstance(content, dict) else None
    lines = [
        "Content update result:",
        "- Status: updated",
        f"- Name: {name}" if isinstance(name, str) and name else "",
        f"- Content ID: {content_id}" if isinstance(content_id, str) and content_id else "",
    ]
    return "\n".join(line for line in lines if line)


def _start_new_preset_draft_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    status = result.get("status")
    if status not in {"started_new_draft", "started"}:
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The clean-draft tool did not report a successful reset."
    previous_preset_id = result.get("previous_preset_id")
    verification = result.get("verification")
    preset_id = None
    if isinstance(verification, dict):
        preset_id = verification.get("preset_id")
    lines = [
        "Clean preset draft result:",
        f"- Status: {status}",
        f"- Previous preset ID cleared from draft: {previous_preset_id}" if isinstance(previous_preset_id, str) and previous_preset_id else "- Previous preset ID cleared from draft: none was active",
        f"- Verification preset ID after reset: {preset_id}" if isinstance(preset_id, str) and preset_id else "- Verification preset ID after reset: none",
        "- This prevents a from-scratch save from accidentally updating the previously loaded preset.",
    ]
    return "\n".join(line for line in lines if line)


def _configure_fpf_preset_draft_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    status = result.get("status")
    if status != "configured":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The FPF draft configuration tool did not report a successful configuration."
    lines = [
        "FPF draft configuration result:",
        "- Status: configured",
        f"- Preset name: {result.get('preset_name')}" if isinstance(result.get("preset_name"), str) else "",
        f"- Engine: {result.get('engine')}" if isinstance(result.get("engine"), str) else "",
        f"- Model: {result.get('model')}" if isinstance(result.get("model"), str) else "",
        f"- Generation instructions ID: {result.get('generation_instructions_id')}" if isinstance(result.get("generation_instructions_id"), str) else "",
        f"- Input document IDs: {_join_list(result.get('input_document_ids'))}",
        "- Non-FPF engine model selections were cleared for this milestone.",
    ]
    return "\n".join(line for line in lines if line)


def _fpf_preset_from_scratch_text(state: AdvancedGraphState, tool_results: list[dict[str, object]]) -> str:
    user_message = state.get("current_user_message") or _latest_user_message(state.get("messages") or [])
    if not _fpf_preset_from_scratch_requested(user_message):
        return ""
    generation = _created_content_result(tool_results, "generation_instructions")
    input_doc = _created_content_result(tool_results, "input_document")
    config = _result_for_tool(tool_results, "configure_fpf_preset_draft")
    save = _result_for_tool(tool_results, "save_current_preset_draft")
    runnability = _result_for_tool(tool_results, "get_current_preset_runnability")
    if not any(isinstance(item, dict) for item in (generation, input_doc, config, save, runnability)):
        return ""

    generation_content = generation.get("content") if isinstance(generation, dict) else None
    input_content = input_doc.get("content") if isinstance(input_doc, dict) else None
    preset_name = config.get("preset_name") if isinstance(config, dict) else None
    model = config.get("model") if isinstance(config, dict) else "openai:gpt-5-mini"
    preset_id = None
    if isinstance(save, dict):
        result_payload = save.get("result")
        verification = save.get("verification")
        if isinstance(result_payload, dict):
            preset_id = result_payload.get("preset_id") or result_payload.get("id")
            preset_name = preset_name or result_payload.get("preset_name") or result_payload.get("name")
        if isinstance(verification, dict):
            preset_id = preset_id or verification.get("preset_id")
            preset_name = preset_name or verification.get("name")
    runnable = None
    if isinstance(runnability, dict):
        runnable = runnability.get("runnable")
        if runnable is None:
            runnable = runnability.get("is_runnable")

    lines = ["FPF preset-from-scratch workflow:"]
    if isinstance(preset_name, str) and preset_name:
        lines.append(f"- Preset name: {preset_name}")
    if isinstance(preset_id, str) and preset_id:
        lines.append(f"- Saved preset ID: {preset_id}")
    if isinstance(generation_content, dict):
        lines.append(f"- Generation instructions asset: {generation_content.get('name')} ({generation_content.get('id')})")
    if isinstance(input_content, dict):
        lines.append(f"- Input document asset: {input_content.get('name')} ({input_content.get('id')})")
    lines.append("- Engine: FPF only")
    lines.append(f"- Model: {model if isinstance(model, str) and model else 'openai:gpt-5-mini'}")
    if runnable is not None:
        lines.append(f"- Runnability: {_yes_no(runnable)}")
    quality = _fpf_semantic_quality_assessment(tool_results)
    if quality:
        lines.extend(quality)
    if isinstance(save, dict):
        lines.append("- Save: completed through the logged-in website.")
    else:
        lines.append("- Save: pending.")
    lines.append("- Secret boundary: LangGraph still did not receive browser tokens, database keys, provider keys, or raw backend API authority.")
    return "\n".join(line for line in lines if line)


def _fpf_semantic_quality_assessment(tool_results: list[dict[str, object]]) -> list[str]:
    generation_updated = _updated_created_content_result(tool_results, "generation_instructions")
    input_updated = _updated_created_content_result(tool_results, "input_document")
    generation_loaded = _loaded_created_content_result(tool_results, "generation_instructions")
    input_loaded = _loaded_created_content_result(tool_results, "input_document")
    if not any(isinstance(item, dict) for item in (generation_updated, input_updated, generation_loaded, input_loaded)):
        return []
    if isinstance(generation_updated, dict) and isinstance(input_updated, dict):
        return [
            "Semantic quality verification:",
            "- Status: passes deterministic FPF starter quality contract",
            "- The graph created both assets, re-read both assets, detected missing improvement-pass sections, and updated both assets before saving.",
            "- The generated assets include goal decomposition, source boundaries, uncertainty handling, forbidden behavior, and an improvement-pass note.",
            "- Limitation: this verifies structure and doctrine coverage, not factual output quality from a future run.",
        ]
    missing = []
    for content_type, result in (
        ("generation_instructions", generation_updated or generation_loaded),
        ("input_document", input_updated or input_loaded),
    ):
        content = result.get("content") if isinstance(result, dict) else None
        body = ""
        if isinstance(content, dict):
            body = str(content.get("body_preview") or content.get("body_excerpt") or "")
        missing.extend(f"{content_type}: {item}" for item in _fpf_content_missing_quality_sections(body, content_type))
    lines = ["Semantic quality verification:"]
    if missing:
        lines.append("- Status: needs improvement")
        lines.append(f"- Missing quality sections: {_join_list(missing[:8])}")
    else:
        lines.append("- Status: passes deterministic FPF starter quality contract")
        lines.append("- The generated assets include goal decomposition, source boundaries, uncertainty handling, forbidden behavior, and an improvement-pass note.")
    lines.append("- Limitation: this verifies structure and doctrine coverage, not factual output quality from a future run.")
    return lines


def _preset_execution_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("cancelled") is True or result.get("status") == "cancelled":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "Preset execution was cancelled. I did not start a run."
    status = result.get("status")
    if status != "started":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The preset execution tool did not report a started run."
    result_payload = result.get("result")
    run_id = result.get("run_id")
    execute_url = result.get("execute_url")
    if isinstance(result_payload, dict):
        run_id = run_id or result_payload.get("run_id")
        execute_url = execute_url or result_payload.get("execute_url")
    lines = [
        "Preset execution result:",
        "- Status: started",
        f"- Run ID: {run_id}" if isinstance(run_id, str) and run_id else "",
        f"- Execute URL: {execute_url}" if isinstance(execute_url, str) and execute_url else "",
        "- The logged-in website page created and started the run through its normal execution workflow.",
    ]
    return "\n".join(line for line in lines if line)


def _attach_generation_instructions_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("cancelled") is True or result.get("status") == "cancelled":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "Generation-instructions attachment was cancelled. I did not change the preset draft."
    status = result.get("status")
    if status != "updated":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The generation-instructions attach tool did not report a successful draft update."

    content = result.get("content")
    verification = result.get("verification")
    instruction_id = result.get("generation_instructions_id")
    content_name = None
    if isinstance(content, dict):
        content_name = content.get("name")
    selected_instruction_id = None
    if isinstance(verification, dict):
        summary = verification.get("summary")
        if isinstance(summary, dict):
            selected_instruction_id = summary.get("selected_instruction_id")
    lines = [
        "Generation-instructions attachment result:",
        "- Status: updated visible preset draft",
        f"- Attached content: {content_name}" if isinstance(content_name, str) and content_name else "",
        f"- Generation instructions ID: {instruction_id}" if isinstance(instruction_id, str) and instruction_id else "",
        f"- Verification selected instruction ID: {selected_instruction_id}" if isinstance(selected_instruction_id, str) and selected_instruction_id else "",
        "- Save still required: this updated the visible draft only; saving the preset remains a separate website action.",
    ]
    return "\n".join(line for line in lines if line)


def _attach_input_document_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("cancelled") is True or result.get("status") == "cancelled":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "Input-document attachment was cancelled. I did not change the preset draft."
    status = result.get("status")
    if status not in {"updated", "unchanged"}:
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The input-document attach tool did not report a successful draft update."

    content = result.get("content")
    verification = result.get("verification")
    document_id = result.get("input_document_id")
    content_name = None
    if isinstance(content, dict):
        content_name = content.get("name")
    document_count = None
    selected_documents = []
    if isinstance(verification, dict):
        summary = verification.get("summary")
        if isinstance(summary, dict):
            document_count = summary.get("document_count")
            raw_documents = summary.get("selected_documents")
            if isinstance(raw_documents, list):
                selected_documents = [
                    item.get("name")
                    for item in raw_documents
                    if isinstance(item, dict) and isinstance(item.get("name"), str)
                ][:5]
    status_text = "already attached" if status == "unchanged" else "updated visible preset draft"
    lines = [
        "Input-document attachment result:",
        f"- Status: {status_text}",
        f"- Attached content: {content_name}" if isinstance(content_name, str) and content_name else "",
        f"- Input document ID: {document_id}" if isinstance(document_id, str) and document_id else "",
        f"- Verification document count: {document_count}" if isinstance(document_count, int) else "",
        f"- Verification selected documents: {', '.join(selected_documents)}" if selected_documents else "",
        "- Save still required: this updated the visible draft only; saving the preset remains a separate website action.",
    ]
    return "\n".join(line for line in lines if line)


def _attach_eval_asset_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("cancelled") is True or result.get("status") == "cancelled":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "Eval attachment was cancelled. I did not change the preset draft."
    status = result.get("status")
    if status != "updated":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The eval attach tool did not report a successful draft update."

    content = result.get("content")
    verification = result.get("verification")
    content_name = None
    if isinstance(content, dict):
        content_name = content.get("name")
    content_type = result.get("content_type")
    draft_path = result.get("draft_path")
    eval_asset_id = result.get("eval_asset_id")
    verified_slot = None
    verified_id = None
    if isinstance(verification, dict):
        instructions = verification.get("instructions")
        if isinstance(instructions, dict):
            for slot, details in instructions.items():
                if isinstance(details, dict) and details.get("id") == eval_asset_id:
                    verified_slot = slot
                    verified_id = details.get("id")
                    break
    lines = [
        "Eval attachment result:",
        "- Status: updated visible preset draft",
        f"- Attached content: {content_name}" if isinstance(content_name, str) and content_name else "",
        f"- Content type: {content_type}" if isinstance(content_type, str) and content_type else "",
        f"- Draft path updated: {draft_path}" if isinstance(draft_path, str) and draft_path else "",
        f"- Eval asset ID: {eval_asset_id}" if isinstance(eval_asset_id, str) and eval_asset_id else "",
        f"- Verification slot: {verified_slot}" if isinstance(verified_slot, str) and verified_slot else "",
        f"- Verification ID: {verified_id}" if isinstance(verified_id, str) and verified_id else "",
        "- Save still required: this updated the visible draft only; saving the preset remains a separate website action.",
    ]
    return "\n".join(line for line in lines if line)


def _attach_combine_instructions_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("cancelled") is True or result.get("status") == "cancelled":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "Combine-instructions attachment was cancelled. I did not change the preset draft."
    status = result.get("status")
    if status != "updated":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The combine-instructions attach tool did not report a successful draft update."

    content = result.get("content")
    verification = result.get("verification")
    instruction_id = result.get("combine_instructions_id")
    content_name = None
    if isinstance(content, dict):
        content_name = content.get("name")
    verified_id = None
    if isinstance(verification, dict):
        instructions = verification.get("instructions")
        if isinstance(instructions, dict):
            combine = instructions.get("combine")
            if isinstance(combine, dict):
                verified_id = combine.get("id")
    lines = [
        "Combine-instructions attachment result:",
        "- Status: updated visible preset draft",
        f"- Attached content: {content_name}" if isinstance(content_name, str) and content_name else "",
        f"- Combine instructions ID: {instruction_id}" if isinstance(instruction_id, str) and instruction_id else "",
        f"- Verification combine instruction ID: {verified_id}" if isinstance(verified_id, str) and verified_id else "",
        "- Save still required: this updated the visible draft only; saving the preset remains a separate website action.",
    ]
    return "\n".join(line for line in lines if line)


def _model_selection_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("cancelled") is True or result.get("status") == "cancelled":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "Model selection was cancelled. I did not change the preset draft."
    status = result.get("status")
    if status != "updated":
        message = result.get("message")
        return str(message) if isinstance(message, str) and message else "The model selection tool did not report a successful draft update."

    engine = result.get("engine")
    selected_models = result.get("selected_models")
    enabled = result.get("enabled")
    verification = result.get("verification")
    verified_models = None
    if isinstance(verification, dict):
        models = verification.get("models")
        if isinstance(models, dict):
            by_engine = models.get("by_engine")
            if isinstance(by_engine, dict) and isinstance(engine, str):
                verified_models = by_engine.get(engine)
    lines = [
        "Model selection result:",
        "- Status: updated visible preset draft",
        f"- Engine: {engine}" if isinstance(engine, str) and engine else "",
        f"- Enabled: {_yes_no(enabled)}",
        f"- Selected models: {_join_list(selected_models)}",
        f"- Verification selected models for engine: {_join_list(verified_models)}" if verified_models is not None else "",
        "- Save still required: this updated the visible draft only; saving the preset remains a separate website action.",
    ]
    return "\n".join(line for line in lines if line)


def _run_failure_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The run failure tool did not return loaded failure facts."
    signals = result.get("signals")
    if not isinstance(signals, dict):
        return ""
    lines = [
        "Run failure signals:",
        f"- Severity: {signals.get('severity')}",
        f"- Top errors: {_join_list(signals.get('top_errors'))}",
        f"- Warnings: {_join_list(signals.get('warnings'))}",
    ]
    classification = _classify_run_failure(result, None)
    if classification.get("category") != "unknown":
        lines.append(f"- Failure type: {classification.get('category')}")
    evidence = signals.get("evidence")
    if isinstance(evidence, list):
        for item in evidence[:5]:
            if not isinstance(item, dict):
                continue
            message = item.get("message")
            if isinstance(message, str) and message:
                lines.append(f"- Evidence: {message}")
    return "\n".join(line for line in lines if line)


def _run_output_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The run output tool did not return loaded output facts."
    outputs = result.get("outputs")
    if not isinstance(outputs, dict):
        return ""
    lines = [
        "Run output summary:",
        f"- Run ID: {result.get('run_id')}",
        f"- Generated document count: {outputs.get('generated_document_count')}",
        f"- Outputs available: {_yes_no(outputs.get('outputs_available'))}",
    ]
    items = outputs.get("items")
    if isinstance(items, list):
        for item in items[:8]:
            if not isinstance(item, dict):
                continue
            label = item.get("title") or item.get("id")
            if label:
                lines.append(f"- {label}")
    return "\n".join(line for line in lines if line)


def _run_logs_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The run-log tool did not return loaded log facts."
    log_window = result.get("log_window")
    summary = result.get("summary")
    run_summary = result.get("run_summary")
    lines = [
        "Run log inspection:",
        f"- Run ID: {result.get('run_id')}",
        f"- Classification: {result.get('classification')}",
    ]
    if isinstance(log_window, dict):
        lines.extend(
            [
                f"- Returned entries: {log_window.get('returned_entries')}",
                f"- Response total: {log_window.get('response_total')}",
                f"- Raw entries omitted: {_yes_no(log_window.get('raw_entries_omitted_from_assistant_payload'))}",
            ]
        )
    if isinstance(run_summary, dict):
        lines.extend(
            [
                f"- Run state: {run_summary.get('state')}",
                f"- Finished: {_yes_no(run_summary.get('finished'))}",
                f"- Generated document count: {run_summary.get('generated_document_count')}",
            ]
        )
    if isinstance(summary, dict):
        lines.append(f"- Level counts: {_compact_mapping(summary.get('level_counts'))}")
        lines.append(f"- Event type counts: {_compact_mapping(summary.get('event_type_counts'))}")
    for label, key in (
        ("Concrete failure evidence", "concrete_failure_evidence"),
        ("Warnings", "warnings"),
        ("Notable events", "notable_events"),
        ("Queue/worker samples", "queue_or_worker_samples"),
        ("Sampled entries", "sampled_entries"),
    ):
        items = result.get(key)
        if not isinstance(items, list) or not items:
            continue
        lines.append(f"- {label}:")
        for item in items[:5]:
            if not isinstance(item, dict):
                continue
            message = item.get("message")
            prefix_parts = [
                str(item.get("level")) if item.get("level") else "",
                str(item.get("event_type")) if item.get("event_type") else "",
                str(item.get("source")) if item.get("source") else "",
            ]
            prefix = " / ".join(part for part in prefix_parts if part)
            if isinstance(message, str) and message:
                lines.append(f"  - {prefix}: {message}" if prefix else f"  - {message}")
    artifact_evidence = result.get("artifact_evidence_from_logs")
    if isinstance(artifact_evidence, dict):
        lines.append(
            "- Artifact evidence: "
            f"generated_save_events={artifact_evidence.get('generated_save_event_count')}, "
            f"generated_file_save_messages={artifact_evidence.get('generated_file_save_message_count')}, "
            f"eval_save_events={artifact_evidence.get('eval_save_event_count')}"
        )
    return "\n".join(line for line in lines if line)


def _preset_models_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The model tool did not return loaded model facts."
    models = result.get("models")
    if not isinstance(models, dict):
        return ""
    by_engine = models.get("by_engine")
    selected = models.get("selected_models")
    lines = [
        "Preset models:",
        f"- Selected models: {_join_list(selected)}",
    ]
    if isinstance(by_engine, dict):
        for engine, engine_models in by_engine.items():
            lines.append(f"- {engine}: {_join_list(engine_models)}")
    return "\n".join(lines)


def _preset_documents_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The document tool did not return loaded document facts."
    documents = result.get("documents")
    if not isinstance(documents, dict):
        return ""
    count = documents.get("document_count")
    items = documents.get("items")
    lines = [
        "Preset documents:",
        f"- Document count: {count}" if isinstance(count, int) else "",
    ]
    if isinstance(items, list):
        for item in items[:12]:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            doc_id = item.get("id")
            label = name if isinstance(name, str) and name else doc_id
            if label:
                lines.append(f"- {label}")
    return "\n".join(line for line in lines if line)


def _preset_instructions_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The instruction tool did not return loaded instruction facts."
    instructions = result.get("instructions")
    if not isinstance(instructions, dict):
        return ""
    lines = ["Preset instructions:"]
    for key in ("generation", "single_eval", "pairwise_eval", "combine"):
        value = instructions.get(key)
        if not isinstance(value, dict):
            continue
        attached = value.get("attached")
        if attached:
            title = value.get("title")
            item_id = value.get("id")
            label = title if isinstance(title, str) and title else item_id
            lines.append(f"- {key}: attached ({label})")
        else:
            lines.append(f"- {key}: not attached")
    return "\n".join(lines)


def _preset_runnability_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    status = result.get("status")
    if status not in {"evaluated", "loaded"}:
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The runnability tool did not return an evaluated preset."

    subject = result.get("subject")
    preset_id = subject.get("preset_id") if isinstance(subject, dict) else result.get("preset_id")
    runnable = result.get("runnable")
    blocking_reasons = result.get("blocking_reasons")
    warnings = result.get("warnings")
    checks = result.get("checks")

    lines = [
        "Preset runnability:",
        f"- Preset ID: {preset_id}" if isinstance(preset_id, str) and preset_id else "",
        f"- Runnable: {'yes' if runnable is True else 'no' if runnable is False else 'unknown'}",
        f"- Blocking reasons: {_join_list(blocking_reasons)}",
        f"- Warnings: {_join_list(warnings)}",
    ]
    if isinstance(checks, dict):
        for key in ("has_models", "has_generation_instructions", "has_documents", "has_visible_page_bridge"):
            value = checks.get(key)
            if isinstance(value, bool):
                lines.append(f"- {key}: {'yes' if value else 'no'}")
    return "\n".join(line for line in lines if line)


def _preset_summary_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    if result.get("status") != "loaded":
        message = result.get("message")
        return str(message) if isinstance(message, str) else "The preset summary tool did not return a loaded preset."

    name = result.get("name")
    preset_id = result.get("preset_id")
    summary = result.get("summary")
    if not isinstance(summary, dict):
        return ""

    enabled_engines = summary.get("enabled_engines")
    selected_models = summary.get("selected_models")
    document_count = summary.get("document_count")
    selected_instruction_id = summary.get("selected_instruction_id")
    generation_instructions_attached = summary.get("generation_instructions_attached")
    if not isinstance(generation_instructions_attached, bool):
        generation_instructions_attached = bool(selected_instruction_id)
    input_source_type = summary.get("input_source_type")
    search_provider = summary.get("active_search_provider")
    report_modes = summary.get("report_modes")

    lines = [
        "Preset summary:",
        f"- Name: {name}" if isinstance(name, str) and name else "",
        f"- Preset ID: {preset_id}" if isinstance(preset_id, str) and preset_id else "",
        f"- Enabled engines: {_join_list(enabled_engines)}",
        f"- Selected models: {_join_list(selected_models)}",
        f"- Report modes: {_join_list(report_modes)}",
        f"- Document count: {document_count}" if isinstance(document_count, int) else "",
        f"- Generation instructions attached: {_yes_no(generation_instructions_attached)}",
        f"- Selected generation instruction ID: {selected_instruction_id}" if isinstance(selected_instruction_id, str) and selected_instruction_id else "",
        f"- Input source: {input_source_type}" if isinstance(input_source_type, str) and input_source_type else "",
        f"- Active search provider: {search_provider}" if isinstance(search_provider, str) and search_provider else "",
    ]
    return "\n".join(line for line in lines if line)


def _join_list(value: object) -> str:
    if not isinstance(value, list):
        return "none"
    strings = [str(item) for item in value if str(item)]
    return ", ".join(strings) if strings else "none"


def _compact_mapping(value: object) -> str:
    if not isinstance(value, dict):
        return "none"
    parts = [f"{key}={count}" for key, count in list(value.items())[:8]]
    return ", ".join(parts) if parts else "none"


def _yes_no(value: object) -> str:
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return "unknown"


def _preset_name_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    for quote in ('"', "'"):
        if text.count(quote) >= 2:
            parts = text.split(quote)
            for index in range(1, len(parts), 2):
                candidate = parts[index].strip()
                if candidate:
                    return candidate[:120]
    lower = text.lower()
    markers = ("preset named ", "preset called ", "load preset ", "open preset ", "inspect preset ")
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = _trim_trailing_instruction_clause(text[start + len(marker):]).strip(" .?!:")
        if candidate:
            return candidate[:120]
    return None


def _trim_trailing_instruction_clause(value: str) -> str:
    text = str(value).strip()
    lower = text.lower()
    cut_markers = (
        " and summarize",
        " and tell me",
        " and report",
        " and explain",
        " then summarize",
        " then tell me",
        " then report",
        " then explain",
    )
    cut_positions = [lower.find(marker) for marker in cut_markers if lower.find(marker) != -1]
    if cut_positions:
        text = text[: min(cut_positions)].strip()
    return text


def _content_name_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    lower = text.lower()
    content_markers = (
        "content named ",
        "content called ",
        "content titled ",
        "instruction named ",
        "instruction called ",
        "instruction titled ",
        "document named ",
        "document called ",
        "document titled ",
        "load content ",
        "open content ",
        "inspect content ",
        "read content ",
        "load instruction ",
        "open instruction ",
        "inspect instruction ",
        "read instruction ",
        "load document ",
        "open document ",
        "inspect document ",
        "read document ",
        "load the full body of content ",
        "load the full body of instruction ",
        "load the full body of document ",
        "load the full text of content ",
        "load the full text of instruction ",
        "load the full text of document ",
        "load the full content of ",
        "read the full body of content ",
        "read the full body of instruction ",
        "read the full body of document ",
        "read the full text of content ",
        "read the full text of instruction ",
        "read the full text of document ",
        "read the full content of ",
        "read the whole body of content ",
        "read the whole body of instruction ",
        "read the whole body of document ",
        "read the whole instruction ",
        "read the whole document ",
        "read all of content ",
        "read all of instruction ",
        "read all of document ",
        "open the full body of content ",
        "open the full body of instruction ",
        "open the full body of document ",
        "inspect the full body of content ",
        "inspect the full body of instruction ",
        "inspect the full body of document ",
    )
    if any(marker in lower for marker in content_markers):
        for quote in ('"', "'"):
            if quote in text:
                parts = text.split(quote)
                for index in range(1, len(parts), 2):
                    candidate = parts[index].strip()
                    if candidate:
                        return candidate[:120]
        for marker in content_markers:
            start = lower.find(marker)
            if start == -1:
                continue
            candidate = _trim_trailing_instruction_clause(text[start + len(marker):]).strip(" .?!:")
            candidate = _clean_content_fit_candidate(candidate)
            if candidate:
                    return candidate[:120]
    return None


def _deep_content_read_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    if not any(token in text for token in ("content", "instruction", "instructions", "document", "body", "topic file", "prompt")):
        return False
    return any(
        token in text
        for token in (
            "full body",
            "full text",
            "full content",
            "full instruction",
            "full instructions",
            "full document",
            "entire body",
            "entire text",
            "entire content",
            "entire instruction",
            "entire document",
            "complete body",
            "complete text",
            "complete content",
            "complete instruction",
            "complete document",
            "detailed body",
            "detailed content",
            "read all of",
            "read the whole",
            "whole body",
            "whole instruction",
            "whole document",
        )
    )


def _content_compare_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    for quote in ('"', "'"):
        if quote in text:
            parts = text.split(quote)
            for index in range(1, len(parts), 2):
                candidate = parts[index].strip()
                if candidate:
                    return candidate[:120]
    lower = text.lower()
    markers = (
        "compare current preset to instruction ",
        "compare current preset with instruction ",
        "compare current preset against instruction ",
        "compare the current preset to instruction ",
        "compare the current preset with instruction ",
        "compare the current preset against instruction ",
        "compare current preset to content ",
        "compare current preset with content ",
        "compare current preset against content ",
        "compare the current preset to content ",
        "compare the current preset with content ",
        "compare the current preset against content ",
        "compare current preset to document ",
        "compare current preset with document ",
        "compare current preset against document ",
        "compare the current preset to document ",
        "compare the current preset with document ",
        "compare the current preset against document ",
        "compare preset to instruction ",
        "compare preset with instruction ",
        "compare preset against instruction ",
        "compare preset to content ",
        "compare preset with content ",
        "compare preset against content ",
        "compare preset to document ",
        "compare preset with document ",
        "compare preset against document ",
        "should i use instruction ",
        "should i use content ",
        "should i use document ",
        "does instruction ",
        "does content ",
        "does document ",
        "recommend whether instruction ",
        "recommend whether content ",
        "recommend whether document ",
    )
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = text[start + len(marker):].strip(" .?!:")
        candidate = re.sub(r"^(?:named|called|titled)\s+", "", candidate, flags=re.IGNORECASE).strip(" .?!:")
        for suffix in (" fits the current preset", " fit the current preset", " fits this preset", " fit this preset", " is a good fit", " would fit", " for the current preset", " with the current preset", " for current preset", " for this preset", " with this preset", " fits", " fit"):
            lower_candidate = candidate.lower()
            if lower_candidate.endswith(suffix):
                candidate = candidate[: -len(suffix)].strip(" .?!:")
                break
        candidate = _clean_content_fit_candidate(candidate)
        if candidate:
            return candidate[:120]
    return _content_name_query(user_message)


def _recent_content_reference_arguments(state: AdvancedGraphState, user_message: str) -> dict[str, object]:
    """Resolve narrow follow-ups like "that instruction set" from tool facts."""
    text = str(user_message or "").lower()
    if not any(token in text for token in ("that", "this", "it", "the instruction set", "the document", "the content")):
        return {}
    preferred_type = _content_type_hint(user_message)
    for tool_result in reversed(_tool_results(state.get("messages") or [])):
        if tool_result.get("tool_name") == "load_content_for_assistant":
            result = tool_result.get("result")
            if not isinstance(result, dict):
                continue
            content = result.get("content")
            if not isinstance(content, dict):
                continue
            content_type = content.get("content_type")
            if preferred_type and content_type != preferred_type:
                continue
            content_id = content.get("id")
            name = content.get("name")
            return {
                "content_id": content_id if isinstance(content_id, str) and content_id else None,
                "name_query": name if isinstance(name, str) and name else None,
            }
        if tool_result.get("tool_name") == "search_content_library_for_assistant":
            result = tool_result.get("result")
            if not isinstance(result, dict):
                continue
            items = result.get("items")
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                content_type = item.get("content_type")
                if preferred_type and content_type != preferred_type:
                    continue
                content_id = item.get("id")
                name = item.get("name")
                return {
                    "content_id": content_id if isinstance(content_id, str) and content_id else None,
                    "name_query": name if isinstance(name, str) and name else None,
                }
    return {}


def _clean_content_fit_candidate(candidate: str) -> str:
    text = str(candidate).strip(" .?!:")
    text = re.sub(
        r"\s+(?:fit|fits|would fit|is a good fit)\s+(?:this|the current|current)\s+preset$",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\s+(?:for|with|to|into|onto)\s+(?:this|the current|current)\s+preset$",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text.strip(" .?!:")


def _content_type_hint(user_message: str) -> str | None:
    text = str(user_message).lower()
    if "generation" in text and ("instruction" in text or "prompt" in text):
        return "generation_instructions"
    if "single" in text and ("eval" in text or "evaluation" in text):
        return "single_eval_instructions"
    if "pairwise" in text and ("eval" in text or "evaluation" in text):
        return "pairwise_eval_instructions"
    if "combine" in text and ("instruction" in text or "prompt" in text):
        return "combine_instructions"
    if "eval criteria" in text or "evaluation criteria" in text:
        return "eval_criteria"
    if "topic file" in text or "topic files" in text or "topic document" in text:
        return "input_document"
    if "document" in text or "input file" in text:
        return "input_document"
    if "fragment" in text:
        return "template_fragment"
    if "output" in text:
        return "output_document"
    if "log" in text:
        return "logs"
    return None


def _content_library_arguments(user_message: str) -> dict[str, object]:
    return {
        "content_type": _content_type_hint(user_message),
        "search": None,
        "limit": 50,
    }


def _content_search_arguments(user_message: str) -> dict[str, object]:
    return {
        "content_type": _content_type_hint(user_message),
        "search": _content_search_query(user_message),
        "tag": _content_tag_query(user_message),
        "folder_path": _content_folder_query(user_message),
        "limit": 75,
    }


def _content_library_search_requested(user_message: str) -> bool:
    text = str(user_message).lower()
    return any(
        token in text
        for token in (
            "search content",
            "find content",
            "content search",
            "topic file",
            "topic files",
            "find input documents",
            "input documents about",
            "instruction variant",
            "instruction variants",
            "find instructions",
            "find generation instructions",
            "generation instructions about",
            "instructions about",
            "search instructions",
            "search generation instructions",
            "template fragment",
            "template fragments",
            "content tagged",
            "tagged content",
            "content folder",
            "folder content",
            "content in folder",
            "content from folder",
            "show content in folder",
            "show content from folder",
        )
    )


def _content_search_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    if not text:
        return None
    for quote in ('"', "'"):
        if quote in text:
            parts = text.split(quote)
            for index in range(1, len(parts), 2):
                candidate = parts[index].strip()
                if candidate:
                    return candidate[:120]
    lower = text.lower()
    markers = (
        "search content for ",
        "find content for ",
        "find content named ",
        "find input documents about ",
        "find input documents for ",
        "input documents about ",
        "input documents for ",
        "find input document about ",
        "find input document for ",
        "input document about ",
        "input document for ",
        "find topic files for ",
        "topic files about ",
        "topic files for ",
        "instruction variants for ",
        "find generation instructions about ",
        "find generation instructions for ",
        "generation instructions about ",
        "generation instructions for ",
        "search generation instructions for ",
        "search generation instructions about ",
        "find instructions about ",
        "find instructions for ",
        "instructions about ",
        "instructions for ",
        "template fragments for ",
    )
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = text[start + len(marker):].strip(" .?!:")
        if candidate:
            return candidate[:120]
    return None


def _content_tag_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    lower = text.lower()
    markers = ("content tagged ", "tagged content ", "tagged ", "tag ")
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = text[start + len(marker):].strip(" .?!:")
        if candidate:
            return candidate.split()[0][:80].strip(",.;:")
    return None


def _content_folder_query(user_message: str) -> str | None:
    text = str(user_message).strip()
    lower = text.lower()
    markers = ("content folder ", "folder content ", "in folder ", "from folder ")
    for marker in markers:
        start = lower.find(marker)
        if start == -1:
            continue
        candidate = text[start + len(marker):].strip(" .?!:")
        if candidate:
            return candidate[:120]
    return None


def _compact_text(value: str, *, limit: int = 220) -> str:
    text = " ".join(str(value).strip().split())
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _route_label(page_context: object) -> str:
    if not isinstance(page_context, dict):
        return ""
    route = page_context.get("route")
    page = page_context.get("page")
    if isinstance(route, str) and route:
        return route
    if isinstance(page, str) and page:
        return page
    return ""
