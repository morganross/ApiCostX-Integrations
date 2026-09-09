from pathlib import Path
import sqlite3

from allie_owl.store import OwlStore


def test_owl_conversation_fields_are_encrypted_and_owned(tmp_path: Path):
    path = tmp_path / "owl.sqlite"
    store = OwlStore(path, bytes.fromhex("22" * 32))
    conversation = store.create_conversation("ak_one", "private title canary")
    store.append_messages("ak_one", conversation["id"], [{"role": "user", "content": "private message canary"}])
    assert store.get_messages("ak_one", conversation["id"])[0]["content"] == "private message canary"
    assert store.get_conversation("ak_two", conversation["id"]) is None
    store.close()
    raw = sqlite3.connect(path)
    body = " ".join(str(row) for row in raw.execute("SELECT title_cipher FROM conversations").fetchall())
    body += " " + " ".join(str(row) for row in raw.execute("SELECT content_cipher FROM messages").fetchall())
    raw.close()
    assert "private title canary" not in body
    assert "private message canary" not in body

