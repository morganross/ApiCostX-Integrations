import { existsSync, readFileSync } from "node:fs";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeConfig {
  usageCallbackUrl: string;
  agentBackend: "builtin" | "langgraph";
  langGraphDeploymentUrl: string;
  langGraphGraphId: string;
  bindHost: string;
  port: number;
  allowedOrigins: string[];
  providerKeysPath: string;
  dataKekPath: string;
  databasePath: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  maxSteps: number;
  modelMaxRetries: number;
  webSearchEnabled: boolean;
  webSearchModel: string;
  webSearchReasoningEffort: ReasoningEffort;
  webSearchMaxResults: number;
  webSearchTimeoutMs: number;
  webSearchMaxResponseChars: number;
  transcriptionEnabled: boolean;
  transcriptionModel: string;
  transcriptionMaxAudioBytes: number;
  transcriptionTimeoutMs: number;
}

const DEFAULT_CONFIG_PATH = "/run/acm-copilot/runtime.json";

const DEFAULT_CONFIG: RuntimeConfig = {
  usageCallbackUrl: "",
  agentBackend: "builtin",
  langGraphDeploymentUrl: "http://127.0.0.1:8123",
  langGraphGraphId: "allie",
  bindHost: "127.0.0.1",
  port: 4000,
  allowedOrigins: ["https://apicostx.com", "https://www.apicostx.com", "https://dev.apicostx.com"],
  providerKeysPath: "/run/acm-copilot/provider-keys.env",
  dataKekPath: "/run/acm-copilot/assistant-data-kek.env",
  databasePath: "/opt/acm-copilot/data/assistant.sqlite",
  model: "openai:gpt-5.6-luna",
  reasoningEffort: "medium",
  maxSteps: 12,
  modelMaxRetries: 2,
  webSearchEnabled: true,
  webSearchModel: "gpt-5.6-luna",
  webSearchReasoningEffort: "medium",
  webSearchMaxResults: 5,
  webSearchTimeoutMs: 20_000,
  webSearchMaxResponseChars: 6_000,
  transcriptionEnabled: true,
  transcriptionModel: "gpt-4o-mini-transcribe",
  transcriptionMaxAudioBytes: 12 * 1024 * 1024,
  transcriptionTimeoutMs: 45_000
};

export function loadRuntimeConfig(path = DEFAULT_CONFIG_PATH): RuntimeConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    agentBackend: raw.agentBackend === "langgraph" ? "langgraph" : "builtin",
    langGraphDeploymentUrl: String(raw.langGraphDeploymentUrl ?? DEFAULT_CONFIG.langGraphDeploymentUrl),
    langGraphGraphId: String(raw.langGraphGraphId ?? DEFAULT_CONFIG.langGraphGraphId),
    port: Number(raw.port ?? DEFAULT_CONFIG.port),
    allowedOrigins: normalizeOrigins(raw.allowedOrigins, DEFAULT_CONFIG.allowedOrigins),
    reasoningEffort: normalizeReasoningEffort(raw.reasoningEffort, DEFAULT_CONFIG.reasoningEffort),
    maxSteps: Number(raw.maxSteps ?? DEFAULT_CONFIG.maxSteps),
    modelMaxRetries: Number(raw.modelMaxRetries ?? DEFAULT_CONFIG.modelMaxRetries),
    webSearchEnabled: raw.webSearchEnabled ?? DEFAULT_CONFIG.webSearchEnabled,
    webSearchModel: String(raw.webSearchModel ?? DEFAULT_CONFIG.webSearchModel),
    webSearchReasoningEffort: normalizeReasoningEffort(raw.webSearchReasoningEffort, DEFAULT_CONFIG.webSearchReasoningEffort),
    webSearchMaxResults: clampNumber(raw.webSearchMaxResults, 1, 8, DEFAULT_CONFIG.webSearchMaxResults),
    webSearchTimeoutMs: clampNumber(raw.webSearchTimeoutMs, 5_000, 60_000, DEFAULT_CONFIG.webSearchTimeoutMs),
    webSearchMaxResponseChars: clampNumber(raw.webSearchMaxResponseChars, 1_000, 20_000, DEFAULT_CONFIG.webSearchMaxResponseChars),
    transcriptionEnabled: raw.transcriptionEnabled ?? DEFAULT_CONFIG.transcriptionEnabled,
    transcriptionModel: String(raw.transcriptionModel ?? DEFAULT_CONFIG.transcriptionModel),
    transcriptionMaxAudioBytes: clampNumber(raw.transcriptionMaxAudioBytes, 128_000, 25 * 1024 * 1024, DEFAULT_CONFIG.transcriptionMaxAudioBytes),
    transcriptionTimeoutMs: clampNumber(raw.transcriptionTimeoutMs, 5_000, 120_000, DEFAULT_CONFIG.transcriptionTimeoutMs)
  };
}

function normalizeOrigins(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const origins = [...new Set(value.map((item) => String(item).trim()).filter((item) => /^https:\/\/[^/]+$/i.test(item)))];
  return origins.length > 0 ? origins : [...fallback];
}

function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["none", "low", "medium", "high", "xhigh", "max"].includes(normalized)
    ? normalized as ReasoningEffort
    : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
