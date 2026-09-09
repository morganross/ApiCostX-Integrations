"""
Persistence and orchestration for the advanced assistant scaffold.
"""
from datetime import datetime
import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.assistant_advanced import (
    AdvancedAssistantThreadCreate,
    AdvancedAssistantThreadUpdate,
)
from app.infra.db.base import Base
from app.infra.db.models.advanced_assistant import (
    AdvancedAssistantMessage,
    AdvancedAssistantThread,
)
from .gateway import AdvancedAssistantGateway

GRAPH_CONTEXT_MESSAGE_LIMIT = 40
THREAD_RETURN_MESSAGE_LIMIT = 100


class AdvancedAssistantService:
    """Owns isolated advanced assistant thread and message persistence."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        user_uuid: str,
        gateway: AdvancedAssistantGateway,
    ) -> None:
        self.db = db
        self.user_uuid = user_uuid
        self.gateway = gateway

    async def ensure_schema(self) -> None:
        connection = await self.db.connection()
        await connection.run_sync(
            lambda sync_conn: Base.metadata.create_all(
                bind=sync_conn,
                tables=[
                    AdvancedAssistantThread.__table__,
                    AdvancedAssistantMessage.__table__,
                ],
                checkfirst=True,
            )
        )

    async def list_threads(self, *, include_archived: bool = False) -> list[AdvancedAssistantThread]:
        statement = select(AdvancedAssistantThread).where(
            AdvancedAssistantThread.user_uuid == self.user_uuid
        )
        if not include_archived:
            statement = statement.where(AdvancedAssistantThread.archived.is_(False))
        statement = statement.order_by(
            AdvancedAssistantThread.updated_at.desc(),
            AdvancedAssistantThread.created_at.desc(),
        )
        result = await self.db.execute(statement)
        return list(result.scalars().all())

    async def create_thread(self, data: AdvancedAssistantThreadCreate) -> AdvancedAssistantThread:
        thread = AdvancedAssistantThread(
            user_uuid=self.user_uuid,
            title=data.title.strip(),
            archived=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        self.db.add(thread)
        await self.db.flush()
        await self.db.refresh(thread)
        return thread

    async def get_thread(self, thread_id: str) -> AdvancedAssistantThread:
        result = await self.db.execute(
            select(AdvancedAssistantThread).where(
                AdvancedAssistantThread.id == thread_id,
                AdvancedAssistantThread.user_uuid == self.user_uuid,
            )
        )
        thread = result.scalar_one_or_none()
        if not thread:
            raise HTTPException(status_code=404, detail="Advanced assistant thread not found")
        return thread

    async def get_thread_messages(
        self,
        thread_id: str,
        *,
        limit: int = 100,
    ) -> list[AdvancedAssistantMessage]:
        await self.get_thread(thread_id)
        result = await self.db.execute(
            select(AdvancedAssistantMessage)
            .where(AdvancedAssistantMessage.thread_id == thread_id)
            .order_by(AdvancedAssistantMessage.created_at.desc(), AdvancedAssistantMessage.id.desc())
            .limit(limit)
        )
        messages = list(result.scalars().all())
        return list(reversed(messages))

    async def update_thread(
        self,
        thread_id: str,
        data: AdvancedAssistantThreadUpdate,
    ) -> AdvancedAssistantThread:
        thread = await self.get_thread(thread_id)
        updated = False
        if data.title is not None:
            thread.title = data.title.strip()
            updated = True
        if data.archived is not None:
            thread.archived = data.archived
            updated = True
        if updated:
            thread.updated_at = datetime.utcnow()
            await self.db.flush()
            await self.db.refresh(thread)
        return thread

    async def add_message_and_reply(
        self,
        thread_id: str,
        *,
        content: str,
        page_context: dict[str, Any] | None = None,
    ) -> tuple[
        AdvancedAssistantThread,
        AdvancedAssistantMessage,
        AdvancedAssistantMessage | None,
        list[AdvancedAssistantMessage],
        dict[str, Any] | None,
    ]:
        thread = await self.get_thread(thread_id)
        trimmed_content = content.strip()
        if not trimmed_content:
            raise HTTPException(status_code=422, detail="Advanced assistant message cannot be empty")

        user_message = AdvancedAssistantMessage(
            thread_id=thread.id,
            role="user",
            content=trimmed_content,
            created_at=datetime.utcnow(),
        )
        self.db.add(user_message)
        await self.db.flush()

        recent_messages = await self.get_thread_messages(thread.id, limit=GRAPH_CONTEXT_MESSAGE_LIMIT)
        graph_messages = [self._message_to_graph_context(message) for message in recent_messages]
        graph_result = await self.gateway.generate_reply(
            thread=thread,
            user_message=user_message.content,
            recent_messages=graph_messages,
            page_context=page_context,
        )
        assistant_message: AdvancedAssistantMessage | None = None
        if graph_result.tool_request is None:
            assistant_message = AdvancedAssistantMessage(
                thread_id=thread.id,
                role="assistant",
                content=graph_result.response_text,
                created_at=datetime.utcnow(),
            )
            self.db.add(assistant_message)
        thread.updated_at = datetime.utcnow()

        await self.db.flush()
        await self.db.refresh(thread)
        await self.db.refresh(user_message)
        if assistant_message is not None:
            await self.db.refresh(assistant_message)

        messages = await self.get_thread_messages(thread.id, limit=THREAD_RETURN_MESSAGE_LIMIT)
        return thread, user_message, assistant_message, messages, graph_result.tool_request

    async def add_tool_result_and_reply(
        self,
        thread_id: str,
        *,
        request_id: str,
        tool_name: str,
        result: dict[str, Any],
        page_context: dict[str, Any] | None = None,
    ) -> tuple[
        AdvancedAssistantThread,
        AdvancedAssistantMessage,
        AdvancedAssistantMessage,
        list[AdvancedAssistantMessage],
        dict[str, Any] | None,
    ]:
        thread = await self.get_thread(thread_id)
        tool_payload = {
            "type": "tool_result",
            "request_id": request_id,
            "tool_name": tool_name,
            "result": result,
        }
        tool_message = AdvancedAssistantMessage(
            thread_id=thread.id,
            role="tool",
            content=json.dumps(tool_payload, sort_keys=True, default=str),
            created_at=datetime.utcnow(),
        )
        self.db.add(tool_message)
        await self.db.flush()

        recent_messages = await self.get_thread_messages(thread.id, limit=GRAPH_CONTEXT_MESSAGE_LIMIT)
        graph_messages = [self._message_to_graph_context(message) for message in recent_messages]
        graph_result = await self.gateway.generate_reply(
            thread=thread,
            user_message="",
            recent_messages=graph_messages,
            page_context=page_context,
        )
        assistant_message = AdvancedAssistantMessage(
            thread_id=thread.id,
            role="assistant",
            content=graph_result.response_text,
            created_at=datetime.utcnow(),
        )
        self.db.add(assistant_message)
        thread.updated_at = datetime.utcnow()

        await self.db.flush()
        await self.db.refresh(thread)
        await self.db.refresh(tool_message)
        await self.db.refresh(assistant_message)

        messages = await self.get_thread_messages(thread.id, limit=THREAD_RETURN_MESSAGE_LIMIT)
        return thread, tool_message, assistant_message, messages, graph_result.tool_request

    async def add_message_and_stub_reply(
        self,
        thread_id: str,
        *,
        content: str,
    ) -> tuple[
        AdvancedAssistantThread,
        AdvancedAssistantMessage,
        AdvancedAssistantMessage,
        list[AdvancedAssistantMessage],
        dict[str, Any] | None,
    ]:
        return await self.add_message_and_reply(thread_id, content=content)

    @staticmethod
    def _message_to_graph_context(message: AdvancedAssistantMessage) -> dict[str, Any]:
        return {
            "role": message.role,
            "content": message.content,
            "created_at": message.created_at.isoformat() if message.created_at else None,
        }
