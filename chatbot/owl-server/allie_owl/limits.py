from __future__ import annotations

import time
from collections import defaultdict, deque

from .errors import OwlError


class RequestLimits:
    """Single-process guardrail; production deployment should back this with Redis."""
    def __init__(self, requests_per_minute: int = 60, concurrent_per_key: int = 4):
        self.requests_per_minute = requests_per_minute
        self.concurrent_per_key = concurrent_per_key
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._inflight: dict[str, int] = defaultdict(int)

    def admit(self, key_id: str) -> None:
        now = time.monotonic()
        bucket = self._requests[key_id]
        while bucket and bucket[0] <= now - 60:
            bucket.popleft()
        if len(bucket) >= self.requests_per_minute:
            raise OwlError("API key request limit exceeded", 429, "rate_limit_exceeded")
        self.acquire(key_id)
        bucket.append(now)

    def acquire(self, key_id: str) -> None:
        if self._inflight[key_id] >= self.concurrent_per_key:
            raise OwlError("User concurrent request limit exceeded", 429, "concurrency_limit_exceeded")
        self._inflight[key_id] += 1

    def release(self, key_id: str) -> None:
        self._inflight[key_id] = max(0, self._inflight[key_id] - 1)
