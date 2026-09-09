from __future__ import annotations

from typing import Any

import httpx

from .errors import DownstreamError, OwlError
from .security import Identity


class APICostXClient:
    """Small allowlisted client for the unchanged APICostX user API."""

    def __init__(self, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.transport = transport
        self.timeout = timeout
        self.http = httpx.AsyncClient(base_url=self.base_url, transport=transport, timeout=timeout)

    async def close(self):
        await self.http.aclose()

    async def _request(self, method: str, path: str, identity: Identity, **kwargs: Any) -> Any:
        if not path.startswith("/api/") or "//" in path:
            raise OwlError("Unsupported downstream path", 500, "configuration_error")
        headers = dict(kwargs.pop("headers", {}))
        headers["X-ACM2-API-Key"] = identity.raw_key
        headers["X-Client-Request-Id"] = kwargs.pop("request_id", "allie-owl")
        try:
            response = await self.http.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise DownstreamError("APICostX API is unavailable", 503, "downstream_unavailable") from exc
        if response.status_code == 401:
            raise OwlError("Invalid or revoked API key", 401, "invalid_api_key")
        if response.status_code == 403:
            raise OwlError("API key is not allowed to perform this action", 403, "permission_denied")
        if response.status_code == 404:
            raise OwlError("APICostX resource was not found", 404, "not_found")
        if response.status_code >= 400:
            detail = "APICostX API rejected the request"
            if response.status_code in {400, 409, 422, 429}:
                try:
                    import json
                    detail = json.dumps(response.json().get("detail", detail), ensure_ascii=False)[:4000]
                except (ValueError, AttributeError):
                    pass
            raise DownstreamError(detail, response.status_code if response.status_code < 500 else 502, "downstream_error")
        if response.status_code == 204:
            return {"status": "deleted"} if method == "DELETE" else {"status": "success"}
        try:
            return response.json()
        except ValueError as exc:
            raise DownstreamError("APICostX API returned invalid JSON", 502, "downstream_invalid_response") from exc

    async def verify(self, identity: Identity, request_id: str) -> Identity:
        from uuid import UUID
        data = await self._request("GET", "/api/identity", identity, request_id=request_id)
        try:
            owner = str(UUID(data["user_uuid"]))
            if data.get("key_id") != identity.key_id or data.get("scope") not in {"read", "read_write"}:
                raise ValueError("Invalid identity response")
        except (ValueError, TypeError, KeyError) as exc:
            raise OwlError("APICostX identity response is invalid", 502, "identity_unavailable") from exc
        return Identity(identity.key_id, identity.raw_key, owner, data["scope"])

    async def list_content(self, identity: Identity, page: int = 1, page_size: int = 20, search: str | None = None, content_type: str | None = None, request_id: str = "allie-owl") -> Any:
        params = {"page": page, "page_size": page_size}
        if search: params["search"] = search
        if content_type: params["content_type"] = content_type
        return await self._request("GET", "/api/contents", identity, params=params, request_id=request_id)

    async def get_content(self, identity: Identity, content_id: str, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", f"/api/contents/{_id(content_id)}", identity, request_id=request_id)

    async def create_content(self, identity: Identity, payload: dict[str, Any], request_id: str) -> Any:
        return await self._request("POST", "/api/contents", identity, json=payload, request_id=request_id)

    async def update_content(self, identity: Identity, content_id: str, payload: dict[str, Any], request_id: str) -> Any:
        return await self._request("PUT", f"/api/contents/{_id(content_id)}", identity, json=payload, request_id=request_id)

    async def delete_content(self, identity: Identity, content_id: str, request_id: str) -> Any:
        return await self._request("DELETE", f"/api/contents/{_id(content_id)}", identity, request_id=request_id)

    async def list_presets(self, identity: Identity, page: int = 1, page_size: int = 20, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", "/api/presets", identity, params={"page": page, "page_size": page_size}, request_id=request_id)

    async def get_preset(self, identity: Identity, preset_id: str, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", f"/api/presets/{_id(preset_id)}", identity, request_id=request_id)

    async def validate_preset(self, identity: Identity, preset_id: str, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", f"/api/presets/{_id(preset_id)}/runnable", identity, request_id=request_id)

    async def create_preset(self, identity: Identity, payload: dict[str, Any], request_id: str) -> Any:
        return await self._request("POST", "/api/presets", identity, json=payload, request_id=request_id)

    async def update_preset(self, identity: Identity, preset_id: str, payload: dict[str, Any], request_id: str) -> Any:
        return await self._request("PUT", f"/api/presets/{_id(preset_id)}", identity, json=payload, request_id=request_id)

    async def delete_preset(self, identity: Identity, preset_id: str, request_id: str) -> Any:
        return await self._request("DELETE", f"/api/presets/{_id(preset_id)}", identity, request_id=request_id)

    async def execute_preset(self, identity: Identity, preset_id: str, request_id: str, idempotency_key: str | None = None) -> Any:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
        return await self._request("POST", f"/api/presets/{_id(preset_id)}/execute", identity, headers=headers, json={}, request_id=request_id)

    async def list_runs(self, identity: Identity, page: int = 1, page_size: int = 20, status: str | None = None, request_id: str = "allie-owl") -> Any:
        params = {"page": page, "page_size": page_size}
        if status: params["status"] = status
        return await self._request("GET", "/api/runs", identity, params=params, request_id=request_id)

    async def get_run(self, identity: Identity, run_id: str, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", f"/api/runs/{_id(run_id)}", identity, request_id=request_id)

    async def control_run(self, identity: Identity, run_id: str, operation: str, request_id: str) -> Any:
        if operation not in {"pause", "resume", "cancel"}:
            raise OwlError("Unsupported run operation", 422, "invalid_request_error")
        return await self._request("POST", f"/api/runs/{_id(run_id)}/{operation}", identity, json={}, request_id=request_id)

    async def get_run_logs(self, identity: Identity, run_id: str, classification: str = "event", limit: int = 100, offset: int = 0, request_id: str = "allie-owl") -> Any:
        if classification not in {"event", "all"}:
            raise OwlError("classification must be event or all", 422, "invalid_request_error", "classification")
        return await self._request("GET", f"/api/runs/{_id(run_id)}/logs", identity, params={"classification": classification, "limit": min(limit, 5000), "offset": max(offset, 0)}, request_id=request_id)

    async def get_output(self, identity: Identity, run_id: str, doc_id: str, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", f"/api/runs/{_id(run_id)}/generated/{_path_id(doc_id)}", identity, request_id=request_id)

    async def get_models(self, identity: Identity, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", "/api/models", identity, request_id=request_id)

    async def get_usage(self, identity: Identity, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", "/api/assistant-usage", identity, request_id=request_id)

    async def get_credits(self, identity: Identity, request_id: str = "allie-owl") -> Any:
        return await self._request("GET", "/api/credits", identity, request_id=request_id)


def _id(value: str) -> str:
    from urllib.parse import quote
    if not isinstance(value, str) or not value or len(value) > 255 or value.strip() != value or value in {".", ".."} or any(c in value for c in '/\\%?#') or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
        raise OwlError("Invalid resource identifier", 422, "invalid_request_error")
    return quote(value, safe="._:-")


def _path_id(value: str) -> str:
    return _id(value)
