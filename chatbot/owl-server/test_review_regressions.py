import asyncio
import json
from dataclasses import replace

import httpx
import pytest

from allie_owl.api import create_app
from allie_owl.apicostx import APICostXClient
from allie_owl.errors import OwlError
from allie_owl.model import OwlModelClient
from allie_owl.security import Identity
from allie_owl.tools import OwlToolRegistry
from test_api import KEY_A, ModelResponder, backend_transport, request, settings


@pytest.mark.asyncio
async def test_provider_credentials_and_empty_delete():
    seen = []
    def model(req):
        seen.append(req)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})
    client = OwlModelClient('https://model.test/v1', 'test', api_key='fake-model-key', transport=httpx.MockTransport(model))
    await client.create([], [], 'test')
    assert seen[0].headers['authorization'] == 'Bearer fake-model-key'
    assert seen[0].url.path == '/v1/chat/completions'
    await client.close()
    backend = APICostXClient('https://api.test', transport=httpx.MockTransport(lambda req: httpx.Response(204)))
    assert await backend.delete_content(Identity('key', 'fake'), 'content-1', 'test') == {'status': 'deleted'}
    await backend.close()


@pytest.mark.asyncio
async def test_traversal_and_schema_rejected_before_network():
    calls = []
    def backend(req):
        calls.append(req)
        return httpx.Response(200, json={'id': 'valid'})
    client = APICostXClient('https://api.test', transport=httpx.MockTransport(backend))
    identity = Identity('key', 'fake')
    for value in ['..', '.', '../presets/id', r'..\presets\id', '%2e%2e', '%252e%252e', 'id?x=y', 'id#x', ' id', 'id\n']:
        with pytest.raises(OwlError):
            await client.delete_content(identity, value, 'test')
    registry = OwlToolRegistry(client)
    with pytest.raises(OwlError, match='Invalid tool arguments'):
        await registry.execute('apicostx_list_presets', {'page_size': 999999}, identity, 'test')
    assert not calls
    await client.get_content(identity, 'log:abc-123', 'test')
    assert calls[-1].url.path == '/api/contents/log:abc-123'
    await client.close()


@pytest.mark.asyncio
async def test_saved_history_cannot_bypass_limit(tmp_path):
    model = ModelResponder()
    app = create_app(replace(settings(tmp_path), max_message_chars=100), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    conversation = app.state.owl.store.create_conversation('ak_test_key_12345', 'test')
    app.state.owl.store.append_messages('ak_test_key_12345', conversation['id'], [{'role': 'user', 'content': 'x' * 101}])
    result = await request(app, 'POST', '/v1/chat/completions', json={'model': 'allie-owl', 'conversation_id': conversation['id'], 'messages': [{'role': 'user', 'content': 'hi'}]})
    assert result.status_code == 413
    assert model.calls == 0


@pytest.mark.asyncio
async def test_write_audit_survives_model_failure(tmp_path):
    calls = 0
    def model(req):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, json={'choices': [{'message': {'tool_calls': [{'id': 'call1', 'function': {'name': 'apicostx_create_content', 'arguments': json.dumps({'confirm': True, 'name': 'test', 'content_type': 'input_document', 'body': 'test'})}}]}}]})
        return httpx.Response(500, json={'error': 'fake failure'})
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    approval = {'name': 'apicostx_create_content', 'arguments': {'name': 'test', 'content_type': 'input_document', 'body': 'test'}}
    response = await request(app, 'POST', '/v1/chat/completions', json={'model': 'allie-owl', 'messages': [{'role': 'user', 'content': 'Create test content'}], 'approved_actions': [approval]})
    assert response.status_code == 502
    assert [row[0] for row in app.state.owl.store.db.execute('SELECT outcome FROM audit_events')] == ['started', 'success']
    assert app.state.owl.store.db.execute("SELECT COUNT(*) FROM usage_events WHERE kind='failed_turn'").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_same_conversation_cannot_run_twice(tmp_path):
    started, release = asyncio.Event(), asyncio.Event()
    async def model(req):
        started.set()
        await release.wait()
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}]})
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    conversation = app.state.owl.store.create_conversation('ak_test_key_12345', 'test')
    body = {'model': 'allie-owl', 'conversation_id': conversation['id'], 'messages': [{'role': 'user', 'content': 'hi'}]}
    first = asyncio.create_task(request(app, 'POST', '/v1/chat/completions', json=body))
    await started.wait()
    second = await request(app, 'POST', '/v1/chat/completions', json=body)
    assert second.status_code == 409
    release.set()
    assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_conversation_creation_is_rate_limited_and_options_not_ignored(tmp_path):
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(ModelResponder()))
    invalid = await request(app, 'POST', '/v1/chat/completions', json={'model': 'allie-owl', 'top_p': 0.5, 'messages': [{'role': 'user', 'content': 'hi'}]})
    assert invalid.status_code == 422
    app.state.owl.limits.requests_per_minute = 1
    denied = await request(app, 'POST', '/v1/conversations', json={'title': 'test'})
    assert denied.status_code == 429


@pytest.mark.asyncio
async def test_run_idempotency_replays_without_second_launch(tmp_path):
    launches = []
    def backend(req):
        if req.url.path.endswith('/execute'):
            launches.append(req)
            return httpx.Response(200, json={'run_id': 'run-1'})
        return backend_transport(req)
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend), model_transport=httpx.MockTransport(ModelResponder()))
    body = {'name': 'apicostx_execute_preset', 'arguments': {'preset_id': 'preset-1', 'confirm': True, 'idempotency_key': 'repeat-test'}}
    one = await request(app, 'POST', '/v1/tools/call', json=body)
    two = await request(app, 'POST', '/v1/tools/call', json=body)
    assert one.json()['result'] == two.json()['result'] == {'run_id': 'run-1'}
    assert len(launches) == 1
    body['arguments']['preset_id'] = 'preset-2'
    assert (await request(app, 'POST', '/v1/tools/call', json=body)).status_code == 409


@pytest.mark.asyncio
async def test_two_keys_same_user_share_history(tmp_path):
    def backend(req):
        if req.url.path == '/api/identity':
            return httpx.Response(200, json={'user_uuid': '11111111-1111-4111-8111-111111111111', 'key_id': req.headers['X-ACM2-API-Key'].split('.')[1], 'scope': 'read_write'})
        return backend_transport(req)
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend), model_transport=httpx.MockTransport(ModelResponder()))
    created = await request(app, 'POST', '/v1/conversations', json={'title': 'Shared across my keys'})
    other = await request(app, 'GET', '/v1/conversations/' + created.json()['id'], key='acm2.ak_other_key_12345.fake')
    assert other.status_code == 200


@pytest.mark.asyncio
async def test_actual_sse_frames_and_provider_deltas(tmp_path):
    def model(req):
        assert json.loads(req.content)['stream'] is True
        data = ''.join('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': text}}]}) + '\n\n' for text in ['Hello', ' owl'])
        return httpx.Response(200, text=data + 'data: [DONE]\n\n', headers={'content-type': 'text/event-stream'})
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend_transport), model_transport=httpx.MockTransport(model))
    result = await request(app, 'POST', '/v1/chat/completions', json={'model': 'allie-owl', 'stream': True, 'messages': [{'role': 'user', 'content': 'hello'}]})
    frames = result.text.strip().split('\n\n')
    assert frames[-1] == 'data: [DONE]'
    chunks = [json.loads(frame[6:]) for frame in frames[:-1]]
    assert ''.join(chunk['choices'][0]['delta'].get('content', '') for chunk in chunks) == 'Hello owl'
    assert app.state.owl.limits._inflight['11111111-1111-4111-8111-111111111111'] == 0


@pytest.mark.asyncio
async def test_model_cannot_approve_its_own_write(tmp_path):
    calls = 0
    writes = []
    def backend(req):
        if req.method != 'GET': writes.append(req)
        return backend_transport(req)
    def model(req):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(200, json={'choices': [{'message': {'tool_calls': [{'id': 'call1', 'function': {'name': 'apicostx_delete_content', 'arguments': json.dumps({'content_id': 'content-1', 'confirm': True})}}]}}]})
        return httpx.Response(200, json={'choices': [{'message': {'content': 'Approval required'}}]})
    app = create_app(settings(tmp_path), backend_transport=httpx.MockTransport(backend), model_transport=httpx.MockTransport(model))
    response = await request(app, 'POST', '/v1/chat/completions', json={'model': 'allie-owl', 'messages': [{'role': 'user', 'content': 'Read this document'}]})
    assert response.status_code == 200
    assert response.json()['acx_pending_actions'] == [{'name': 'apicostx_delete_content', 'arguments': {'content_id': 'content-1'}}]
    assert not writes


def test_shared_contract_matches_all_schemas():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    tools = OwlToolRegistry(None).openai_tools()
    assert json.loads((root / 'contracts/tool-schemas.json').read_text())['tools'] == tools
    for file in (root.parent / 'acm2-execution-reliability-local/app/services/assistant_advanced_graph/tool-schemas.json', root.parent / 'acm-wordpress-plugin-run-count-fix/ui/src/components/assistant/tool-schemas.json'):
        if file.exists():
            assert json.loads(file.read_text())['tools'] == tools


@pytest.mark.asyncio
async def test_provider_text_arrives_before_completion():
    received, release = asyncio.Event(), asyncio.Event()
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n'
            await release.wait()
            yield b'data: [DONE]\n\n'
    def provider(req): return httpx.Response(200, stream=Stream(), headers={'content-type': 'text/event-stream'})
    async def delta(text):
        assert text == 'first'
        received.set()
    client = OwlModelClient('https://mock.test/v1', 'test', transport=httpx.MockTransport(provider))
    task = asyncio.create_task(client.create([], [], 'test', on_delta=delta))
    await asyncio.wait_for(received.wait(), 2)
    assert not task.done()
    release.set()
    assert (await task)['choices'][0]['message']['content'] == 'first'
    await client.close()
