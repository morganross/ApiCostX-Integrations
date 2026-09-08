"""Small, typed-by-convention client for the APICostX REST API.

The client deliberately returns JSON dictionaries so it stays aligned with
the live API while that public contract is being finalized.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Iterable

import httpx


DEFAULT_BASE_URL = "https://api.apicostx.com"
AUTH_HEADER = "X-ACM2-API-Key"
TERMINAL_STATUSES = {
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
    "canceled",
    "error",
}


class ApiError(RuntimeError):
    """An APICostX request failed."""

    def __init__(self, message: str, *, status_code: int, detail: Any = None, response: httpx.Response | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail
        self.response = response


class AuthenticationError(ApiError):
    """The API key is missing, invalid, revoked, or expired."""


class PermissionError(ApiError):
    """The API key scope or membership does not permit the operation."""


class NotFoundError(ApiError):
    """The requested user-owned resource does not exist."""


class RateLimitError(ApiError):
    """The API asked the caller to slow down."""

    @property
    def retry_after(self) -> float | None:
        if not self.response:
            return None
        value = self.response.headers.get("Retry-After")
        try:
            return float(value) if value is not None else None
        except ValueError:
            return None


class ApiClient:
    """APICostX API client.

    Parameters:
        api_key: A complete user API key. Keep it in an environment variable
            or a local secret store; do not commit it to source code.
        base_url: API origin, defaulting to the hosted APICostX API.
        timeout: Default HTTP timeout in seconds.
        transport: Optional httpx transport for tests or custom networking.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 2,
        retry_backoff: float = 0.5,
        transport: httpx.BaseTransport | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.api_key = api_key.strip() if api_key else None
        self.base_url = base_url.rstrip("/")
        self.max_retries = max(0, int(max_retries))
        self.retry_backoff = max(0.0, float(retry_backoff))
        self.timeout = timeout
        self._client = client or httpx.Client(
            base_url=self.base_url,
            timeout=timeout,
            transport=transport,
            headers={"Accept": "application/json", "User-Agent": "apicostx-client/0.1.1"},
        )
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "ApiClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        authenticated: bool = True,
        deadline: float | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        if authenticated and not self.api_key:
            raise AuthenticationError(
                "An APICOSTX_API_KEY is required for this operation",
                status_code=401,
            )

        headers: dict[str, str] = {}
        if authenticated:
            headers[AUTH_HEADER] = self.api_key or ""
        headers.update(extra_headers or {})
        method = method.upper()
        safe_to_retry = method in {"GET", "HEAD", "OPTIONS"}
        response: httpx.Response | None = None
        for attempt in range(self.max_retries + 1):
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("Run wait timeout exceeded")
            request_options = {} if deadline is None else {"timeout": min(self.timeout, max(0.001, deadline - time.monotonic()))}
            try:
                response = self._client.request(method, path, json=json, params=params, headers=headers, follow_redirects=False, **request_options)
            except (httpx.TimeoutException, httpx.NetworkError):
                if not safe_to_retry or attempt >= self.max_retries:
                    raise
                delay = self.retry_backoff * (2**attempt)
                time.sleep(delay if deadline is None else min(delay, max(0, deadline - time.monotonic())))
                continue
            if safe_to_retry and response.status_code in {429, 502, 503, 504} and attempt < self.max_retries:
                retry_after = response.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after is not None else self.retry_backoff * (2**attempt)
                except ValueError:
                    delay = self.retry_backoff * (2**attempt)
                time.sleep(max(0.0, delay) if deadline is None else min(max(0.0, delay), max(0, deadline - time.monotonic())))
                continue
            break
        assert response is not None
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("Run wait timeout exceeded")
        if response.is_success:
            if response.status_code in {204, 205} or not response.content:
                return None
            content_type = response.headers.get("content-type", "")
            return response.json() if "json" in content_type else response.content

        detail: Any = None
        try:
            payload = response.json()
            detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
        except ValueError:
            detail = response.text[:1000]
        message = str(detail or response.reason_phrase or "APICostX request failed")
        error_type: type[ApiError]
        if response.status_code == 401:
            error_type = AuthenticationError
        elif response.status_code == 403:
            error_type = PermissionError
        elif response.status_code == 404:
            error_type = NotFoundError
        elif response.status_code == 429:
            error_type = RateLimitError
        else:
            error_type = ApiError
        raise error_type(message, status_code=response.status_code, detail=detail, response=response)

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/api/health", authenticated=False)

    def list_presets(self, *, page: int = 1, page_size: int = 100) -> dict[str, Any]:
        return self._request("GET", "/api/presets", params={"page": page, "page_size": page_size})

    def get_preset(self, preset_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/presets/{preset_id}")

    def check_preset(self, preset_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/presets/{preset_id}/runnable")

    def execute_preset(
        self,
        preset_id: str,
        *,
        input_content_ids: Iterable[str] | None = None,
        idempotency_key: str | None = None,
        overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if input_content_ids is not None:
            body["input_content_ids"] = list(input_content_ids)
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        if overrides is not None:
            body["overrides"] = overrides
        extra_headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._request("POST", f"/api/presets/{preset_id}/execute", json=body or None, extra_headers=extra_headers)

    def list_runs(
        self,
        *,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status
        return self._request("GET", "/api/runs", params=params)

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/runs/{run_id}")

    def get_live_summary(self, run_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/runs/{run_id}/live-summary")

    def get_run_snapshot(self, run_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/runs/{run_id}/snapshot")

    def get_generated_results(self, run_id: str, *, source_doc_id: str | None = None, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        params = {"limit": limit, "offset": offset}
        if source_doc_id:
            params["source_doc_id"] = source_doc_id
        return self._request("GET", f"/api/runs/{run_id}/sections/generated", params=params)

    def get_evaluation_results(self, run_id: str, *, source_doc_id: str, limit: int = 25, offset: int = 0) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/api/runs/{run_id}/sections/evaluation",
            params={"source_doc_id": source_doc_id, "limit": limit, "offset": offset},
        )

    def wait_for_run(
        self,
        run_id: str,
        *,
        timeout: float = 3600.0,
        poll_interval: float = 2.0,
        on_update: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            payload = self._request("GET", f"/api/runs/{run_id}/live-summary", deadline=deadline)
            if on_update:
                on_update(payload)
            status = str(payload.get("status") or payload.get("run_status") or "").lower()
            if status in TERMINAL_STATUSES:
                return self._request("GET", f"/api/runs/{run_id}", deadline=deadline)
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Run {run_id} did not finish within {timeout:g} seconds")
            time.sleep(min(max(0.1, poll_interval), max(0, deadline - time.monotonic())))

    def download_export(self, run_id: str, destination: str | Path) -> Path:
        payload = self._request("GET", f"/api/runs/{run_id}/export")
        if not isinstance(payload, (bytes, bytearray)):
            raise ApiError(
                "APICostX returned a non-file export response",
                status_code=200,
                detail=payload,
            )
        path = Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes(payload))
        return path
