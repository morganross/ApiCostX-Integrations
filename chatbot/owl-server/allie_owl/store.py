from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .crypto import FieldCipher


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class OwlStore:
    def __init__(self, path: Path, key: bytes):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.cipher = FieldCipher(key)
        self._adopted_keys = set()
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, owner_key_id TEXT NOT NULL, title_cipher TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_owl_conversations_owner ON conversations(owner_key_id, updated_at);
        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL,
          owner_key_id TEXT NOT NULL, role TEXT NOT NULL, content_cipher TEXT NOT NULL,
          created_at TEXT NOT NULL, FOREIGN KEY(conversation_id) REFERENCES conversations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_owl_messages_owner ON messages(owner_key_id, conversation_id, id);
        CREATE TABLE IF NOT EXISTS usage_events (
          event_id TEXT PRIMARY KEY, owner_key_id TEXT NOT NULL, kind TEXT NOT NULL,
          request_id TEXT NOT NULL, input_chars INTEGER NOT NULL, output_chars INTEGER NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, tool_calls INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_owl_usage_owner_date ON usage_events(owner_key_id, created_at);
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY, owner_key_id TEXT NOT NULL, request_id TEXT NOT NULL,
          action TEXT NOT NULL, target_id TEXT, outcome TEXT NOT NULL, latency_ms INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS action_receipts (
          owner TEXT NOT NULL, token TEXT NOT NULL, fingerprint TEXT NOT NULL,
          state TEXT NOT NULL, result_cipher TEXT, PRIMARY KEY(owner, token)
        );
        """)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def reserve_action(self, owner, token, fingerprint):
        from .errors import OwlError
        with self.db:
            cursor = self.db.execute("INSERT OR IGNORE INTO action_receipts VALUES (?,?,?,'pending',NULL)", (owner, token, fingerprint))
            if cursor.rowcount:
                return False, None
            row = self.db.execute('SELECT * FROM action_receipts WHERE owner=? AND token=?', (owner, token)).fetchone()
            if row['fingerprint'] != fingerprint:
                raise OwlError('Idempotency key reused with different arguments', 409, 'idempotency_conflict')
            if row['state'] != 'complete':
                raise OwlError('Previous action is pending or has an unknown outcome; inspect the resource before retrying', 409, 'action_outcome_unknown')
            return True, self.cipher.decrypt_json(row['result_cipher'], f'action:{owner}:{token}')

    def complete_action(self, owner, token, result):
        with self.db:
            self.db.execute("UPDATE action_receipts SET state='complete', result_cipher=? WHERE owner=? AND token=?",
                            (self.cipher.encrypt_json(result, f'action:{owner}:{token}'), owner, token))

    def adopt_key_owner(self, key_id: str, owner: str) -> None:
        # Only called after the backend authenticates this exact key-to-user mapping.
        if (key_id, owner) in self._adopted_keys:
            return
        with self.db:
            for table in ('conversations', 'messages', 'usage_events', 'audit_events'):
                self.db.execute(f'UPDATE {table} SET owner_key_id=? WHERE owner_key_id=?', (owner, key_id))
        self._adopted_keys.add((key_id, owner))

    def create_conversation(self, owner: str, title: str) -> dict[str, Any]:
        conversation_id = str(uuid.uuid4())
        now = now_iso()
        encrypted = self.cipher.encrypt(title[:200], f"conversation:{conversation_id}:title")
        self.db.execute("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)", (conversation_id, owner, encrypted, now, now))
        self.db.commit()
        return {"id": conversation_id, "title": title[:200], "created_at": now, "updated_at": now}

    def get_conversation(self, owner: str, conversation_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM conversations WHERE id=? AND owner_key_id=?", (conversation_id, owner)).fetchone()
        if not row:
            return None
        return {"id": row["id"], "title": self.cipher.decrypt(row["title_cipher"], f"conversation:{row['id']}:title"), "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def list_conversations(self, owner: str, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM conversations WHERE owner_key_id=? ORDER BY updated_at DESC LIMIT ? OFFSET ?", (owner, limit, offset)).fetchall()
        return [{"id": row["id"], "title": self.cipher.decrypt(row["title_cipher"], f"conversation:{row['id']}:title"), "created_at": row["created_at"], "updated_at": row["updated_at"]} for row in rows]

    def delete_conversation(self, owner: str, conversation_id: str) -> bool:
        row = self.db.execute("SELECT id FROM conversations WHERE id=? AND owner_key_id=?", (conversation_id, owner)).fetchone()
        if not row:
            return False
        self.db.execute("DELETE FROM messages WHERE conversation_id=? AND owner_key_id=?", (conversation_id, owner))
        self.db.execute("DELETE FROM conversations WHERE id=? AND owner_key_id=?", (conversation_id, owner))
        self.db.commit()
        return True

    def append_messages(self, owner: str, conversation_id: str, messages: list[dict[str, str]]) -> None:
        if self.get_conversation(owner, conversation_id) is None:
            raise ValueError('Conversation not owned by this user')
        now = now_iso()
        for message in messages:
            message_id = str(uuid.uuid4())
            cipher = self.cipher.encrypt(message["content"], f"message:{message_id}:content")
            self.db.execute("INSERT INTO messages (id, conversation_id, owner_key_id, role, content_cipher, created_at) VALUES (?, ?, ?, ?, ?, ?)", (message_id, conversation_id, owner, message["role"], cipher, now))
        self.db.execute("UPDATE conversations SET updated_at=? WHERE id=? AND owner_key_id=?", (now, conversation_id, owner))
        self.db.commit()

    def get_messages(self, owner: str, conversation_id: str, limit: int = 101, offset: int = 0) -> list[dict[str, str]]:
        rows = self.db.execute("SELECT * FROM messages WHERE conversation_id=? AND owner_key_id=? ORDER BY sequence LIMIT ? OFFSET ?", (conversation_id, owner, limit, offset)).fetchall()
        return [{"role": row["role"], "content": self.cipher.decrypt(row["content_cipher"], f"message:{row['id']}:content")} for row in rows]

    def record_usage(self, *, event_id: str, owner: str, kind: str, request_id: str, input_chars: int, output_chars: int, input_tokens: int | None, output_tokens: int | None, tool_calls: int) -> None:
        self.db.execute("INSERT OR IGNORE INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (event_id, owner, kind, request_id, input_chars, output_chars, input_tokens, output_tokens, tool_calls, now_iso()))
        self.db.commit()

    def record_audit(self, owner: str, request_id: str, action: str, target_id: str | None, outcome: str, latency_ms: int) -> None:
        self.db.execute("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (str(uuid.uuid4()), owner, request_id, action, target_id, outcome, latency_ms, now_iso()))
        self.db.commit()

    def usage_summary(self, owner: str, days: int = 30) -> dict[str, int]:
        row = self.db.execute("SELECT COALESCE(SUM(kind='conversation'),0) conversations, COALESCE(SUM(kind='turn'),0) turns, COALESCE(SUM(kind LIKE 'failed_%'),0) failed_requests, COALESCE(SUM(tool_calls),0) tool_calls FROM usage_events WHERE owner_key_id=? AND julianday(created_at) >= julianday('now', ?)", (owner, f"-{days} days")).fetchone()
        return {key: int(row[key]) for key in row.keys()}
