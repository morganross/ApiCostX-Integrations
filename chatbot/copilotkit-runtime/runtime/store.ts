import { randomUUID, createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AssistantDataEncryption } from "./dataEncryption.js";
import type { UsageTick } from "./usage.js";

type JsonObject = Record<string, unknown>;
const MAX_CACHED_USER_KEYS = 256;

export interface AssistantThread {
  id: string;
  title: string;
  archived: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface AssistantEvent {
  id: number;
  role: string;
  event_type: string;
  content: string | null;
  tool_name: string | null;
  tool_args_json: JsonObject | null;
  tool_result_json: JsonObject | null;
  created_at: string;
}

export interface AssistantMemory {
  summary: string | null;
  pinned_facts_json: JsonObject;
  summarized_through_event_id: number | null;
  updated_at: string | null;
}

export class AssistantStore {
  private readonly db: DatabaseSync;
  private readonly crypto: AssistantDataEncryption;
  private readonly userKeyCache = new Map<string, Buffer>();
  private readonly databasePath: string;

  constructor(databasePath: string, dataKekHex: string) {
    this.databasePath = databasePath;
    this.crypto = new AssistantDataEncryption(dataKekHex);
    mkdirSync(dirname(databasePath), { recursive: true });
    chmodSync(dirname(databasePath), 0o700);
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA secure_delete = ON");
      this.migrate();
      this.assertDataKek();
      this.assertOwnershipIntegrity();
      const migratedFieldCount = this.backfillSensitiveData();
      if (migratedFieldCount > 0) {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        this.db.exec("VACUUM");
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      this.hardenFilePermissions();
    } catch (error) {
      this.db.close();
      this.hardenFilePermissions();
      throw error;
    }
  }

  close(): void {
    for (const key of this.userKeyCache.values()) key.fill(0);
    this.userKeyCache.clear();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.hardenFilePermissions();
  }

  listThreads(userUuid: string, includeArchived: boolean): AssistantThread[] {
    const rows = this.db.prepare(
      `SELECT id, title, archived, created_at, updated_at FROM assistant_threads
       WHERE user_uuid = ? AND (? = 1 OR archived = 0)
       ORDER BY updated_at DESC, created_at DESC`
    ).all(userUuid, includeArchived ? 1 : 0) as Record<string, unknown>[];
    return rows.map((row) => this.rowToThread(row, userUuid));
  }

  createThread(userUuid: string, title: string): AssistantThread {
    const now = nowIso();
    const id = randomUUID();
    const encryptedTitle = this.encryptValue(userUuid, "assistant_threads", "title", id, title);
    const encryptedSummary = this.encryptValue(userUuid, "assistant_memory", "summary", id, "");
    const encryptedPinnedFacts = this.encryptValue(userUuid, "assistant_memory", "pinned_facts_json", id, "{}");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO assistant_threads (id, user_uuid, title, archived, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      ).run(id, userUuid, encryptedTitle, now, now);
      this.db.prepare(
        `INSERT INTO assistant_memory (thread_id, user_uuid, summary, pinned_facts_json, summarized_through_event_id, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)`
      ).run(id, userUuid, encryptedSummary, encryptedPinnedFacts, now);
      this.enqueueUsage(userUuid, "conversation", id, "", now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, title, archived: false, created_at: now, updated_at: now };
  }

  updateThread(userUuid: string, threadId: string, patch: { title?: string; archived?: boolean }): AssistantThread {
    this.assertThread(userUuid, threadId);
    const current = this.getThread(userUuid, threadId);
    const title = patch.title ?? current.title;
    const archived = patch.archived ?? current.archived;
    const now = nowIso();
    const encryptedTitle = this.encryptValue(userUuid, "assistant_threads", "title", threadId, title);
    this.db.prepare(
      `UPDATE assistant_threads SET title = ?, archived = ?, updated_at = ? WHERE id = ? AND user_uuid = ?`
    ).run(encryptedTitle, archived ? 1 : 0, now, threadId, userUuid);
    return this.getThread(userUuid, threadId);
  }

  enqueueUsage(subject: string, kind: "conversation" | "turn", threadId: string,
               turnId = "", occurredAt = nowIso()): void {
    this.assertThread(subject, threadId);
    const eventId = createHash("sha256").update(JSON.stringify([subject, kind, threadId, turnId])).digest("hex");
    this.db.prepare(`INSERT OR IGNORE INTO assistant_usage_outbox
      (event_id, subject, kind, occurred_at) VALUES (?, ?, ?, ?)`)
      .run(eventId, subject, kind, occurredAt);
  }

  pendingUsageBatches(): Array<{ subject: string; events: UsageTick[] }> {
    const subjects = this.db.prepare(`SELECT subject FROM assistant_usage_outbox WHERE delivered = 0
      GROUP BY subject ORDER BY MAX(COALESCE(attempted_at, '')) ASC LIMIT 8`).all() as Array<{ subject: string }>;
    return subjects.map(({ subject }) => ({ subject, events: this.db.prepare(
      `SELECT event_id, kind, occurred_at FROM assistant_usage_outbox
       WHERE subject = ? AND delivered = 0 ORDER BY occurred_at, event_id LIMIT 100`
    ).all(subject) as unknown as UsageTick[] }));
  }

  markUsageAttempt(ids: string[]): void {
    const update = this.db.prepare("UPDATE assistant_usage_outbox SET attempted_at = ? WHERE event_id = ?");
    for (const id of ids) update.run(nowIso(), id);
  }

  acknowledgeUsage(ids: string[]): void {
    const update = this.db.prepare("UPDATE assistant_usage_outbox SET delivered = 1 WHERE event_id = ?");
    for (const id of ids) update.run(id);
  }

  pendingUsageCount(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM assistant_usage_outbox WHERE delivered = 0").get()?.n ?? 0);
  }

  getThread(userUuid: string, threadId: string): AssistantThread {
    const row = this.db.prepare(
      `SELECT id, title, archived, created_at, updated_at FROM assistant_threads WHERE id = ? AND user_uuid = ?`
    ).get(threadId, userUuid) as Record<string, unknown> | undefined;
    if (!row) throw new HttpLikeError(404, "Assistant thread not found");
    return this.rowToThread(row, userUuid);
  }

  getContext(userUuid: string, threadId: string, limit: number) {
    const thread = this.getThread(userUuid, threadId);
    const memory = this.getMemory(userUuid, threadId);
    const rows = this.db.prepare(
      `SELECT id, role, event_type, content, tool_name, tool_args_json, tool_result_json, created_at
       FROM assistant_events WHERE thread_id = ? AND user_uuid = ? ORDER BY id DESC LIMIT ?`
    ).all(threadId, userUuid, limit) as Record<string, unknown>[];
    const recent_events = rows.reverse().map((row) => this.rowToEvent(row, userUuid, threadId));
    return {
      thread,
      memory,
      recent_events,
      last_summarized_event_id: memory.summarized_through_event_id
    };
  }

  addEvents(userUuid: string, threadId: string, events: Array<Partial<AssistantEvent>>): AssistantEvent[] {
    this.assertThread(userUuid, threadId);
    const now = nowIso();
    const inserted: AssistantEvent[] = [];
    const insertStmt = this.db.prepare(
      `INSERT INTO assistant_events (thread_id, user_uuid, role, event_type, content, tool_name, tool_args_json, tool_result_json, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`
    );
    const updateStmt = this.db.prepare(
      `UPDATE assistant_events SET content = ?, tool_args_json = ?, tool_result_json = ?
       WHERE id = ? AND thread_id = ? AND user_uuid = ?`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        const role = String(event.role ?? "assistant");
        const eventType = String(event.event_type ?? "message");
        insertStmt.run(threadId, userUuid, role, eventType, event.tool_name ?? null, now);
        const id = Number(this.db.prepare("SELECT last_insert_rowid() AS id").get()?.id);
        const rowId = String(id);
        const content = event.content ?? null;
        const argsJson = event.tool_args_json === undefined || event.tool_args_json === null ? null : stableStringify(event.tool_args_json);
        const resultJson = event.tool_result_json === undefined || event.tool_result_json === null ? null : stableStringify(event.tool_result_json);
        updateStmt.run(
          this.encryptNullableValue(userUuid, "assistant_events", "content", rowId, content),
          this.encryptNullableValue(userUuid, "assistant_events", "tool_args_json", rowId, argsJson),
          this.encryptNullableValue(userUuid, "assistant_events", "tool_result_json", rowId, resultJson),
          id,
          threadId,
          userUuid
        );
        inserted.push({
          id,
          role,
          event_type: eventType,
          content,
          tool_name: event.tool_name ?? null,
          tool_args_json: event.tool_args_json ?? null,
          tool_result_json: event.tool_result_json ?? null,
          created_at: now
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.touchThread(userUuid, threadId);
    return inserted;
  }

  createPresetSnapshot(userUuid: string, threadId: string, presetId: string, snapshot: unknown, reason: string) {
    this.assertThread(userUuid, threadId);
    const snapshotJson = stableStringify(snapshot);
    const snapshotHash = this.keyedHash(userUuid, "assistant_preset_snapshot", snapshotJson);
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO assistant_preset_snapshots (id, user_uuid, thread_id, preset_id, snapshot_json, snapshot_hash, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userUuid,
      threadId,
      presetId,
      this.encryptValue(userUuid, "assistant_preset_snapshots", "snapshot_json", id, snapshotJson),
      snapshotHash,
      this.encryptValue(userUuid, "assistant_preset_snapshots", "reason", id, reason),
      nowIso()
    );
    return { snapshot_hash: snapshotHash };
  }

  createAudit(userUuid: string, threadId: string, audit: { action: string; target_type: string; target_id: string; before_hash?: string; after_hash?: string; metadata_json?: JsonObject }) {
    this.assertThread(userUuid, threadId);
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO assistant_audit_events (id, user_uuid, thread_id, action, target_type, target_id, before_hash, after_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userUuid,
      threadId,
      audit.action,
      audit.target_type,
      this.encryptValue(userUuid, "assistant_audit_events", "target_id", id, audit.target_id),
      audit.before_hash ?? null,
      audit.after_hash ?? null,
      this.encryptNullableValue(
        userUuid,
        "assistant_audit_events",
        "metadata_json",
        id,
        audit.metadata_json === undefined ? null : stableStringify(audit.metadata_json)
      ),
      nowIso()
    );
  }

  private getMemory(userUuid: string, threadId: string): AssistantMemory {
    const row = this.db.prepare(
      `SELECT summary, pinned_facts_json, summarized_through_event_id, updated_at FROM assistant_memory WHERE thread_id = ? AND user_uuid = ?`
    ).get(threadId, userUuid) as Record<string, unknown> | undefined;
    if (!row) return { summary: "", pinned_facts_json: {}, summarized_through_event_id: null, updated_at: null };
    const summary = this.decryptValue(userUuid, "assistant_memory", "summary", threadId, row.summary);
    const pinnedFacts = this.decryptValue(userUuid, "assistant_memory", "pinned_facts_json", threadId, row.pinned_facts_json);
    return {
      summary,
      pinned_facts_json: parseObject(pinnedFacts),
      summarized_through_event_id: typeof row.summarized_through_event_id === "number" ? row.summarized_through_event_id : null,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null
    };
  }

  private rowToThread(row: Record<string, unknown>, userUuid: string): AssistantThread {
    const id = String(row.id);
    return {
      id,
      title: this.decryptValue(userUuid, "assistant_threads", "title", id, row.title),
      archived: Boolean(row.archived),
      created_at: String(row.created_at),
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null
    };
  }

  private rowToEvent(row: Record<string, unknown>, userUuid: string, threadId: string): AssistantEvent {
    const id = Number(row.id);
    const rowId = String(id);
    const content = this.decryptNullableValue(userUuid, "assistant_events", "content", rowId, row.content);
    const toolArgs = this.decryptNullableValue(userUuid, "assistant_events", "tool_args_json", rowId, row.tool_args_json);
    const toolResult = this.decryptNullableValue(userUuid, "assistant_events", "tool_result_json", rowId, row.tool_result_json);
    return {
      id,
      role: String(row.role),
      event_type: String(row.event_type),
      content,
      tool_name: typeof row.tool_name === "string" ? row.tool_name : null,
      tool_args_json: parseNullableObject(toolArgs),
      tool_result_json: parseNullableObject(toolResult),
      created_at: String(row.created_at)
    };
  }

  private getUserKey(userUuid: string): Buffer {
    const cached = this.userKeyCache.get(userUuid);
    if (cached) {
      this.userKeyCache.delete(userUuid);
      this.userKeyCache.set(userUuid, cached);
      return cached;
    }
    const row = this.db.prepare(`SELECT wrapped_dek FROM assistant_user_keys WHERE user_uuid = ?`).get(userUuid) as
      | { wrapped_dek?: unknown }
      | undefined;
    let key: Buffer;
    if (typeof row?.wrapped_dek === "string") {
      key = this.crypto.unwrapUserKey(userUuid, row.wrapped_dek);
    } else {
      key = this.crypto.generateUserKey();
      this.db.prepare(
        `INSERT INTO assistant_user_keys (user_uuid, wrapped_dek, created_at, rotated_at) VALUES (?, ?, ?, NULL)`
      ).run(userUuid, this.crypto.wrapUserKey(userUuid, key), nowIso());
    }
    if (this.userKeyCache.size >= MAX_CACHED_USER_KEYS) {
      const oldestUser = this.userKeyCache.keys().next().value as string | undefined;
      if (oldestUser) {
        this.userKeyCache.get(oldestUser)?.fill(0);
        this.userKeyCache.delete(oldestUser);
      }
    }
    this.userKeyCache.set(userUuid, key);
    return key;
  }

  private keyedHash(userUuid: string, purpose: string, value: string): string {
    return createHmac("sha256", this.getUserKey(userUuid))
      .update("acx-assistant-hash-v1\0")
      .update(purpose)
      .update("\0")
      .update(value)
      .digest("hex");
  }

  private encryptValue(userUuid: string, table: string, column: string, rowId: string, value: string): string {
    return this.crypto.encrypt(this.getUserKey(userUuid), { userUuid, table, column, rowId }, value);
  }

  private encryptNullableValue(
    userUuid: string,
    table: string,
    column: string,
    rowId: string,
    value: string | null
  ): string | null {
    return value === null ? null : this.encryptValue(userUuid, table, column, rowId, value);
  }

  private decryptValue(userUuid: string, table: string, column: string, rowId: string, value: unknown): string {
    if (typeof value !== "string" || !this.crypto.isEncrypted(value)) {
      throw new Error(`Assistant encrypted field is missing or invalid: ${table}.${column}`);
    }
    return this.crypto.decrypt(this.getUserKey(userUuid), { userUuid, table, column, rowId }, value);
  }

  private decryptNullableValue(
    userUuid: string,
    table: string,
    column: string,
    rowId: string,
    value: unknown
  ): string | null {
    return value === null || value === undefined ? null : this.decryptValue(userUuid, table, column, rowId, value);
  }

  private backfillSensitiveData(): number {
    let migratedFieldCount = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      migratedFieldCount += this.backfillRows(
        "assistant_threads",
        ["id", "user_uuid", "title"],
        ["title"],
        (row) => String(row.id)
      );
      migratedFieldCount += this.backfillRows(
        "assistant_events",
        ["id", "user_uuid", "content", "tool_args_json", "tool_result_json"],
        ["content", "tool_args_json", "tool_result_json"],
        (row) => String(row.id)
      );
      migratedFieldCount += this.backfillRows(
        "assistant_memory",
        ["thread_id", "user_uuid", "summary", "pinned_facts_json"],
        ["summary", "pinned_facts_json"],
        (row) => String(row.thread_id)
      );
      migratedFieldCount += this.backfillRows(
        "assistant_audit_events",
        ["id", "user_uuid", "target_id", "metadata_json"],
        ["target_id", "metadata_json"],
        (row) => String(row.id)
      );
      migratedFieldCount += this.backfillRows(
        "assistant_preset_snapshots",
        ["id", "user_uuid", "snapshot_json", "reason"],
        ["snapshot_json", "reason"],
        (row) => String(row.id)
      );
      this.db.prepare(
        `INSERT INTO assistant_security_metadata (key, value, updated_at) VALUES ('data_encryption', 'v1', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(nowIso());
      this.db.exec("COMMIT");
      return migratedFieldCount;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillRows(
    table: string,
    selectedColumns: string[],
    encryptedColumns: string[],
    rowId: (row: Record<string, unknown>) => string
  ): number {
    let migratedFieldCount = 0;
    const rows = this.db.prepare(`SELECT ${selectedColumns.join(", ")} FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const userUuid = String(row.user_uuid);
      const id = rowId(row);
      for (const column of encryptedColumns) {
        const value = row[column];
        if (value === null || value === undefined || this.crypto.isEncrypted(value)) continue;
        if (typeof value !== "string") throw new Error(`Unexpected assistant field type: ${table}.${column}`);
        const encrypted = this.encryptValue(userUuid, table, column, id, value);
        const identityColumn = table === "assistant_memory" ? "thread_id" : "id";
        this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${identityColumn} = ? AND user_uuid = ?`).run(
          encrypted,
          id,
          userUuid
        );
        migratedFieldCount += 1;
      }
    }
    return migratedFieldCount;
  }

  private assertOwnershipIntegrity(): void {
    const childTables = ["assistant_events", "assistant_memory", "assistant_audit_events", "assistant_preset_snapshots"];
    for (const table of childTables) {
      const identityColumn = table === "assistant_memory" ? "thread_id" : "thread_id";
      const row = this.db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} child
         LEFT JOIN assistant_threads parent ON parent.id = child.${identityColumn} AND parent.user_uuid = child.user_uuid
         WHERE parent.id IS NULL`
      ).get() as { count?: number | bigint } | undefined;
      if (Number(row?.count ?? 0) !== 0) throw new Error(`Assistant ownership integrity failed for ${table}`);
    }
  }

  private assertDataKek(): void {
    const row = this.db.prepare(
      `SELECT value FROM assistant_security_metadata WHERE key = 'data_kek_check_v1'`
    ).get() as { value?: unknown } | undefined;
    if (typeof row?.value === "string") {
      if (!this.crypto.matchesKeyCheck(row.value)) {
        throw new Error("ACM2_ASSISTANT_DATA_KEK does not match this assistant database");
      }
      return;
    }

    const wrapped = this.db.prepare(
      `SELECT user_uuid, wrapped_dek FROM assistant_user_keys ORDER BY user_uuid LIMIT 1`
    ).get() as { user_uuid?: unknown; wrapped_dek?: unknown } | undefined;
    if (typeof wrapped?.user_uuid === "string" && typeof wrapped.wrapped_dek === "string") {
      const key = this.crypto.unwrapUserKey(wrapped.user_uuid, wrapped.wrapped_dek);
      key.fill(0);
    }
    this.db.prepare(
      `INSERT INTO assistant_security_metadata (key, value, updated_at) VALUES ('data_kek_check_v1', ?, ?)`
    ).run(this.crypto.keyCheck(), nowIso());
  }

  private hardenFilePermissions(): void {
    chmodSync(dirname(this.databasePath), 0o700);
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  private assertThread(userUuid: string, threadId: string) {
    this.getThread(userUuid, threadId);
  }

  private touchThread(userUuid: string, threadId: string) {
    this.db.prepare(`UPDATE assistant_threads SET updated_at = ? WHERE id = ? AND user_uuid = ?`).run(nowIso(), threadId, userUuid);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_usage_outbox (
        event_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('conversation', 'turn')),
        occurred_at TEXT NOT NULL,
        attempted_at TEXT,
        delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_usage_delivery ON assistant_usage_outbox(delivered, subject, occurred_at);
      CREATE TABLE IF NOT EXISTS assistant_threads (
        id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_threads_user ON assistant_threads(user_uuid, archived, updated_at);
      CREATE TABLE IF NOT EXISTS assistant_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        user_uuid TEXT NOT NULL,
        role TEXT NOT NULL,
        event_type TEXT NOT NULL,
        content TEXT,
        tool_name TEXT,
        tool_args_json TEXT,
        tool_result_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_events_thread ON assistant_events(thread_id, user_uuid, id);
      CREATE TABLE IF NOT EXISTS assistant_memory (
        thread_id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL,
        summary TEXT,
        pinned_facts_json TEXT NOT NULL DEFAULT '{}',
        summarized_through_event_id INTEGER,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_audit_events (
        id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_preset_snapshots (
        id TEXT PRIMARY KEY,
        user_uuid TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_threads_id_user ON assistant_threads(id, user_uuid);
      CREATE TABLE IF NOT EXISTS assistant_user_keys (
        user_uuid TEXT PRIMARY KEY,
        wrapped_dek TEXT NOT NULL,
        created_at TEXT NOT NULL,
        rotated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_security_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS trg_assistant_events_owner_insert
      BEFORE INSERT ON assistant_events
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS trg_assistant_events_owner_update
      BEFORE UPDATE OF thread_id, user_uuid ON assistant_events
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS trg_assistant_memory_owner_insert
      BEFORE INSERT ON assistant_memory
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS trg_assistant_memory_owner_update
      BEFORE UPDATE OF thread_id, user_uuid ON assistant_memory
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS trg_assistant_audit_owner_insert
      BEFORE INSERT ON assistant_audit_events
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS trg_assistant_audit_owner_update
      BEFORE UPDATE OF thread_id, user_uuid ON assistant_audit_events
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS trg_assistant_snapshot_owner_insert
      BEFORE INSERT ON assistant_preset_snapshots
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS trg_assistant_snapshot_owner_update
      BEFORE UPDATE OF thread_id, user_uuid ON assistant_preset_snapshots
      WHEN NOT EXISTS (
        SELECT 1 FROM assistant_threads WHERE id = NEW.thread_id AND user_uuid = NEW.user_uuid
      )
      BEGIN SELECT RAISE(ABORT, 'assistant thread ownership mismatch'); END;
    `);
  }
}

export class HttpLikeError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function parseNullableObject(value: unknown): JsonObject | null {
  if (typeof value !== "string" || !value) return null;
  return parseObject(value);
}

function parseObject(value: unknown): JsonObject {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown): string {
  return sha256(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
