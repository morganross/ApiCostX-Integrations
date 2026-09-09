from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    backend_api_url: str = "https://api.apicostx.com"
    openai_base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-5.6-luna"
    model_api_key: str = field(default="", repr=False)
    data_path: Path = Path("./data/allie-owl.sqlite")
    data_kek_hex: str = ""
    max_steps: int = 12
    max_messages: int = 100
    max_message_chars: int = 100_000
    max_response_chars: int = 200_000
    request_timeout_seconds: float = 60.0

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            backend_api_url=os.getenv("ALLIE_OWL_BACKEND_API_URL", cls.backend_api_url).rstrip("/"),
            openai_base_url=os.getenv("ALLIE_OWL_OPENAI_BASE_URL", cls.openai_base_url).rstrip("/"),
            model=os.getenv("ALLIE_OWL_MODEL", cls.model).strip() or cls.model,
            model_api_key=os.getenv("ALLIE_OWL_MODEL_API_KEY", os.getenv("OPENAI_API_KEY", "")),
            data_path=Path(os.getenv("ALLIE_OWL_DATA_PATH", str(cls.data_path))),
            data_kek_hex=os.getenv("ALLIE_OWL_DATA_KEK", "").strip(),
            max_steps=_bounded_int("ALLIE_OWL_MAX_STEPS", 12, 1, 32),
            max_messages=_bounded_int("ALLIE_OWL_MAX_MESSAGES", 100, 1, 1000),
            max_message_chars=_bounded_int("ALLIE_OWL_MAX_MESSAGE_CHARS", 100_000, 100, 1_000_000),
            max_response_chars=_bounded_int("ALLIE_OWL_MAX_RESPONSE_CHARS", 200_000, 1000, 1_000_000),
            request_timeout_seconds=float(os.getenv("ALLIE_OWL_REQUEST_TIMEOUT_SECONDS", "60")),
        )

    def kek_bytes(self) -> bytes:
        if len(self.data_kek_hex) != 64:
            raise RuntimeError("ALLIE_OWL_DATA_KEK must be 64 hex characters")
        try:
            key = bytes.fromhex(self.data_kek_hex)
        except ValueError as exc:
            raise RuntimeError("ALLIE_OWL_DATA_KEK must be hexadecimal") from exc
        if len(key) != 32:
            raise RuntimeError("ALLIE_OWL_DATA_KEK must decode to 32 bytes")
        return key


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))
