export type AssistantDevTraceContext = {
  assistant_thread_id?: string | null
  assistant_run_id?: string | null
  assistant_trace_id?: string | null
  acm_run_id?: string | null
  acm_run_name?: string | null
  acm_run_title?: string | null
  route?: string | null
  page?: string | null
}

type AssistantDevLogEvent = {
  event: string
  phase?: string
  trace_context?: AssistantDevTraceContext
  payload?: unknown
  error?: unknown
}

const ASSISTANT_DEV_LOG_BATCH_DELAY_MS = 150
const ASSISTANT_DEV_LOG_MAX_BATCH_EVENTS = 12
const ASSISTANT_DEV_LOG_MAX_BATCH_CHARS = 250_000
const ASSISTANT_DEV_LOG_SENSITIVE_KEYS = new Set([
  'authorization',
  'xacm2assistanttoken',
  'xacm2sessiontoken',
  'xacm2pluginsecret',
  'xacm2apikey',
  'xwpnonce',
  'password',
  'passwd',
  'cookie',
  'setcookie',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'assistanttoken',
  'secret',
])

let logQueue: Promise<void> = Promise.resolve()
let pendingBodies: string[] = []
let pendingBodiesChars = 0
let flushTimer: number | null = null

export function createAssistantDevTraceId(prefix = 'assistant-trace'): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${uuid}`
}

export function normalizeAssistantDevError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const errorWithCause = error as Error & { cause?: unknown }
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: errorWithCause.cause,
    }
  }

  return { value: error }
}

export function logAssistantDevEvent(event: AssistantDevLogEvent): void {
  if (!isAssistantDevLoggingEnabled()) return

  let body: string
  try {
    body = stringifyAssistantDevPayload(buildAssistantDevLogPayload(event))
    if (body.length > ASSISTANT_DEV_LOG_MAX_BATCH_CHARS) {
      body = stringifyAssistantDevPayload(buildAssistantDevLogPayload({
        event: event.event,
        phase: event.phase,
        trace_context: event.trace_context,
        payload: {
          omitted_due_to_size: true,
          serialized_chars: body.length,
          max_chars: ASSISTANT_DEV_LOG_MAX_BATCH_CHARS,
        },
        error: event.error ? normalizeAssistantDevError(event.error) : null,
      }))
    }
  } catch (error) {
    body = JSON.stringify({
      client_sent_at: new Date().toISOString(),
      event: 'assistant_dev_log_serialization_error',
      phase: 'error',
      error: normalizeAssistantDevError(error),
      original_event: event.event,
      original_phase: event.phase ?? null,
      trace_context: event.trace_context ?? {},
    })
  }

  enqueueAssistantDevLogBody(body)
}

function isAssistantDevLoggingEnabled(): boolean {
  return Boolean(
    window.acm2Config?.assistantDevLogEnabled &&
      window.acm2Config?.assistantDevLogEndpoint &&
      window.acm2Config?.nonce,
  )
}

function buildAssistantDevLogPayload(event: AssistantDevLogEvent): Record<string, unknown> {
  return {
    client_sent_at: new Date().toISOString(),
    event: event.event,
    phase: event.phase ?? null,
    trace_context: event.trace_context ?? {},
    payload: event.payload ?? null,
    error: event.error ?? null,
    browser_context: {
      href: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      hash: window.location.hash,
      user_agent: window.navigator.userAgent,
      current_user: window.acm2Config?.currentUser ?? '',
      user_uuid: window.acm2Config?.userUuid ?? '',
    },
  }
}

async function postAssistantDevLog(body: string): Promise<void> {
  const endpoint = window.acm2Config?.assistantDevLogEndpoint
  const nonce = window.acm2Config?.nonce
  if (!endpoint || !nonce) return

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WP-Nonce': nonce,
    },
    body,
  })

  if (!response.ok) {
    throw new Error(`Assistant dev log write failed (${response.status})`)
  }
}

function enqueueAssistantDevLogBody(body: string): void {
  if (body.length >= ASSISTANT_DEV_LOG_MAX_BATCH_CHARS) {
    flushAssistantDevLogBatch()
    queueAssistantDevLogPost(body)
    return
  }

  pendingBodies.push(body)
  pendingBodiesChars += body.length

  if (
    pendingBodies.length >= ASSISTANT_DEV_LOG_MAX_BATCH_EVENTS ||
    pendingBodiesChars >= ASSISTANT_DEV_LOG_MAX_BATCH_CHARS
  ) {
    flushAssistantDevLogBatch()
    return
  }

  if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null
      flushAssistantDevLogBatch()
    }, ASSISTANT_DEV_LOG_BATCH_DELAY_MS)
  }
}

function flushAssistantDevLogBatch(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  if (pendingBodies.length === 0) return

  const bodies = pendingBodies
  pendingBodies = []
  pendingBodiesChars = 0

  if (bodies.length === 1) {
    queueAssistantDevLogPost(bodies[0])
    return
  }

  queueAssistantDevLogPost(`[${bodies.join(',')}]`)
}

function queueAssistantDevLogPost(body: string): void {
  logQueue = logQueue
    .catch(() => undefined)
    .then(() => postAssistantDevLog(body))
    .catch((error) => {
      if (import.meta.env.DEV) {
        console.warn('[assistant-dev-log] write failed', error)
      }
    })
}

function stringifyAssistantDevPayload(value: unknown): string {
  const seen = new WeakSet<object>()

  return JSON.stringify(value, (key, child) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normalizedKey && ASSISTANT_DEV_LOG_SENSITIVE_KEYS.has(normalizedKey)) {
      return '[redacted]'
    }

    if (typeof child === 'bigint') {
      return `${child.toString()}n`
    }

    if (typeof child === 'function') {
      return `[function ${child.name || 'anonymous'}]`
    }

    if (child instanceof Error) {
      return normalizeAssistantDevError(child)
    }

    if (child && typeof child === 'object') {
      if (seen.has(child)) {
        return '[circular]'
      }
      seen.add(child)
    }

    return child
  })
}
