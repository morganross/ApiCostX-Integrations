from __future__ import annotations

from pathlib import Path


def load_knowledge(root: Path | None = None, max_chars: int = 40_000) -> str:
    root = root or Path(__file__).resolve().parents[1] / "knowledge"
    parts = []
    remaining = max_chars
    for path in sorted(root.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        if len(text) > remaining:
            text = text[:remaining] + "\n[knowledge truncated]"
        parts.append(f"## {path.stem}\n{text}")
        remaining -= len(text)
        if remaining <= 0:
            break
    return "\n\n".join(parts)

