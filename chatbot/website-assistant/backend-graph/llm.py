"""
Model-backed response helper for the advanced assistant graph.

This module is intentionally narrow: it gives LangGraph a normal chat brain
without widening the website-tool boundary. It receives bounded chat/page/tool
context and returns prose; it does not receive browser tokens, database keys,
or raw backend API authority.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from openai import OpenAI

from app.config import get_settings
from .shared_actions import SHARED_TOOLS, shared_arguments


class AdvancedAssistantLlmUnavailable(RuntimeError):
    """Raised when the advanced assistant model lane is not configured."""


def answer_with_advanced_assistant_model(*, state: dict[str, Any]) -> str:
    """Answer a normal chat turn with the configured assistant model."""
    user_message = str(state.get("current_user_message") or "").strip()
    messages = _recent_conversation(state.get("messages") or [])
    page_context = _bounded_json(state.get("page_context"), limit=1800)
    return _complete(
        [
            {"role": "system", "content": _system_prompt()},
            {
                "role": "user",
                "content": "\n\n".join(
                    part
                    for part in (
                        "Answer the user's latest message naturally.",
                        "Use ACM/project knowledge when it helps, but do not force ACM into unrelated questions.",
                        "If the user asks for a website action, explain that a named website tool is needed only if the graph did not already request one.",
                        f"Recent conversation:\n{messages}" if messages else "",
                        f"Current website/page context:\n{page_context}" if page_context else "",
                        f"Latest user message:\n{user_message}",
                    )
                    if part
                ),
            },
        ]
    )


def synthesize_tool_result_with_advanced_assistant_model(
    *,
    state: dict[str, Any],
    tool_summary: str,
) -> str:
    """Turn deterministic tool facts into a plain-English assistant reply."""
    user_message = str(state.get("current_user_message") or "").strip()
    if not user_message:
        user_message = _latest_user_message(state.get("messages") or [])
    page_context = _bounded_json(state.get("page_context"), limit=1200)
    return _complete(
        [
            {"role": "system", "content": _system_prompt()},
            {
                "role": "user",
                "content": "\n\n".join(
                    part
                    for part in (
                        "The website tool already ran. Write the assistant's final response in plain English.",
                        "Use the tool facts as evidence. Do not invent IDs, statuses, outputs, or failures not present in the facts.",
                        "Be concise, but include the important result and any useful next step.",
                        f"User request:\n{user_message}" if user_message else "",
                        f"Current website/page context:\n{page_context}" if page_context else "",
                        f"Tool facts:\n{tool_summary}",
                    )
                    if part
                ),
            },
        ]
    )


def choose_website_tool_with_advanced_assistant_model(*, state: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    """Let the model choose whether this turn needs one named website capability.

    This is intentionally a bounded supervisor decision, not arbitrary tool use.
    The model may choose only from the listed website capabilities. For
    read-only tools, it may also return a small bounded argument object. The
    graph still sanitizes that object and still owns write/workflow arguments,
    so the model does not become a raw API caller or receive hidden authority.
    """
    user_message = str(state.get("current_user_message") or "").strip()
    if not user_message:
        return None, {}
    messages = _recent_conversation(state.get("messages") or [], limit=8)
    page_context = _bounded_json(state.get("page_context"), limit=1200)
    manifest = _website_capability_manifest()
    response = _complete(
        [
            {"role": "system", "content": _system_prompt()},
            {
                "role": "user",
                "content": "\n\n".join(
                    part
                    for part in (
                        "You are the advanced assistant supervisor for one chat turn.",
                        "Decide whether the latest user message needs exactly one named ACM website capability before answering.",
                        "If no website capability is needed, return only JSON: {\"tool_name\": null, \"arguments\": {}}.",
                        "If a capability is needed, return only JSON: {\"tool_name\": \"one_allowed_tool_name\", \"arguments\": {}}.",
                        "For read-only tools, include only the allowed arguments listed below when the user supplied them or they are clearly implied.",
                        "Do not include markdown, prose, comments, or extra top-level keys.",
                        "Never choose a website tool when the user explicitly says not to inspect the website, not to use tools, or asks for a purely conceptual/general answer.",
                        "When the user asks to find, search, list, load, inspect, summarize, or compare private ACM website data such as content-library items, presets, runs, logs, outputs, models, documents, or instructions, choose the narrow website capability needed to fetch current facts.",
                        "Do not answer private ACM website-data questions from recent conversation memory. Recent assistant text may be stale, incomplete, or from a different filter. Request the website capability instead.",
                        "For run/execute/start/launch requests about the current preset, choose get_current_preset_runnability first. Do not choose execute_current_preset directly as the first supervisor decision.",
                        "Use only these allowed capabilities:\n" + manifest,
                        "Allowed read-tool arguments:\n" + _website_capability_argument_manifest(),
                        f"Recent conversation:\n{messages}" if messages else "",
                        f"Current website/page context:\n{page_context}" if page_context else "",
                        f"Latest user message:\n{user_message}",
                    )
                    if part
                ),
            },
        ]
    )
    return _parse_supervisor_tool_choice(response)


def _complete(messages: list[dict[str, str]]) -> str:
    settings = get_settings()
    if not settings.assistant_advanced_llm_enabled:
        raise AdvancedAssistantLlmUnavailable("advanced assistant LLM is disabled")
    provider = str(settings.assistant_advanced_llm_provider or "").strip().lower()
    if provider != "openai":
        raise AdvancedAssistantLlmUnavailable(f"unsupported advanced assistant LLM provider: {provider}")
    api_key = _configured_openai_api_key(settings)
    if not api_key:
        raise AdvancedAssistantLlmUnavailable(
            "OpenAI API key is not configured in assistant override, app settings, or ACM provider-key file"
        )

    client = OpenAI(api_key=api_key, timeout=float(settings.assistant_advanced_llm_timeout_seconds))
    model = _openai_model_name(str(settings.assistant_advanced_llm_model or "gpt-5.4"))
    max_tokens = int(settings.assistant_advanced_llm_max_output_tokens or 900)

    try:
        response = client.responses.create(
            model=model,
            input=messages,
            max_output_tokens=max_tokens,
        )
        text = str(getattr(response, "output_text", "") or "").strip()
        if text:
            return text
    except Exception:
        # Some older/proxy deployments support chat completions before the
        # Responses API. Try the older endpoint before reporting failure.
        pass

    completion_kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
    }
    if _chat_completion_uses_max_completion_tokens(model):
        completion_kwargs["max_completion_tokens"] = max_tokens
    else:
        completion_kwargs["max_tokens"] = max_tokens
    response = client.chat.completions.create(**completion_kwargs)
    choice = response.choices[0] if response.choices else None
    message = choice.message if choice else None
    text = str(getattr(message, "content", "") or "").strip()
    if not text:
        raise AdvancedAssistantLlmUnavailable("advanced assistant model returned an empty response")
    return text


def _website_capability_manifest() -> str:
    rows = [
        ("get_current_route_context", "route/page/current preset id/current run id orientation"),
        ("get_visible_page_state", "what the visible website page can currently expose"),
        ("get_available_assistant_actions", "what assistant website actions/tools are available now"),
        ("get_assistant_knowledge_manifest", "assistant knowledge-pack files, version, and declared tools"),
        ("refresh_current_page_data", "refresh assistant-local data for the current page"),
        ("get_current_preset_summary", "summarize the current visible or saved preset configuration"),
        ("get_current_preset_runnability", "check whether the current preset can run and list blockers"),
        ("get_current_preset_requirements", "list missing setup requirements for the current preset"),
        ("get_current_preset_models", "inspect selected models/providers/engine model slots"),
        ("get_current_preset_documents", "inspect selected input documents/source materials"),
        ("get_current_preset_instructions", "inspect attached generation/eval/combine instructions"),
        ("get_current_preset_content_assets", "audit attached content-library assets for the current preset"),
        ("get_recent_runs_for_assistant", "list recent app-wide runs"),
        ("get_latest_run_context", "summarize the latest/last run with status, failure, and output context"),
        ("load_run_for_assistant", "load a specific run by id or the latest run"),
        ("get_run_status_summary", "inspect one run's status/progress/output availability"),
        ("get_run_failure_signals", "inspect why a run failed or what error signals are visible"),
        ("get_run_output_summary", "summarize generated outputs/artifacts for a run"),
        ("load_run_logs_for_assistant", "load bounded user-visible logs for a run"),
        ("load_run_outputs_for_assistant", "load bounded generated output document bodies"),
        ("get_content_library_summary", "summarize available content-library records"),
        ("search_content_library_for_assistant", "search content library by text, type, tag, or folder"),
        ("load_content_for_assistant", "load one content-library item by id or name"),
    ]
    return "\n".join(f"- {name}: {description}" for name, description in rows) + '\n' + json.dumps(list(SHARED_TOOLS.values()))


def _website_capability_argument_manifest() -> str:
    return "\n".join(
        [
            "- get_content_library_summary: content_type, search, limit",
            "- search_content_library_for_assistant: content_type, search, tag, folder_path, limit",
            "- load_content_for_assistant: content_id, name_query, content_type, include_body_excerpt, max_chars, deep_read",
            "- load_run_for_assistant: run_id",
            "- get_run_status_summary: run_id",
            "- get_run_failure_signals: run_id, classification",
            "- get_run_output_summary: run_id, include_document_titles",
            "- load_run_logs_for_assistant: run_id, classification, limit",
            "- load_run_outputs_for_assistant: run_id, max_documents",
            "- get_recent_runs_for_assistant: limit",
            "- get_latest_run_context: include_failure_signals, include_output_summary",
            "- current-preset tools: preset_id, use_visible_draft_if_available, include_document_names, include_titles, include_previews",
            "- orientation/action/knowledge/refresh tools: no arguments",
        ]
    )


def _parse_supervisor_tool_choice(response: str) -> tuple[str | None, dict[str, Any]]:
    allowed = {
        "get_current_route_context",
        "get_visible_page_state",
        "get_available_assistant_actions",
        "get_assistant_knowledge_manifest",
        "refresh_current_page_data",
        "get_current_preset_summary",
        "get_current_preset_runnability",
        "get_current_preset_requirements",
        "get_current_preset_models",
        "get_current_preset_documents",
        "get_current_preset_instructions",
        "get_current_preset_content_assets",
        "get_recent_runs_for_assistant",
        "get_latest_run_context",
        "load_run_for_assistant",
        "get_run_status_summary",
        "get_run_failure_signals",
        "get_run_output_summary",
        "load_run_logs_for_assistant",
        "load_run_outputs_for_assistant",
        "get_content_library_summary",
        "search_content_library_for_assistant",
        "load_content_for_assistant",
    }
    text = str(response or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None, {}
    if not isinstance(payload, dict):
        return None, {}
    tool_name = payload.get("tool_name")
    if tool_name is None:
        return None, {}
    tool = str(tool_name).strip()
    if tool in SHARED_TOOLS:
        return tool, shared_arguments(tool, payload.get('arguments') or {})
    if tool not in allowed:
        return None, {}
    arguments = payload.get("arguments")
    return tool, _sanitize_supervisor_arguments(tool, arguments if isinstance(arguments, dict) else {})


def _sanitize_supervisor_arguments(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    allowed_keys_by_tool = {
        "get_content_library_summary": {"content_type", "search", "limit"},
        "search_content_library_for_assistant": {"content_type", "search", "tag", "folder_path", "limit"},
        "load_content_for_assistant": {
            "content_id",
            "name_query",
            "content_type",
            "include_body_excerpt",
            "max_chars",
            "deep_read",
        },
        "load_run_for_assistant": {"run_id"},
        "get_run_status_summary": {"run_id"},
        "get_run_failure_signals": {"run_id", "classification"},
        "get_run_output_summary": {"run_id", "include_document_titles"},
        "load_run_logs_for_assistant": {"run_id", "classification", "limit"},
        "load_run_outputs_for_assistant": {"run_id", "max_documents"},
        "get_recent_runs_for_assistant": {"limit"},
        "get_latest_run_context": {"include_failure_signals", "include_output_summary"},
        "get_current_preset_summary": {"preset_id", "use_visible_draft_if_available"},
        "get_current_preset_runnability": {"preset_id", "use_visible_draft_if_available"},
        "get_current_preset_requirements": {"preset_id", "use_visible_draft_if_available"},
        "get_current_preset_models": {"preset_id", "use_visible_draft_if_available"},
        "get_current_preset_documents": {"preset_id", "use_visible_draft_if_available", "include_document_names"},
        "get_current_preset_instructions": {"preset_id", "use_visible_draft_if_available", "include_titles"},
        "get_current_preset_content_assets": {"include_previews"},
    }
    allowed_keys = allowed_keys_by_tool.get(tool_name, set())
    sanitized: dict[str, Any] = {}
    for key, value in arguments.items():
        if key not in allowed_keys:
            continue
        cleaned = _sanitize_supervisor_argument_value(key, value)
        if cleaned is not None:
            sanitized[key] = cleaned
    return sanitized


def _sanitize_supervisor_argument_value(key: str, value: Any) -> Any:
    if key in {
        "include_body_excerpt",
        "deep_read",
        "include_document_titles",
        "include_failure_signals",
        "include_output_summary",
        "use_visible_draft_if_available",
        "include_document_names",
        "include_titles",
        "include_previews",
    }:
        return bool(value)
    if key in {"limit", "max_chars", "max_documents"}:
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        if key == "limit":
            return max(1, min(number, 300))
        if key == "max_documents":
            return max(1, min(number, 10))
        return max(200, min(number, 12000))
    if key == "classification":
        text = str(value or "").strip().lower()
        return text if text in {"event", "all", "warning", "error"} else None
    if key == "content_type":
        return _normalize_content_type_argument(value)
    text = str(value or "").strip()
    if not text:
        return None
    return text[:240]


def _normalize_content_type_argument(value: Any) -> str | None:
    text = str(value or "").strip().lower().replace("-", "_")
    text = re.sub(r"\s+", "_", text)
    aliases = {
        "generation_instruction": "generation_instructions",
        "generation_instructions": "generation_instructions",
        "instruction": "generation_instructions",
        "instructions": "generation_instructions",
        "prompt": "generation_instructions",
        "prompts": "generation_instructions",
        "input": "input_document",
        "input_document": "input_document",
        "input_documents": "input_document",
        "document": "input_document",
        "documents": "input_document",
        "topic": "input_document",
        "topic_file": "input_document",
        "topic_files": "input_document",
        "topic_document": "input_document",
        "source": "input_document",
        "source_material": "input_document",
        "single_eval": "single_eval_instructions",
        "single_eval_instruction": "single_eval_instructions",
        "single_eval_instructions": "single_eval_instructions",
        "pairwise_eval": "pairwise_eval_instructions",
        "pairwise_eval_instruction": "pairwise_eval_instructions",
        "pairwise_eval_instructions": "pairwise_eval_instructions",
        "eval_criteria": "eval_criteria",
        "evaluation_criteria": "eval_criteria",
        "combine_instruction": "combine_instructions",
        "combine_instructions": "combine_instructions",
        "template_fragment": "template_fragment",
        "template_fragments": "template_fragment",
        "output": "output_document",
        "output_document": "output_document",
        "output_documents": "output_document",
        "log": "logs",
        "logs": "logs",
    }
    return aliases.get(text)


def _system_prompt() -> str:
    return (
        "You are ACM's advanced assistant. You are a normal, capable chatbot and should answer ordinary "
        "questions normally. You also understand ACM, a web application for configuring and running structured "
        "LLM workflows such as FPF preset-based report/document generation. ACM presets connect engine choice, "
        "model selection, input documents, generation instructions, and run settings. The advanced assistant can "
        "use named website tools through the logged-in browser page when the user wants to inspect or change ACM "
        "website state. Those tools are the security boundary: do not ask for or claim access to browser session "
        "tokens, database keys, provider keys, or raw backend API authority. Do not artificially refuse "
        "general chat just because the topic is outside ACM. If live/current facts would require internet access "
        "and no search tool result is present, say what you know and name the uncertainty."
    )


def _configured_openai_api_key(settings: Any) -> str:
    """Return the existing ACM OpenAI key without requiring a duplicate key.

    Precedence:
    1. Optional advanced-assistant override.
    2. Existing app setting/env key.
    3. Existing mounted ACM provider-key file.
    """
    explicit = str(getattr(settings, "assistant_advanced_llm_api_key", None) or "").strip()
    if explicit:
        return explicit
    app_setting = str(getattr(settings, "openai_api_key", None) or "").strip()
    if app_setting:
        return app_setting
    key_file = getattr(settings, "acm_provider_keys_file", None)
    path = Path(str(key_file or "/run/acm2/provider-keys.env"))
    return _read_env_file_value(path, "OPENAI_API_KEY")


def _read_env_file_value(path: Path, name: str) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    prefix = f"{name}="
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or not line.startswith(prefix):
            continue
        value = line[len(prefix):].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        return value.strip()
    return ""


def _recent_conversation(messages: list[Any], *, limit: int = 12) -> str:
    rows: list[str] = []
    for message in messages[-limit:]:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip() or "unknown"
        if role == "tool":
            continue
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        rows.append(f"{role}: {content[:1400]}")
    return "\n".join(rows)


def _latest_user_message(messages: list[Any]) -> str:
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        if message.get("role") != "user":
            continue
        content = str(message.get("content") or "").strip()
        if content:
            return content
    return ""


def _bounded_json(value: Any, *, limit: int) -> str:
    if value is None:
        return ""
    try:
        text = json.dumps(value, sort_keys=True, default=str)
    except TypeError:
        text = str(value)
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _openai_model_name(model_key: str) -> str:
    value = model_key.strip()
    if ":" in value:
        provider, model = value.split(":", 1)
        if provider.strip().lower() == "openai":
            return model.strip()
    if value.startswith("openai/"):
        return value.split("/", 1)[1].strip()
    return value


def _chat_completion_uses_max_completion_tokens(model: str) -> bool:
    normalized = str(model or "").strip().lower()
    return normalized.startswith(("gpt-5", "o1", "o3", "o4"))
