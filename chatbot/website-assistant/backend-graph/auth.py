"""
Internal HMAC authentication for CopilotKit runtime -> backend bridge calls.
"""
from __future__ import annotations

import base64
import hmac
import time
from dataclasses import dataclass
from hashlib import sha256

from fastapi import HTTPException
from starlette.datastructures import Headers

from app.config import Settings


HEADER_CALLER = "X-ACM2-Bridge-Caller"
HEADER_TIMESTAMP = "X-ACM2-Bridge-Timestamp"
HEADER_SIGNATURE = "X-ACM2-Bridge-Signature"
HEADER_USER_UUID = "X-ACM2-Bridge-User-UUID"
HEADER_MODE = "X-ACM2-Bridge-Mode"
HEADER_AGENT_ID = "X-ACM2-Bridge-Agent-ID"
HEADER_THREAD_ID = "X-ACM2-Bridge-Thread-ID"
HEADER_TRACE_ID = "X-ACM2-Bridge-Trace-ID"


@dataclass(frozen=True)
class AdvancedBridgeClaims:
    caller_id: str
    user_uuid: str
    mode: str
    agent_id: str
    thread_id: str | None
    trace_id: str | None


def verify_advanced_bridge_request(
    *,
    settings: Settings,
    headers: Headers,
    body: bytes,
) -> AdvancedBridgeClaims:
    """Validate scoped bridge headers and an HMAC over those claims plus body."""
    secret = settings.assistant_advanced_bridge_signing_secret
    if not secret:
        raise HTTPException(status_code=503, detail="Advanced assistant bridge secret is not configured")

    caller_id = _required_header(headers, HEADER_CALLER)
    timestamp = _required_header(headers, HEADER_TIMESTAMP)
    signature = _required_header(headers, HEADER_SIGNATURE)
    user_uuid = _required_header(headers, HEADER_USER_UUID)
    mode = _required_header(headers, HEADER_MODE)
    agent_id = _required_header(headers, HEADER_AGENT_ID)
    thread_id = headers.get(HEADER_THREAD_ID) or None
    trace_id = headers.get(HEADER_TRACE_ID) or None

    if caller_id != settings.assistant_advanced_bridge_expected_caller_id:
        raise HTTPException(status_code=403, detail="Invalid advanced assistant bridge caller")
    if mode != settings.assistant_advanced_bridge_allowed_mode:
        raise HTTPException(status_code=403, detail="Invalid advanced assistant bridge mode")
    if agent_id != settings.assistant_advanced_bridge_allowed_agent_id:
        raise HTTPException(status_code=403, detail="Invalid advanced assistant bridge agent")
    if not user_uuid.strip():
        raise HTTPException(status_code=400, detail="Advanced assistant bridge user UUID is required")

    _verify_fresh_timestamp(
        timestamp,
        tolerance_seconds=settings.assistant_advanced_bridge_signature_tolerance_seconds,
    )
    expected = sign_advanced_bridge_request(
        secret=secret,
        timestamp=timestamp,
        caller_id=caller_id,
        user_uuid=user_uuid,
        mode=mode,
        agent_id=agent_id,
        thread_id=thread_id,
        trace_id=trace_id,
        body=body,
    )
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid advanced assistant bridge signature")

    return AdvancedBridgeClaims(
        caller_id=caller_id,
        user_uuid=user_uuid,
        mode=mode,
        agent_id=agent_id,
        thread_id=thread_id,
        trace_id=trace_id,
    )


def sign_advanced_bridge_request(
    *,
    secret: str,
    timestamp: str,
    caller_id: str,
    user_uuid: str,
    mode: str,
    agent_id: str,
    thread_id: str | None,
    trace_id: str | None,
    body: bytes,
) -> str:
    payload = "\n".join(
        [
            timestamp,
            caller_id,
            user_uuid,
            mode,
            agent_id,
            thread_id or "",
            trace_id or "",
            body.decode("utf-8"),
        ]
    ).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), payload, sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _required_header(headers: Headers, name: str) -> str:
    value = headers.get(name)
    if not value:
        raise HTTPException(status_code=401, detail=f"Missing {name}")
    return value


def _verify_fresh_timestamp(timestamp: str, *, tolerance_seconds: int) -> None:
    try:
        timestamp_seconds = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid advanced assistant bridge timestamp") from exc

    now = int(time.time())
    tolerance = max(1, int(tolerance_seconds))
    if abs(now - timestamp_seconds) > tolerance:
        raise HTTPException(status_code=401, detail="Expired advanced assistant bridge signature")
