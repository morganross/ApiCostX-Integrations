import { createHmac } from "node:crypto";
import type { AssistantStore } from "./store.js";

export interface UsageTick { event_id: string; kind: "conversation" | "turn"; occurred_at: string; }

export function submittedTurnId(envelope: unknown, secret: string): string | null {
  const request = envelope as { method?: string; body?: unknown } | null;
  if (request?.method !== "agent/run") return null;
  let body: any = request.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || !Array.isArray(body.messages)) return null;
  const message = [...body.messages].reverse().find((item: any) => item?.role === "user");
  if (!message || typeof message.id !== "string" || !message.id || message.id.length > 512) return null;
  // Tool continuations carry the same user message. Count it once; include a
  // keyed content fingerprint so reusing an ID with changed text is distinct.
  // Neither text nor an unkeyed text digest is persisted in usage metadata.
  return createHmac("sha256", secret).update("assistant-turn\0")
    .update(message.id).update("\0").update(JSON.stringify(message.content ?? null)).digest("hex");
}

export function usageSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update("acm2-assistant-usage\n").update(body).digest("hex");
}

export function createUsageReporter(store: AssistantStore, url: string, secret: string,
                                    send: typeof fetch = fetch) {
  if (new URL(url).protocol !== "https:") throw new Error("Usage callback must use HTTPS");
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await Promise.all(store.pendingUsageBatches().map(async ({ subject, events }) => {
        store.markUsageAttempt(events.map(e => e.event_id));
        const body = JSON.stringify({ subject, sent_at: Math.floor(Date.now() / 1000), events });
        try {
          const response = await send(url, { method: "POST", redirect: "error",
            headers: { "Content-Type": "application/json", "X-ACM2-Usage-Signature": usageSignature(secret, body) },
            body, signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result = await response.json() as { acknowledged?: string[] };
          const expected = new Set(events.map(e => e.event_id));
          if (!Array.isArray(result.acknowledged) || result.acknowledged.some(id => !expected.has(id))) {
            throw new Error("Invalid usage acknowledgement");
          }
          store.acknowledgeUsage(result.acknowledged);
        } catch (error) {
          console.warn("Assistant usage delivery pending; will retry", error instanceof Error ? error.message : "unknown error");
        }
      }));
    } finally { busy = false; }
  };
}
