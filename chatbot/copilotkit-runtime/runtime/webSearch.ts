import type { RuntimeConfig } from "./config.js";
import { readProviderKey } from "./secrets.js";

type UnknownRecord = Record<string, unknown>;

export type AssistantWebSearchSource = {
  title: string | null;
  url: string;
  snippet: string | null;
};

export type AssistantWebSearchResult = {
  status: "ok";
  provider: "openai_web_search";
  model: string;
  reasoning_effort: string;
  query: string;
  answer: string;
  sources: AssistantWebSearchSource[];
  searched_at: string;
  notes: string[];
};

export class WebSearchError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WebSearchError";
    this.status = status;
  }
}

export async function runAssistantWebSearch(config: RuntimeConfig, input: unknown): Promise<AssistantWebSearchResult> {
  if (!config.webSearchEnabled) {
    throw new WebSearchError(503, "Assistant internet search is disabled.");
  }

  const args = isRecord(input) ? input : {};
  const query = normalizeQuery(args.query);
  if (!query) throw new WebSearchError(400, "Search query is required.");

  const maxResults = clampInt(args.max_results ?? args.maxResults, 1, config.webSearchMaxResults, config.webSearchMaxResults);
  const openAiKey = readProviderKey(config.providerKeysPath, "OPENAI_API_KEY");
  if (!openAiKey) {
    throw new WebSearchError(503, "Assistant internet search is not configured because OPENAI_API_KEY is missing.");
  }

  const model = normalizeOpenAIModelName(config.webSearchModel || config.model);
  const response = await callOpenAIWebSearch({
    apiKey: openAiKey,
    model,
    reasoningEffort: config.webSearchReasoningEffort,
    query,
    maxResults,
    timeoutMs: config.webSearchTimeoutMs
  });

  const answer = truncateText(extractOutputText(response), config.webSearchMaxResponseChars);
  const sources = collectSources(response).slice(0, maxResults);

  if (!answer) {
    throw new WebSearchError(502, "The web search provider returned no answer text.");
  }

  return {
    status: "ok",
    provider: "openai_web_search",
    model,
    reasoning_effort: config.webSearchReasoningEffort,
    query,
    answer,
    sources,
    searched_at: new Date().toISOString(),
    notes: [
      "Use these results only for public web information.",
      "For ACM account data, presets, runs, logs, and outputs, use ACM page tools instead.",
      "When answering from these results, cite the returned source URLs."
    ]
  };
}

async function callOpenAIWebSearch({
  apiKey,
  model,
  reasoningEffort,
  query,
  maxResults,
  timeoutMs
}: {
  apiKey: string;
  model: string;
  reasoningEffort: string;
  query: string;
  maxResults: number;
  timeoutMs: number;
}): Promise<UnknownRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        store: false,
        tools: [{ type: "web_search", external_web_access: true }],
        include: ["web_search_call.action.sources"],
        max_output_tokens: 1_000,
        input: [
          {
            role: "system",
            content: "Use web search for the user's public-web query. Return a concise answer and prefer current, source-backed facts. Do not reveal hidden reasoning."
          },
          {
            role: "user",
            content: `Search the public web for this query and return up to ${maxResults} useful sources:\n\n${query}`
          }
        ]
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = getProviderErrorMessage(data) || `OpenAI web search failed (${response.status}).`;
      throw new WebSearchError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
    }
    return isRecord(data) ? data : {};
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WebSearchError(504, "Assistant internet search timed out.");
    }
    const message = error instanceof Error ? error.message : "Assistant internet search failed.";
    throw new WebSearchError(502, message);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeOpenAIModelName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "gpt-5.6-luna";
  const separatorIndex = trimmed.indexOf(":");
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1);
}

function extractOutputText(response: UnknownRecord): string {
  if (typeof response.output_text === "string") return response.output_text.trim();
  const chunks: string[] = [];
  for (const item of asArray(response.output)) {
    if (!isRecord(item)) continue;
    if (typeof item.content === "string") chunks.push(item.content);
    for (const content of asArray(item.content)) {
      if (!isRecord(content)) continue;
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n\n").trim();
}

function collectSources(response: UnknownRecord): AssistantWebSearchSource[] {
  const sources: AssistantWebSearchSource[] = [];
  const seen = new Set<string>();

  const pushSource = (candidate: unknown) => {
    if (!isRecord(candidate)) return;
    const url = stringValue(candidate.url) || stringValue(candidate.link);
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({
      url,
      title: stringValue(candidate.title),
      snippet: stringValue(candidate.snippet) || stringValue(candidate.content)
    });
  };

  for (const source of asArray(response.sources)) pushSource(source);

  for (const item of asArray(response.output)) {
    if (!isRecord(item)) continue;
    const action = isRecord(item.action) ? item.action : {};
    for (const source of asArray(action.sources)) pushSource(source);

    for (const content of asArray(item.content)) {
      if (!isRecord(content)) continue;
      for (const annotation of asArray(content.annotations)) {
        if (!isRecord(annotation)) continue;
        pushSource(annotation);
      }
    }
  }

  return sources;
}

function getProviderErrorMessage(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const error = data.error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof data.message === "string") return data.message;
  return null;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n[Search answer truncated by assistant runtime.]`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
