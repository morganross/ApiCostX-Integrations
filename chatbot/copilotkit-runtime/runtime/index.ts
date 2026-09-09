import cors from "cors";
import express from "express";
import { BuiltInAgent, CopilotRuntime, defineTool, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { HttpAgent } from "@ag-ui/client";
import { z } from "zod";
import { verifyAssistantToken } from "./auth.js";
import { loadRuntimeConfig } from "./config.js";
import { readProviderKey } from "./secrets.js";
import { getRequestContext, runWithRequestContext, type RequestContext } from "./requestContext.js";
import { ACM_ASSISTANT_PROMPT } from "./systemPrompt.js";
import { AssistantStore, HttpLikeError } from "./store.js";
import { runAssistantWebSearch, WebSearchError } from "./webSearch.js";
import { transcribeAssistantAudio, TranscriptionError } from "./transcription.js";
import { isExpectedLangGraphTransportTermination, summarizeUnhandledReason } from "./transportErrors.js";
import { scopeSingleRouteEnvelope, ThreadScopeError } from "./threadScope.js";
import { ThreadIdStreamRedactor } from "./responseThreadMapping.js";
import { createUsageReporter, submittedTurnId } from "./usage.js";

process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";

const config = loadRuntimeConfig();

process.on("unhandledRejection", (reason) => {
  if (config.agentBackend === "langgraph" && isExpectedLangGraphTransportTermination(reason, config.langGraphDeploymentUrl)) {
    console.warn("LangGraph transport disconnected before stream completion; the request failed without stopping the runtime.");
    return;
  }

  console.error("Unhandled runtime rejection", summarizeUnhandledReason(reason));
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});

const dataKek = readProviderKey(config.dataKekPath, "ACM2_ASSISTANT_DATA_KEK");
const threadScopeSecret = readProviderKey(config.providerKeysPath, "ACM2_ASSISTANT_THREAD_SCOPE_SECRET");
if (!dataKek) throw new Error("ACM2_ASSISTANT_DATA_KEK is not configured");
if (!threadScopeSecret) throw new Error("ACM2_ASSISTANT_THREAD_SCOPE_SECRET is not configured");
if (Buffer.byteLength(threadScopeSecret, "utf8") < 32) {
  throw new Error("ACM2_ASSISTANT_THREAD_SCOPE_SECRET must contain at least 32 bytes of entropy");
}
const store = new AssistantStore(config.databasePath, dataKek);
const usageSecret = readProviderKey(config.providerKeysPath, "ACM2_COPILOT_ASSISTANT_SECRET");
if (!usageSecret || !config.usageCallbackUrl) throw new Error("Assistant usage relay is not configured");
if (!config.allowedOrigins.includes(new URL(config.usageCallbackUrl).origin)) throw new Error("Usage relay origin is not allowed");
const reportUsage = createUsageReporter(store, config.usageCallbackUrl, usageSecret);
const flushUsage = () => { void reportUsage().catch(() => console.error("Assistant usage flush failed; will retry")); };
setInterval(flushUsage, 15_000).unref();
flushUsage();
const internetSearchTool = defineTool({
  name: "internet_search",
  description: "Search the public internet for current or external facts. Do not use for private ACM account data, presets, runs, logs, outputs, or secrets.",
  parameters: z.object({
    query: z.string().min(1).max(500).describe("Public-web search query. Do not include secrets, tokens, or private ACM data."),
    max_results: z.number().int().min(1).max(5).default(5).describe("Maximum source URLs to return.")
  }),
  execute: async (args) => runAssistantWebSearch(config, args)
});
const defaultAgent = config.agentBackend === "langgraph"
  ? new HttpAgent({ url: config.langGraphDeploymentUrl })
  : new BuiltInAgent({
      model: config.model,
      maxSteps: config.maxSteps,
      maxRetries: config.modelMaxRetries,
      prompt: ACM_ASSISTANT_PROMPT,
      tools: [internetSearchTool]
    });

const runtime = new CopilotRuntime({
  identifyUser: (request: Request) => {
    const assistantToken = request.headers.get("X-ACM2-Assistant-Token");
    if (!assistantToken) throw new Error("Missing X-ACM2-Assistant-Token");
    const subject = verifyAssistantToken(config.providerKeysPath, assistantToken);
    return { id: subject.sub, name: "ACM user" };
  },
  runner: new InMemoryAgentRunner(),
  forwardHeaders: {
    deny: ["x-acm2-assistant-token"]
  },
  agents: {
    default: defaultAgent
  }
});

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const origin = req.header("Origin");
  if (origin && !config.allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Origin is not allowed" });
  }
  next();
});
app.use(cors({
  origin: config.allowedOrigins,
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-ACM2-Assistant-Token"]
}));

app.use("/api/copilotkit", (req, res, next) => {
  if (req.method !== "POST") return next();
  const startedAt = Date.now();
  let responseBytes = 0;
  const countChunk = (chunk: unknown) => {
    if (chunk === undefined || chunk === null) return;
    responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
  };
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = ((chunk: unknown, ...args: unknown[]) => {
    countChunk(chunk);
    return originalWrite(chunk as never, ...(args as never[]));
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...args: unknown[]) => {
    countChunk(chunk);
    return originalEnd(chunk as never, ...(args as never[]));
  }) as typeof res.end;
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.info("assistant_stream_complete", {
      path: req.path,
      status: res.statusCode,
      duration_ms: durationMs,
      response_bytes: responseBytes
    });
  });
  next();
});

app.get("/health", async (_req, res) => {
  const openAiKeyPresent = Boolean(readProviderKey(config.providerKeysPath, "OPENAI_API_KEY"));
  const assistantSecretPresent = Boolean(readProviderKey(config.providerKeysPath, "ACM2_COPILOT_ASSISTANT_SECRET"));
  const webSearchReady = config.webSearchEnabled && openAiKeyPresent;
  const transcriptionReady = config.transcriptionEnabled && openAiKeyPresent;
  res.json({
    status: openAiKeyPresent && assistantSecretPresent ? "healthy" : "degraded",
    service: "acm-copilot-runtime",
    backend_reachable: false,
    backend_access_enabled: false,
    runtime_config_present: true,
    assistant_data_encryption_ready: true,
    assistant_data_kek_source: "oci_vault_runtime_file",
    assistant_thread_scoping_ready: true,
    usage_tracking_enabled: true,
    usage_pending_events: store.pendingUsageCount(),
    openai_key_present: openAiKeyPresent,
    assistant_secret_present: assistantSecretPresent,
    model: config.model,
    reasoning_effort: config.reasoningEffort,
    agent_backend: config.agentBackend,
    langgraph_ready: config.agentBackend === "langgraph",
    langgraph_deployment_url: config.agentBackend === "langgraph" ? config.langGraphDeploymentUrl : null,
    langgraph_graph_id: config.agentBackend === "langgraph" ? config.langGraphGraphId : null,
    max_steps: config.maxSteps,
    thread_identity: "verified_user_plus_browser_conversation",
    allowed_origins: config.allowedOrigins,
    web_search_enabled: config.webSearchEnabled,
    web_search_ready: webSearchReady,
    web_search_provider: "openai_web_search",
    web_search_model: config.webSearchModel,
    web_search_reasoning_effort: config.webSearchReasoningEffort,
    transcription_enabled: config.transcriptionEnabled,
    transcription_ready: transcriptionReady,
    transcription_provider: "openai_audio_transcription",
    transcription_model: config.transcriptionModel,
    transcription_max_audio_bytes: config.transcriptionMaxAudioBytes
  });
});

app.use(["/api/copilotkit", "/api/assistant"], async (req, res, next) => {
  const assistantToken = req.header("X-ACM2-Assistant-Token");
  if (!assistantToken) return res.status(401).json({ error: "Missing X-ACM2-Assistant-Token" });
  if (req.path.startsWith("/copilotkit") || req.originalUrl.startsWith("/api/copilotkit")) {
    const openAiKey = readProviderKey(config.providerKeysPath, "OPENAI_API_KEY");
    if (!openAiKey) return res.status(503).json({ error: "Assistant model key is not configured" });
    process.env.OPENAI_API_KEY = openAiKey;
  }
  try {
    const subject = verifyAssistantToken(config.providerKeysPath, assistantToken);
    runWithRequestContext({ assistantToken, user: { uuid: subject.sub, token_expires_at: subject.exp } }, () => next());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Assistant authentication failed";
    res.status(401).json({ error: message });
  }
});

app.use("/api/copilotkit", (req, res, next) => {
  if (req.path === "/transcribe" || req.originalUrl.includes("/api/copilotkit/transcribe")) return next();
  if (req.method !== "POST") return next();
  try {
    const context = getRequestContext();
    let mapping: { publicThreadId: string; scopedThreadId: string } | undefined;
    req.body = scopeSingleRouteEnvelope(
      req.body,
      threadScopeSecret,
      context.user.uuid,
      (publicThreadId) => { store.getThread(context.user.uuid, publicThreadId); },
      (value) => { mapping = value; }
    );
    if (mapping) installPublicThreadIdResponseMapping(res, mapping);
    const turnId = submittedTurnId(req.body, usageSecret);
    if (mapping && turnId) {
      store.enqueueUsage(context.user.uuid, "turn", mapping.publicThreadId, turnId);
      flushUsage();
    }
    next();
  } catch (error) {
    if (error instanceof ThreadScopeError || error instanceof HttpLikeError) {
      return res.status(error.status).json({ error: error.message });
    }
    next(error);
  }
});

app.get("/api/assistant/threads", withContext((context, req, res) => {
  const includeArchived = String(req.query.include_archived ?? "false") === "true";
  res.json({ threads: store.listThreads(context.user.uuid, includeArchived) });
}));

app.post("/api/assistant/threads", withContext((context, req, res) => {
  const title = typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 200) : "New ACM assistant thread";
  const thread = store.createThread(context.user.uuid, title);
  flushUsage();
  res.json(thread);
}));

app.patch("/api/assistant/threads/:threadId", withContext((context, req, res) => {
  const patch: { title?: string; archived?: boolean } = {};
  if (typeof req.body?.title === "string") patch.title = req.body.title.trim().slice(0, 200) || "ACM assistant thread";
  if (typeof req.body?.archived === "boolean") patch.archived = req.body.archived;
  res.json(store.updateThread(context.user.uuid, req.params.threadId, patch));
}));

app.get("/api/assistant/threads/:threadId/context", withContext((context, req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 40);
  res.json(store.getContext(context.user.uuid, req.params.threadId, limit));
}));

app.post("/api/assistant/threads/:threadId/events", withContext((context, req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
  res.json({ events: store.addEvents(context.user.uuid, req.params.threadId, events) });
}));

app.post("/api/assistant/search", withContext(async (_context, req, res) => {
  res.json(await runAssistantWebSearch(config, req.body));
}));

app.post(
  "/api/copilotkit/transcribe",
  express.raw({
    type: ["audio/*", "application/octet-stream"],
    limit: config.transcriptionMaxAudioBytes
  }),
  withContext(async (_context, req, res) => {
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mimeType = req.header("Content-Type") || "audio/webm";
    res.json(await transcribeAssistantAudio({ config, audio, mimeType }));
  })
);

app.use(createCopilotExpressHandler({ runtime, basePath: "/api/copilotkit", mode: "single-route", cors: false }));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpLikeError) return res.status(error.status).json({ error: error.message });
  if (error instanceof ThreadScopeError) return res.status(error.status).json({ error: error.message });
  if (error instanceof WebSearchError) return res.status(error.status).json({ error: error.message });
  if (error instanceof TranscriptionError) return res.status(error.status).json({ error: error.message });
  const message = error instanceof Error ? error.message : "Assistant runtime error";
  res.status(500).json({ error: message });
});

app.listen(config.port, config.bindHost, () => {
  console.log(`ACM Copilot Runtime listening on ${config.bindHost}:${config.port}`);
});

function withContext(handler: (context: RequestContext, req: express.Request, res: express.Response) => void | Promise<void>) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const context = getContextForRoute();
      await handler(context, req, res);
    } catch (error) {
      next(error);
    }
  };
}

function getContextForRoute(): RequestContext {
  return getRequestContext();
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function installPublicThreadIdResponseMapping(
  res: express.Response,
  mapping: { publicThreadId: string; scopedThreadId: string }
): void {
  const response = res as express.Response & {
    write: (...args: any[]) => boolean;
    end: (...args: any[]) => express.Response;
  };
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  const redactor = new ThreadIdStreamRedactor(mapping.scopedThreadId, mapping.publicThreadId);

  response.write = ((chunk: string | Buffer | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    const done = typeof encoding === "function" ? encoding : callback;
    const output = redactor.push(chunk);
    if (!output) {
      if (done) queueMicrotask(done);
      return true;
    }
    return originalWrite(output, typeof encoding === "string" ? encoding : undefined, done);
  }) as typeof response.write;

  response.end = ((chunk?: string | Buffer | Uint8Array | (() => void), encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    const finalChunk = typeof chunk === "function" ? undefined : chunk;
    const done = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback;
    const output = redactor.finish(finalChunk);
    return originalEnd(output || undefined, typeof encoding === "string" ? encoding : undefined, done);
  }) as typeof response.end;
}
