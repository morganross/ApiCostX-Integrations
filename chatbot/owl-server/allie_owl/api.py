from __future__ import annotations

import json
import asyncio
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, Request, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .apicostx import APICostXClient
from .config import Settings
from .errors import OwlError
from .model import AllieOwlAgent, OwlModelClient
from .limits import RequestLimits
from .security import Identity, parse_bearer
from .store import OwlStore
from .tools import OwlToolRegistry


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow")
    role: Literal["system", "developer", "user", "assistant", "tool"]
    content: str | None = None
    name: str | None = None
    tool_call_id: str | None = None

    @field_validator("content")
    @classmethod
    def text_only(cls, value: str | None) -> str | None:
        if value is not None and len(value) > 1_000_000:
            raise ValueError("message content is too large")
        return value


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str = Field(min_length=1, max_length=100)
    messages: list[ChatMessage] = Field(min_length=1, max_length=1000)
    stream: bool = False
    conversation_id: str | None = Field(default=None, max_length=80)
    store: bool = False
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] = "auto"
    response_format: dict[str, Any] | None = None
    metadata: dict[str, str] | None = None
    user: str | None = Field(default=None, max_length=256)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=200_000)
    top_p: float | None = Field(default=None, ge=0, le=1)
    approved_actions: list[dict[str, Any]] = Field(default_factory=list, max_length=20)


class CreateConversationRequest(BaseModel):
    title: str = Field(default="Allie Owl conversation", max_length=200)


class Usage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class AssistantMessage(BaseModel):
    role: Literal["assistant"] = "assistant"
    content: str
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)


class ChatChoice(BaseModel):
    index: int = 0
    message: AssistantMessage
    finish_reason: str = "stop"


class ChatCompletion(BaseModel):
    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: list[ChatChoice]
    usage: Usage
    acx_conversation_id: str | None = None
    acx_tool_calls: int = 0
    acx_pending_actions: list[dict[str, Any]] = Field(default_factory=list)


class DirectToolRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    arguments: dict[str, Any] = Field(default_factory=dict)


@dataclass
class AppState:
    settings: Settings
    store: OwlStore
    backend: APICostXClient
    agent: AllieOwlAgent
    limits: RequestLimits = field(default_factory=RequestLimits)
    active_conversations: set[tuple[str, str]] = field(default_factory=set)

    @contextmanager
    def conversation_guard(self, owner, conversation_id):
        key = (owner, conversation_id)
        if conversation_id and key in self.active_conversations:
            raise OwlError("Conversation already has an active turn", 409, "conversation_busy")
        if conversation_id:
            self.active_conversations.add(key)
        try:
            yield
        finally:
            self.active_conversations.discard(key)


def _build_state(settings: Settings, backend_transport=None, model_transport=None) -> AppState:
    backend = APICostXClient(settings.backend_api_url, transport=backend_transport, timeout=settings.request_timeout_seconds)
    store = OwlStore(settings.data_path, settings.kek_bytes())
    return AppState(
        settings=settings,
        store=store,
        backend=backend,
        agent=AllieOwlAgent(
            OwlModelClient(settings.openai_base_url, settings.model, api_key=settings.model_api_key, timeout=settings.request_timeout_seconds, transport=model_transport),
            OwlToolRegistry(backend, store),
            max_steps=settings.max_steps,
            max_response_chars=settings.max_response_chars,
        ),
    )


def create_app(settings: Settings | None = None, *, backend_transport=None, model_transport=None) -> FastAPI:
    app = FastAPI(title="Allie Owl API", version="0.1.0", docs_url="/docs", redoc_url=None)
    app.state.owl = _build_state(settings, backend_transport, model_transport) if settings is not None else None

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        size = 0
        chunks = []
        async for chunk in request.stream():
            size += len(chunk)
            if size > 2_000_000:
                return _error_response(OwlError('Request body exceeds 2 MB', 413, 'request_too_large'))
            chunks.append(chunk)
        request._body = b''.join(chunks)
        response = await call_next(request)
        response.headers.setdefault("x-request-id", str(uuid.uuid4()))
        return response

    @app.on_event("startup")
    async def initialize() -> None:
        if app.state.owl is None:
            app.state.owl = _build_state(Settings.from_env())

    @app.on_event("shutdown")
    async def close() -> None:
        if app.state.owl is not None:
            await app.state.owl.backend.close()
            await app.state.owl.agent.model.close()
            app.state.owl.store.close()

    @app.exception_handler(OwlError)
    async def owl_error(_request: Request, exc: OwlError):
        return _error_response(exc)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        return _error_response(OwlError("Invalid request", 422, "invalid_request_error", str(exc.errors()[0].get("loc", "request"))))

    @app.get("/health")
    async def health(request: Request):
        state: AppState = request.app.state.owl
        return {"status": "healthy", "service": "allie-owl", "product": "standalone", "model": state.settings.model}

    @app.get("/v1/models")
    async def models(identity: Identity = Depends(_identity_dependency)):
        del identity
        state = app.state.owl
        return {"object": "list", "data": [{"id": "allie-owl", "object": "model", "owned_by": "apicostx", "permission": []}]}

    @app.get("/v1/tools")
    async def tools(identity: Identity = Depends(_identity_dependency)):
        del identity
        return {"object": "list", "data": app.state.owl.agent.tools.openai_tools()}

    @app.get("/v1/usage")
    async def owl_usage(days: int = 30, identity: Identity = Depends(_identity_dependency)):
        if days < 1 or days > 366:
            raise OwlError("days must be between 1 and 366", 422, "invalid_request_error", "days")
        return {"object": "usage", "days": days, **app.state.owl.store.usage_summary(identity.owner, days)}

    @app.post("/v1/tools/call")
    async def direct_tool(data: DirectToolRequest, request: Request, identity: Identity = Depends(_identity_dependency)):
        state: AppState = request.app.state.owl
        request_id = str(uuid.uuid4())
        started = time.perf_counter()
        state.store.record_audit(identity.owner, request_id, data.name, _tool_target(data.arguments), "started", 0)
        try:
            result = await state.agent.tools.execute(data.name, data.arguments, identity, request_id)
            state.store.record_usage(event_id=request_id, owner=identity.owner, kind="tool", request_id=request_id,
                                     input_chars=len(json.dumps(data.arguments)), output_chars=len(json.dumps(result)),
                                     input_tokens=None, output_tokens=None, tool_calls=1)
            state.store.record_audit(identity.owner, request_id, data.name, _tool_target(data.arguments), "success", int((time.perf_counter() - started) * 1000))
            return {"id": request_id, "name": data.name, "result": result}
        except (Exception, asyncio.CancelledError):
            state.store.record_audit(identity.owner, request_id, data.name, _tool_target(data.arguments), "failed", int((time.perf_counter() - started) * 1000))
            state.store.record_usage(event_id=request_id, owner=identity.owner, kind="failed_tool", request_id=request_id,
                                     input_chars=len(json.dumps(data.arguments)), output_chars=0,
                                     input_tokens=None, output_tokens=None, tool_calls=1)
            raise

    @app.post("/v1/chat/completions")
    async def chat_completions(data: ChatCompletionRequest, request: Request, identity: Identity = Depends(_identity_dependency)):
        state: AppState = request.app.state.owl
        if data.response_format is not None or data.top_p is not None or data.model_extra:
            raise OwlError("Unsupported chat parameter", 422, "unsupported_parameter")
        if any(message.role == "tool" or message.model_extra for message in data.messages):
            raise OwlError("Caller tool transcripts are not supported", 422, "unsupported_parameter", "messages")
        if data.model != "allie-owl":
            raise OwlError("Model is not available", 404, "model_not_found", "model")
        if data.tools:
            raise OwlError("Caller-owned tools are not supported yet; use Allie Owl tools", 422, "unsupported_parameter", "tools")
        if not isinstance(data.tool_choice, str) or data.tool_choice not in {"auto", "none"}:
            raise OwlError("tool_choice must be auto or none", 422, "invalid_request_error", "tool_choice")
        if len(data.messages) > state.settings.max_messages:
            raise OwlError("Too many messages", 413, "request_too_large", "messages")
        input_messages = [{"role": message.role, "content": message.content or ""} for message in data.messages]
        input_chars = sum(len(message["content"]) for message in input_messages)
        if input_chars > state.settings.max_message_chars:
            raise OwlError("Message content is too large", 413, "request_too_large", "messages")

        request_id = str(uuid.uuid4())
        conversation_id = data.conversation_id
        if conversation_id:
            if not state.store.get_conversation(identity.owner, conversation_id):
                raise OwlError("Conversation not found", 404, "conversation_not_found")
        elif data.store:
            title = next((m["content"] for m in input_messages if m["role"] == "user"), "Allie Owl conversation")
            conversation = state.store.create_conversation(identity.owner, title)
            conversation_id = conversation["id"]
            _record_conversation_usage(state, identity, conversation_id)

        async def complete(on_delta=None):
            try:
                started = time.perf_counter()
                with state.conversation_guard(identity.owner, conversation_id):
                    context_messages = (state.store.get_messages(identity.owner, conversation_id, limit=state.settings.max_messages + 1) if conversation_id else []) + input_messages
                    if len(context_messages) > state.settings.max_messages or sum(len(m['content']) for m in context_messages) > state.settings.max_message_chars:
                        raise OwlError("Saved conversation exceeds the context budget; start a new conversation", 413, "context_limit")
                    result = await state.agent.run(
                        context_messages,
                        identity,
                        request_id,
                        temperature=data.temperature,
                        max_tokens=data.max_tokens,
                        allow_tools=data.tool_choice != "none",
                        audit=lambda action, target, outcome: state.store.record_audit(identity.owner, request_id, action, target, outcome, int((time.perf_counter() - started) * 1000)),
                        max_context_chars=state.settings.max_message_chars + 40_000,
                        on_delta=on_delta,
                        approved_actions=data.approved_actions,
                    )
                    if conversation_id:
                        state.store.append_messages(identity.owner, conversation_id, input_messages + [{"role": "assistant", "content": result.content}])
                state.store.record_usage(
                    event_id=request_id, owner=identity.owner, kind="turn", request_id=request_id,
                    input_chars=input_chars, output_chars=len(result.content), input_tokens=result.prompt_tokens,
                    output_tokens=result.completion_tokens, tool_calls=result.tool_calls,
                )
            except (Exception, asyncio.CancelledError):
                state.store.record_usage(event_id=request_id, owner=identity.owner, kind="failed_turn", request_id=request_id,
                                         input_chars=input_chars, output_chars=0, input_tokens=None, output_tokens=None, tool_calls=0)
                raise
            response = ChatCompletion(
                id=f"chatcmpl-{request_id}", created=int(time.time()), model=data.model,
                choices=[ChatChoice(message=AssistantMessage(content=result.content))],
                usage=Usage(prompt_tokens=result.prompt_tokens or 0, completion_tokens=result.completion_tokens or 0,
                            total_tokens=(result.prompt_tokens or 0) + (result.completion_tokens or 0)),
                acx_conversation_id=conversation_id, acx_tool_calls=result.tool_calls,
                acx_pending_actions=result.pending_actions,
            )
            headers = {"x-request-id": request_id}
            if conversation_id: headers["x-acx-conversation-id"] = conversation_id
            return response

        headers = {"x-request-id": request_id}
        if conversation_id:
            headers["x-acx-conversation-id"] = conversation_id
        if data.stream:
            async def events():
                queue = asyncio.Queue(maxsize=32)
                async def send(text):
                    await queue.put(text)
                async def work():
                    try:
                        return await complete(send)
                    finally:
                        await queue.put(None)
                state.limits.acquire(identity.owner)
                task = asyncio.create_task(work())
                try:
                    while True:
                        try:
                            text = await asyncio.wait_for(queue.get(), 15)
                        except asyncio.TimeoutError:
                            yield ": keepalive\n\n"
                            continue
                        if text is None:
                            break
                        chunk = {"id": f"chatcmpl-{request_id}", "object": "chat.completion.chunk", "created": int(time.time()), "model": data.model,
                                 "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}
                        yield "data: " + json.dumps(chunk) + "\n\n"
                    response = await task
                    chunk = {"id": response.id, "object": "chat.completion.chunk", "created": response.created, "model": response.model,
                             "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": response.usage.model_dump(), "acx_pending_actions": response.acx_pending_actions, "acx_conversation_id": conversation_id}
                    yield "data: " + json.dumps(chunk) + "\n\n"
                    yield "data: [DONE]\n\n"
                except OwlError as exc:
                    yield "data: " + json.dumps({"error": {"message": exc.message, "code": exc.code}}) + "\n\n"
                finally:
                    if not task.done():
                        task.cancel()
                    while not queue.empty():
                        queue.get_nowait()
                    await asyncio.gather(task, return_exceptions=True)
                    state.limits.release(identity.owner)
            return StreamingResponse(events(), media_type="text/event-stream", headers=headers)
        response = await complete()
        return JSONResponse(response.model_dump(exclude_none=True), headers=headers)

    @app.post("/v1/conversations", status_code=201)
    async def create_conversation(data: CreateConversationRequest, request: Request, identity: Identity = Depends(_identity_dependency)):
        state: AppState = app.state.owl
        conversation = state.store.create_conversation(identity.owner, data.title)
        _record_conversation_usage(state, identity, conversation["id"])
        return conversation

    @app.get("/v1/conversations")
    async def list_conversations(limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0), identity: Identity = Depends(_identity_dependency)):
        return {"object": "list", "data": app.state.owl.store.list_conversations(identity.owner, limit, offset), "limit": limit, "offset": offset}

    @app.get("/v1/conversations/{conversation_id}")
    async def get_conversation(conversation_id: str, identity: Identity = Depends(_identity_dependency)):
        conversation = app.state.owl.store.get_conversation(identity.owner, conversation_id)
        if conversation is None: raise OwlError("Conversation not found", 404, "conversation_not_found")
        return conversation

    @app.get("/v1/conversations/{conversation_id}/messages")
    async def get_conversation_messages(conversation_id: str, limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0), identity: Identity = Depends(_identity_dependency)):
        if app.state.owl.store.get_conversation(identity.owner, conversation_id) is None:
            raise OwlError("Conversation not found", 404, "conversation_not_found")
        return {"object": "list", "data": app.state.owl.store.get_messages(identity.owner, conversation_id, limit, offset), "limit": limit, "offset": offset}

    @app.delete("/v1/conversations/{conversation_id}")
    async def delete_conversation(conversation_id: str, identity: Identity = Depends(_identity_dependency)):
        with app.state.owl.conversation_guard(identity.owner, conversation_id):
            if not app.state.owl.store.delete_conversation(identity.owner, conversation_id):
                raise OwlError("Conversation not found", 404, "conversation_not_found")
        return {"id": conversation_id, "deleted": True}

    return app


async def _identity_dependency(request: Request, authorization: str | None = Header(None)) -> Identity:
    identity = parse_bearer(authorization)
    state: AppState = request.app.state.owl
    identity = await state.backend.verify(identity, str(uuid.uuid4()))
    state.store.adopt_key_owner(identity.key_id, identity.owner)
    state.limits.admit(identity.owner)
    try:
        yield identity
    finally:
        state.limits.release(identity.owner)


def _error_response(exc: OwlError) -> JSONResponse:
    request_id = str(uuid.uuid4())
    return JSONResponse(status_code=exc.status_code, headers={"x-request-id": request_id}, content={"error": {"message": exc.message, "type": exc.code, "param": exc.param, "code": exc.code}})


async def _stream_response(response: ChatCompletion):
    content = response.choices[0].message.content
    chunk_id = response.id
    for index in range(0, len(content), 256):
        chunk = {"id": chunk_id, "object": "chat.completion.chunk", "created": response.created, "model": response.model, "choices": [{"index": 0, "delta": {"role": "assistant" if index == 0 else None, "content": content[index:index+256]}, "finish_reason": None}]}
        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
    final = {"id": chunk_id, "object": "chat.completion.chunk", "created": response.created, "model": response.model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": response.usage.model_dump()}
    yield f"data: {json.dumps(final)}\n\n"
    yield "data: [DONE]\n\n"


app = create_app()


def _tool_target(arguments: dict[str, Any]) -> str | None:
    return next((str(arguments[key]) for key in ("content_id", "preset_id", "run_id") if arguments.get(key)), None)


def _record_conversation_usage(state: AppState, identity: Identity, conversation_id: str) -> None:
    state.store.record_usage(
        event_id=f"conversation:{conversation_id}", owner=identity.owner, kind="conversation",
        request_id=conversation_id, input_chars=0, output_chars=0,
        input_tokens=None, output_tokens=None, tool_calls=0,
    )
