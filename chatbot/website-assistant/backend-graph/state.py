"""
State contract for the advanced assistant LangGraph shell.
"""
from typing import Any, TypedDict


class AdvancedGraphState(TypedDict, total=False):
    user_uuid: str
    mode: str
    agent_id: str
    thread_id: str | None
    trace_id: str | None
    messages: list[dict[str, Any]]
    page_context: dict[str, Any] | None
    current_user_message: str
    next_action: str
    requested_tool_name: str
    requested_tool_args: dict[str, Any]
    latest_tool_result: dict[str, Any]
    tool_results: list[dict[str, Any]]
    response_text: str
    tool_request: dict[str, Any] | None
