from __future__ import annotations

import re
from dataclasses import dataclass, field

from .errors import OwlError

_KEY_RE = re.compile(r"^acm2\.(ak_[A-Za-z0-9_-]{12,80})\.([^\s.]+)$")


@dataclass(frozen=True)
class Identity:
    key_id: str
    raw_key: str = field(repr=False)
    user_uuid: str | None = None
    scope: str | None = None

    @property
    def owner(self):
        if not self.user_uuid:
            raise OwlError("Authenticated user identity is unavailable", 503, "identity_unavailable")
        return self.user_uuid


def parse_bearer(value: str | None) -> Identity:
    raw = (value or "").strip()
    if raw.lower().startswith("bearer "):
        raw = raw[7:].strip()
    match = _KEY_RE.fullmatch(raw)
    if not match:
        raise OwlError("Invalid or missing API key", 401, "invalid_api_key")
    return Identity(key_id=match.group(1), raw_key=raw)
