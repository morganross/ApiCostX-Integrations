import { createHmac, timingSafeEqual } from "node:crypto";
import { readProviderKey } from "./secrets.js";

export interface AssistantTokenSubject {
  sub: string;
  exp: number;
  iat?: number;
}

export function verifyAssistantToken(providerKeysPath: string, token: string): AssistantTokenSubject {
  const secret = readProviderKey(providerKeysPath, "ACM2_COPILOT_ASSISTANT_SECRET");
  if (!secret) throw new Error("Assistant auth secret is not configured");

  const [body, signature] = token.split(".");
  if (!body || !signature) throw new Error("Invalid assistant token");

  const expected = base64url(createHmac("sha256", secret).update(body).digest());
  if (!safeEqual(signature, expected)) throw new Error("Invalid assistant token signature");

  const payload = JSON.parse(Buffer.from(fromBase64url(body), "base64").toString("utf8")) as Partial<AssistantTokenSubject>;
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("Invalid assistant token subject");
  if (!payload.exp || typeof payload.exp !== "number") throw new Error("Invalid assistant token expiry");
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Assistant token expired");

  return { sub: payload.sub, exp: payload.exp, iat: typeof payload.iat === "number" ? payload.iat : undefined };
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
