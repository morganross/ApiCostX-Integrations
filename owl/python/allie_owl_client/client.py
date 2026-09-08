from __future__ import annotations

from typing import Any, Iterator
import json
import httpx


class AllieOwlError(RuntimeError):
    def __init__(self, message: str, status_code: int, code: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class _Completions:
    def __init__(self, client: "AllieOwl"):
        self.client = client

    def create(self, *, model: str, messages: list[dict[str, Any]], stream: bool = False, conversation_id: str | None = None, store: bool = False, **kwargs: Any) -> dict[str, Any] | Iterator[dict[str, Any]]:
        body = {"model": model, "messages": messages, "stream": stream, "store": store, **kwargs}
        if conversation_id:
            body["conversation_id"] = conversation_id
        if stream:
            return self.client._stream("/v1/chat/completions", body)
        return self.client._request("POST", "/v1/chat/completions", body)


class _Chat:
    def __init__(self, client: "AllieOwl"):
        self.completions = _Completions(client)


class AllieOwl:
    def __init__(self, api_key: str, base_url: str = "https://assistant.apicostx.com/owl", *, timeout: float = 60.0, transport: httpx.BaseTransport | None = None):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.transport = transport
        self.chat = _Chat(self)

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        with httpx.Client(base_url=self.base_url, timeout=self.timeout, transport=self.transport) as client:
            response = client.request(method, path, headers={"Authorization": f"Bearer {self.api_key}"}, json=body)
        if response.status_code >= 400:
            data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            error = data.get("error") or {}
            raise AllieOwlError(error.get("message", "Allie Owl request failed"), response.status_code, error.get("code", "request_failed"))
        return response.json()

    def _stream(self, path: str, body: dict[str, Any]) -> Iterator[dict[str, Any]]:
        with httpx.Client(base_url=self.base_url, timeout=self.timeout, transport=self.transport) as client:
            with client.stream("POST", path, headers={"Authorization": f"Bearer {self.api_key}"}, json=body) as response:
                if response.status_code >= 400:
                    raise AllieOwlError("Allie Owl stream failed", response.status_code, "stream_failed")
                for line in response.iter_lines():
                    if not line.startswith("data: ") or line == "data: [DONE]":
                        continue
                    yield json.loads(line[6:])

    def models(self) -> dict[str, Any]:
        return self._request("GET", "/v1/models")

    def conversations(self) -> dict[str, Any]:
        return self._request("GET", "/v1/conversations")

    def create_conversation(self, title: str = "Allie Owl conversation") -> dict[str, Any]:
        return self._request("POST", "/v1/conversations", {"title": title})

    def tools(self) -> dict[str, Any]:
        return self._request("GET", "/v1/tools")

    def usage(self, days: int = 30) -> dict[str, Any]:
        return self._request("GET", f"/v1/usage?days={int(days)}")

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request("POST", "/v1/tools/call", {"name": name, "arguments": arguments or {}})
