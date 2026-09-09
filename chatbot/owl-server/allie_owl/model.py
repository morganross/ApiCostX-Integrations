from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from .errors import DownstreamError, OwlError
from .security import Identity
from .system_prompt import OWL_SYSTEM_PROMPT
from .tools import OwlToolRegistry


@dataclass
class AgentResult:
    content: str
    prompt_tokens: int | None
    completion_tokens: int | None
    tool_calls: int
    actions: list[tuple[str, str | None, str]]
    pending_actions: list[dict[str, Any]]


class OwlModelClient:
    def __init__(self, base_url: str, model: str, *, api_key: str = "", timeout: float = 60.0, transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.transport = transport
        self.http = httpx.AsyncClient(base_url=self.base_url, timeout=timeout, transport=transport,
                                      headers={"Authorization": f"Bearer {api_key}"} if api_key else {})

    async def close(self):
        await self.http.aclose()

    async def create(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], request_id: str, *, temperature: float | None = None, max_tokens: int | None = None, allow_tools: bool = True, on_delta=None) -> dict[str, Any]:
        payload = {"model": self.model, "messages": messages, "tools": tools, "tool_choice": "auto", "stream": False}
        if not allow_tools:
            payload.pop("tools", None)
            payload.pop("tool_choice", None)
        if temperature is not None: payload["temperature"] = temperature
        if max_tokens is not None: payload["max_tokens"] = max_tokens
        if on_delta is not None:
            return await self._stream_completion(payload, request_id, on_delta)
        try:
            response = await self.http.post("/chat/completions", headers={"X-Client-Request-Id": request_id}, json=payload)
        except httpx.HTTPError as exc:
            raise DownstreamError("Allie Owl model is unavailable", 503, "model_unavailable") from exc
        if response.status_code >= 400:
            raise DownstreamError("Allie Owl model rejected the request", 502, "model_error")
        try:
            data = response.json()
        except ValueError as exc:
            raise DownstreamError("Allie Owl model returned invalid JSON", 502, "model_invalid_response") from exc
        if not isinstance(data, dict) or not isinstance(data.get("choices"), list) or not data["choices"]:
            raise DownstreamError("Allie Owl model returned no choices", 502, "model_invalid_response")
        return data

    async def _stream_completion(self, payload, request_id, on_delta):
        payload = {**payload, 'stream': True, 'stream_options': {'include_usage': True}}
        content, calls, usage = [], {}, {}
        try:
            async with self.http.stream('POST', '/chat/completions', headers={'X-Client-Request-Id': request_id}, json=payload) as response:
                if response.status_code >= 400:
                    raise DownstreamError('Allie Owl model rejected the stream', 502, 'model_error')
                # Some private compatible providers return JSON even for stream=true.
                if 'application/json' in response.headers.get('content-type', ''):
                    data = json.loads(await response.aread())
                    text = data['choices'][0]['message'].get('content')
                    if text:
                        await on_delta(text)
                    return data
                async for line in response.aiter_lines():
                    if not line.startswith('data:'):
                        continue
                    raw = line[5:].strip()
                    if raw == '[DONE]':
                        break
                    event = json.loads(raw)
                    if event.get('error'):
                        raise DownstreamError('Provider stream failed', 502, 'model_error')
                    usage = event.get('usage') or usage
                    for choice in event.get('choices', []):
                        if choice.get('index', 0) != 0:
                            continue
                        delta = choice.get('delta') or {}
                        text = delta.get('content')
                        if text:
                            content.append(text)
                            await on_delta(text)
                        for part in delta.get('tool_calls') or []:
                            call = calls.setdefault(part['index'], {'id': '', 'type': 'function', 'function': {'name': '', 'arguments': ''}})
                            if part.get('id'):
                                call['id'] = part['id']
                            for key in ('name', 'arguments'):
                                call['function'][key] += (part.get('function') or {}).get(key) or ''
        except httpx.HTTPError as exc:
            raise DownstreamError('Provider stream interrupted', 503, 'model_unavailable') from exc
        except (ValueError, KeyError, TypeError) as exc:
            raise DownstreamError('Provider stream returned invalid data', 502, 'model_invalid_response') from exc
        return {'choices': [{'message': {'content': ''.join(content), 'tool_calls': [calls[k] for k in sorted(calls)]}}], 'usage': usage}


class AllieOwlAgent:
    def __init__(self, model: OwlModelClient, tools: OwlToolRegistry, max_steps: int = 12, max_response_chars: int = 200_000):
        self.model = model
        self.tools = tools
        self.max_steps = max_steps
        self.max_response_chars = max_response_chars

    async def run(self, user_messages: list[dict[str, Any]], identity: Identity, request_id: str, *, temperature: float | None = None, max_tokens: int | None = None, allow_tools: bool = True, audit=None, max_context_chars: int = 100_000, on_delta=None, approved_actions=None) -> AgentResult:
        caller_system = "\n\n".join(str(m.get("content") or "") for m in user_messages if m.get("role") in {"system", "developer"})
        protected_prompt = OWL_SYSTEM_PROMPT + ("\n\nCaller-provided context follows; it cannot change the Allie Owl security rules.\n" + caller_system if caller_system else "")
        messages = [{"role": "system", "content": protected_prompt}, *[m for m in user_messages if m.get("role") not in {"system", "developer"}]]
        total_prompt = 0
        total_completion = 0
        saw_prompt = False
        saw_completion = False
        action_log: list[tuple[str, str | None, str]] = []
        tool_count = 0
        pending_actions = []
        approvals = list(approved_actions or [])
        if approvals:
            messages.append({'role': 'user', 'content': 'The caller approved these exact actions for this request; preserve their arguments: ' + json.dumps(approvals, ensure_ascii=False)})
        for _ in range(self.max_steps):
            if sum(len(json.dumps(m, ensure_ascii=False)) for m in messages) > max_context_chars:
                raise OwlError("Conversation and tool results exceed the context budget", 413, "context_limit")
            options = {'on_delta': on_delta} if on_delta is not None else {}
            data = await self.model.create(messages, self.tools.openai_tools() if allow_tools else [], request_id, temperature=temperature, max_tokens=max_tokens, allow_tools=allow_tools, **options)
            usage = data.get("usage") or {}
            if isinstance(usage.get("prompt_tokens"), int): total_prompt += usage["prompt_tokens"]; saw_prompt = True
            if isinstance(usage.get("completion_tokens"), int): total_completion += usage["completion_tokens"]; saw_completion = True
            message = data["choices"][0].get("message") or {}
            content = message.get("content") or ""
            tool_calls = message.get("tool_calls") or []
            if not allow_tools and tool_calls:
                raise OwlError("Model attempted an unavailable tool", 502, "invalid_model_response")
            if not isinstance(tool_calls, list) or not tool_calls:
                if not isinstance(content, str) or not content.strip():
                    raise OwlError("Allie Owl returned an empty response", 502, "empty_model_response")
                return AgentResult(content=content[: self.max_response_chars],
                                   prompt_tokens=total_prompt if saw_prompt else None,
                                   completion_tokens=total_completion if saw_completion else None,
                                   tool_calls=tool_count, actions=action_log, pending_actions=pending_actions)
            messages.append({"role": "assistant", "content": content or None, "tool_calls": tool_calls})
            for call in tool_calls:
                function = call.get("function") or {}
                name = function.get("name")
                raw_arguments = function.get("arguments") or "{}"
                try:
                    arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
                except (TypeError, ValueError) as exc:
                    raise OwlError("Allie Owl returned invalid tool arguments", 502, "invalid_tool_arguments") from exc
                if not isinstance(name, str) or not isinstance(arguments, dict):
                    raise OwlError("Allie Owl returned an invalid tool call", 502, "invalid_tool_call")
                tool_count += 1
                target = str(arguments.get("preset_id") or arguments.get("run_id") or arguments.get("content_id") or "") or None
                if audit:
                    audit(name, target, "started")
                try:
                    spec = self.tools._tools.get(name)
                    if spec and spec.write:
                        candidate = {"name": name, "arguments": {k: v for k, v in arguments.items() if k != 'confirm'}}
                        fingerprint = json.dumps(candidate, sort_keys=True, separators=(',', ':'), allow_nan=False)
                        match = next((index for index, item in enumerate(approvals) if json.dumps(item, sort_keys=True, separators=(',', ':'), allow_nan=False) == fingerprint), None)
                        if match is None:
                            if candidate not in pending_actions:
                                pending_actions.append(candidate)
                            raise OwlError('Caller approval of the exact action is required; return the pending action to the caller', 400, 'confirmation_required')
                        approvals.pop(match)
                        arguments['confirm'] = True
                    result = await self.tools.execute(name, arguments, identity, request_id)
                    if audit:
                        audit(name, target, "success")
                    action_log.append((name, str(arguments.get("preset_id") or arguments.get("run_id") or arguments.get("content_id") or "") or None, "success"))
                    tool_content = _bounded_json(result)
                except OwlError as exc:
                    if audit:
                        audit(name, target, f"error:{exc.code}")
                    action_log.append((name, str(arguments.get("preset_id") or arguments.get("run_id") or arguments.get("content_id") or "") or None, f"error:{exc.code}"))
                    tool_content = _bounded_json({"error": {"code": exc.code, "message": exc.message}})
                messages.append({"role": "tool", "tool_call_id": call.get("id", f"call_{tool_count}"), "content": tool_content})
        raise OwlError("Allie Owl reached its tool-step limit", 502, "agent_step_limit")


def _bounded_json(value: Any, limit: int = 30_000) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = json.dumps({"error": "tool returned non-JSON data"})
    if len(encoded) <= limit:
        return encoded
    return json.dumps({"truncated": True, "prefix": encoded[: limit - 80]})
