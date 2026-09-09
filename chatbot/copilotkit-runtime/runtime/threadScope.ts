import { createHmac, timingSafeEqual } from "node:crypto";

const PUBLIC_THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPED_THREAD_RE = /^acxv1\.([A-Za-z0-9_-]{43})\.([0-9a-f-]{36})$/i;

export class ThreadScopeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ThreadScopeError";
  }
}

export function deriveScopedThreadId(scopeSecret: string, userSubject: string, publicThreadId: string): string {
  assertPublicThreadId(publicThreadId);
  const capability = createHmac("sha256", scopeSecret)
    .update("acx-assistant-thread-v1\0")
    .update(userSubject)
    .update("\0")
    .update(publicThreadId.toLowerCase())
    .digest("base64url");
  return `acxv1.${capability}.${publicThreadId.toLowerCase()}`;
}

export function canonicalizeThreadId(scopeSecret: string, userSubject: string, requestedThreadId: string): {
  publicThreadId: string;
  scopedThreadId: string;
} {
  const requested = String(requestedThreadId ?? "").trim();
  const scopedMatch = SCOPED_THREAD_RE.exec(requested);
  const publicThreadId = scopedMatch ? scopedMatch[2].toLowerCase() : requested.toLowerCase();
  assertPublicThreadId(publicThreadId);
  const scopedThreadId = deriveScopedThreadId(scopeSecret, userSubject, publicThreadId);
  if (scopedMatch && !safeEqual(requested, scopedThreadId)) {
    throw new ThreadScopeError(404, "Assistant thread not found");
  }
  return { publicThreadId, scopedThreadId };
}

export function scopeSingleRouteEnvelope(
  envelope: unknown,
  scopeSecret: string,
  userSubject: string,
  assertOwned: (publicThreadId: string) => void,
  onScoped?: (mapping: { publicThreadId: string; scopedThreadId: string }) => void
): unknown {
  if (!isRecord(envelope) || typeof envelope.method !== "string") {
    throw new ThreadScopeError(400, "Invalid Copilot request envelope");
  }
  if (["info", "inspector/metadata", "transcribe"].includes(envelope.method)) return envelope;
  if (!["agent/run", "agent/suggest", "agent/connect", "agent/stop"].includes(envelope.method)) return envelope;

  if (envelope.method === "agent/stop") {
    if (!isRecord(envelope.params) || typeof envelope.params.threadId !== "string") {
      throw new ThreadScopeError(400, "Missing assistant thread id");
    }
    const canonical = canonicalizeThreadId(scopeSecret, userSubject, envelope.params.threadId);
    assertOwned(canonical.publicThreadId);
    onScoped?.(canonical);
    return { ...envelope, params: { ...envelope.params, threadId: canonical.scopedThreadId } };
  }

  const parsedBody = parseEnvelopeBody(envelope.body);
  if (typeof parsedBody.threadId !== "string") throw new ThreadScopeError(400, "Missing assistant thread id");
  const canonical = canonicalizeThreadId(scopeSecret, userSubject, parsedBody.threadId);
  assertOwned(canonical.publicThreadId);
  onScoped?.(canonical);
  const scopedBody = { ...parsedBody, threadId: canonical.scopedThreadId };
  return { ...envelope, body: typeof envelope.body === "string" ? JSON.stringify(scopedBody) : scopedBody };
}

function parseEnvelopeBody(body: unknown): Record<string, unknown> {
  if (isRecord(body)) return body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to the uniform request error.
    }
  }
  throw new ThreadScopeError(400, "Invalid Copilot request body");
}

function assertPublicThreadId(threadId: string): void {
  if (!PUBLIC_THREAD_RE.test(threadId)) throw new ThreadScopeError(404, "Assistant thread not found");
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
