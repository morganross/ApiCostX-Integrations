from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from allie_owl.api import create_app
from allie_owl.config import Settings


KEY_A = "acm2.ak_test_key_12345.secret-a"
KEY_B = "acm2.ak_other_key_12345.secret-b"


def settings(tmp_path: Path) -> Settings:
    return Settings(
        backend_api_url="https://api.test",
        openai_base_url="https://model.test/v1",
        model="gpt-5.6-luna",
        data_path=tmp_path / "owl.sqlite",
        data_kek_hex="22" * 32,
        max_steps=4,
    )


def backend_transport(request: httpx.Request) -> httpx.Response:
    assert request.headers["X-ACM2-API-Key"].startswith("acm2.ak_")
    if request.url.path == "/api/identity":
        key_id = request.headers["X-ACM2-API-Key"].split('.')[1]
        owner = '11111111-1111-4111-8111-111111111111' if key_id == 'ak_test_key_12345' else '22222222-2222-4222-8222-222222222222'
        return httpx.Response(200, json={"user_uuid": owner, "key_id": key_id, "scope": "read_write"})
    if request.url.path == "/api/credits":
        return httpx.Response(200, json={"balance_usd": 10, "total_added_usd": 10, "total_spent_usd": 0})
    if request.url.path == "/api/presets":
        return httpx.Response(200, json={"items": [{"id": "preset-1", "name": "Research"}], "total": 1})
    return httpx.Response(200, json={"ok": True, "path": request.url.path})


class ModelResponder:
    def __init__(self):
        self.calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            body = {"id": "model-1", "choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "apicostx_list_presets", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}}
        else:
            body = {"id": "model-2", "choices": [{"message": {"role": "assistant", "content": "You have one saved preset called Research.", "tool_calls": []}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 40, "completion_tokens": 9, "total_tokens": 49}}
        return httpx.Response(200, json=body)


async def request(app, method, path, key=KEY_A, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://owl.test") as client:
        return await client.request(method, path, headers={"Authorization": f"Bearer {key}"}, **kwargs)


@pytest.mark.asyncio
async def test_openai_chat_runs_new_owl_tool_and_persists_encrypted_conversation(tmp_path):
    model = ModelResponder()
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    response = await request(app, "POST", "/v1/chat/completions", json={"model": "allie-owl", "messages": [{"role": "user", "content": "What presets do I have?"}], "store": True})
    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["content"].startswith("You have one")
    assert body["acx_tool_calls"] == 1
    assert body["acx_conversation_id"]
    conversations = await request(app, "GET", "/v1/conversations")
    assert conversations.status_code == 200
    assert len(conversations.json()["data"]) == 1
    messages = await request(app, "GET", f"/v1/conversations/{body['acx_conversation_id']}/messages")
    assert [item["role"] for item in messages.json()["data"]] == ["user", "assistant"]
    usage = await request(app, "GET", "/v1/usage?days=30")
    assert usage.json()["conversations"] == 1 and usage.json()["turns"] == 1
    assert model.calls == 2


@pytest.mark.asyncio
async def test_stateless_stream_is_openai_shaped_and_conversations_are_key_isolated(tmp_path):
    model = ModelResponder()
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    created = await request(app, "POST", "/v1/conversations", json={"title": "A private chat"})
    conversation_id = created.json()["id"]
    foreign = await request(app, "GET", f"/v1/conversations/{conversation_id}", key=KEY_B)
    assert foreign.status_code == 404
    streamed = await request(app, "POST", "/v1/chat/completions", json={"model": "allie-owl", "messages": [{"role": "user", "content": "hello"}], "stream": True})
    assert streamed.status_code == 200
    assert streamed.headers["content-type"].startswith("text/event-stream")
    assert "chat.completion.chunk" in streamed.text
    assert "data: [DONE]" in streamed.text


@pytest.mark.asyncio
async def test_invalid_key_and_unsupported_client_tools_are_openai_errors(tmp_path):
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(ModelResponder()))
    invalid = await request(app, "GET", "/v1/models", key="wrong")
    assert invalid.status_code == 401 and invalid.json()["error"]["type"] == "invalid_api_key"
    unsupported = await request(app, "POST", "/v1/chat/completions", json={"model": "allie-owl", "messages": [{"role": "user", "content": "x"}], "tools": [{"type": "function"}]})
    assert unsupported.status_code == 422 and unsupported.json()["error"]["code"] == "unsupported_parameter"


@pytest.mark.asyncio
async def test_write_tool_requires_explicit_confirmation(tmp_path):
    model = ModelResponder()
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    response = await request(app, "POST", "/v1/chat/completions", json={"model": "allie-owl", "messages": [{"role": "user", "content": "run preset-1"}]})
    # The mocked model selects a read tool, so the endpoint remains usable.
    assert response.status_code == 200
    registry = app.state.owl.agent.tools
    with pytest.raises(Exception) as error:
        await registry.execute("apicostx_execute_preset", {"preset_id": "preset-1", "confirm": False}, __import__("allie_owl.security", fromlist=["Identity"]).Identity("ak_test", KEY_A), "request")
    assert getattr(error.value, "code", None) == "confirmation_required"


@pytest.mark.asyncio
async def test_direct_tool_and_per_key_concurrency_limit_are_separate_from_chat(tmp_path):
    model = ModelResponder()
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    result = await request(app, "POST", "/v1/tools/call", json={"name": "apicostx_list_presets", "arguments": {}})
    assert result.status_code == 200 and result.json()["name"] == "apicostx_list_presets"
    app.state.owl.limits.requests_per_minute = 1
    limited = await request(app, "POST", "/v1/tools/call", json={"name": "apicostx_list_presets", "arguments": {}})
    assert limited.status_code == 429
