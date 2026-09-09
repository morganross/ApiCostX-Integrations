"""
Gateway abstraction for advanced assistant execution.

The public website-owned assistant API keeps responsibility for auth and
persistence. Gateways receive only bounded, model-safe context.
"""
from __future__ import annotations

from typing import Any

from app.infra.db.models.advanced_assistant import AdvancedAssistantThread
from app.services.assistant_advanced_graph.service import (
    AdvancedAssistantGraphRunner,
    AdvancedGraphRunResult,
)


class AdvancedAssistantGateway:
    """Contract for advanced assistant response generation."""

    async def generate_reply(
        self,
        *,
        thread: AdvancedAssistantThread,
        user_message: str,
        recent_messages: list[dict[str, Any]],
        page_context: dict[str, Any] | None,
    ) -> AdvancedGraphRunResult:
        raise NotImplementedError


class LangGraphAdvancedAssistantGateway(AdvancedAssistantGateway):
    """Runs the backend-hosted LangGraph MVP without receiving user secrets."""

    def __init__(self, *, runner: AdvancedAssistantGraphRunner | None = None) -> None:
        self.runner = runner or AdvancedAssistantGraphRunner()

    async def generate_reply(
        self,
        *,
        thread: AdvancedAssistantThread,
        user_message: str,
        recent_messages: list[dict[str, Any]],
        page_context: dict[str, Any] | None,
    ) -> AdvancedGraphRunResult:
        return self.runner.run(
            user_uuid=str(thread.user_uuid or ""),
            mode="advanced",
            agent_id="advanced",
            thread_id=thread.id,
            trace_id=None,
            messages=recent_messages,
            page_context=page_context,
            current_user_message=user_message,
        )


class StubAdvancedAssistantGateway(AdvancedAssistantGateway):
    """Compatibility placeholder that now follows the same graph-shaped contract."""

    async def generate_reply(
        self,
        *,
        thread: AdvancedAssistantThread,
        user_message: str,
        recent_messages: list[dict[str, Any]],
        page_context: dict[str, Any] | None,
    ) -> AdvancedGraphRunResult:
        return AdvancedAssistantGraphRunner().run(
            user_uuid=str(thread.user_uuid or ""),
            mode="advanced",
            agent_id="advanced",
            thread_id=thread.id,
            trace_id=None,
            messages=recent_messages,
            page_context=page_context,
            current_user_message=user_message,
        )
