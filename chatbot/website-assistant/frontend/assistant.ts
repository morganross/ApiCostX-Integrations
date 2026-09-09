import { isAssistantDemoMode } from '@/components/assistant/assistantAvailability'
import {
  createAssistantDevTraceId,
  logAssistantDevEvent,
  normalizeAssistantDevError,
  type AssistantDevTraceContext,
} from './assistantDevLogger'
import { getAssistantDemoThreadContext, listAssistantDemoThreads } from './assistantDemoData'
import { getBasicAssistantEndpoint } from '@/components/assistant/assistantConfig'

export interface AssistantThread {
  id: string
  title: string
  archived: boolean
  created_at: string
  updated_at?: string | null
}

export interface AssistantEvent {
  id: number
  role: string
  event_type: string
  content?: string | null
  tool_name?: string | null
  tool_args_json?: Record<string, unknown> | null
  tool_result_json?: Record<string, unknown> | null
  created_at: string
}

export interface AssistantMemory {
  summary?: string | null
  pinned_facts_json: Record<string, unknown>
  summarized_through_event_id?: number | null
  updated_at?: string | null
}

export interface AssistantThreadContext {
  thread: AssistantThread
  memory: AssistantMemory
  recent_events: AssistantEvent[]
  last_summarized_event_id?: number | null
}

const runtimeBaseUrl = () => {
  const basicEndpoint = getBasicAssistantEndpoint()
  const configured = basicEndpoint?.runtimeBaseUrl || (window.acm2Config as any)?.copilotRuntimeBaseUrl
  if (configured) return configured.replace(/\/+$/, '')
  const runtimeUrl = basicEndpoint?.runtimeUrl || (window.acm2Config as any)?.copilotRuntimeUrl
  if (runtimeUrl) return runtimeUrl.replace(/\/api\/copilotkit\/?$/, '').replace(/\/+$/, '')
  return ''
}

async function assistantRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = runtimeBaseUrl()
  const assistantToken = getBasicAssistantEndpoint()?.assistantToken || window.acm2Config?.copilotAssistantToken
  const requestId = createAssistantDevTraceId('assistant-runtime-request')
  const traceContext = getAssistantRuntimeTraceContext(path, requestId)
  if (!base || !assistantToken) {
    const error = new Error('Assistant runtime is not configured')
    logAssistantDevEvent({
      event: 'assistant_runtime_request',
      phase: 'configuration_error',
      trace_context: traceContext,
      payload: { request_id: requestId, path, base_configured: Boolean(base), assistant_token_configured: Boolean(assistantToken) },
      error: normalizeAssistantDevError(error),
    })
    throw error
  }

  const url = `${base}${path}`
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('X-ACM2-Assistant-Token', assistantToken)

  logAssistantDevEvent({
    event: 'assistant_runtime_request',
    phase: 'request',
    trace_context: traceContext,
    payload: {
      request_id: requestId,
      url,
      path,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body: parseAssistantRequestBody(init.body),
    },
  })

  try {
    const response = await fetch(url, {
      ...init,
      headers,
    })
    const data = await response.json().catch(() => null)
    logAssistantDevEvent({
      event: 'assistant_runtime_request',
      phase: 'response',
      trace_context: traceContext,
      payload: {
        request_id: requestId,
        url,
        path,
        method: init.method ?? 'GET',
        ok: response.ok,
        status: response.status,
        status_text: response.statusText,
        response: data,
      },
    })
    if (!response.ok) {
      const message =
        typeof data?.error === 'string'
          ? data.error
          : typeof data?.detail === 'string'
            ? data.detail
            : `Assistant request failed (${response.status})`
      throw new Error(message)
    }
    return data as T
  } catch (error) {
    logAssistantDevEvent({
      event: 'assistant_runtime_request',
      phase: 'error',
      trace_context: traceContext,
      payload: { request_id: requestId, url, path, method: init.method ?? 'GET' },
      error: normalizeAssistantDevError(error),
    })
    throw error
  }
}

async function assistantAudioRequest<T>(path: string, audio: Blob): Promise<T> {
  const base = runtimeBaseUrl()
  const assistantToken = getBasicAssistantEndpoint()?.assistantToken || window.acm2Config?.copilotAssistantToken
  const requestId = createAssistantDevTraceId('assistant-runtime-audio-request')
  const traceContext = getAssistantRuntimeTraceContext(path, requestId)
  if (!base || !assistantToken) {
    const error = new Error('Assistant runtime is not configured')
    logAssistantDevEvent({
      event: 'assistant_runtime_audio_request',
      phase: 'configuration_error',
      trace_context: traceContext,
      payload: { request_id: requestId, path, base_configured: Boolean(base), assistant_token_configured: Boolean(assistantToken) },
      error: normalizeAssistantDevError(error),
    })
    throw error
  }

  const url = `${base}${path}`
  const headers = new Headers()
  headers.set('X-ACM2-Assistant-Token', assistantToken)
  headers.set('Content-Type', audio.type || 'audio/webm')

  logAssistantDevEvent({
    event: 'assistant_runtime_audio_request',
    phase: 'request',
    trace_context: traceContext,
    payload: {
      request_id: requestId,
      url,
      path,
      method: 'POST',
      audio_type: audio.type || 'audio/webm',
      audio_size: audio.size,
    },
  })

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: audio,
    })
    const data = await response.json().catch(() => null)
    logAssistantDevEvent({
      event: 'assistant_runtime_audio_request',
      phase: 'response',
      trace_context: traceContext,
      payload: {
        request_id: requestId,
        url,
        path,
        ok: response.ok,
        status: response.status,
        status_text: response.statusText,
        response: data,
      },
    })
    if (!response.ok) {
      const message =
        typeof data?.error === 'string'
          ? data.error
          : typeof data?.detail === 'string'
            ? data.detail
            : `Assistant audio request failed (${response.status})`
      throw new Error(message)
    }
    return data as T
  } catch (error) {
    logAssistantDevEvent({
      event: 'assistant_runtime_audio_request',
      phase: 'error',
      trace_context: traceContext,
      payload: { request_id: requestId, url, path, method: 'POST', audio_size: audio.size },
      error: normalizeAssistantDevError(error),
    })
    throw error
  }
}

function getAssistantRuntimeTraceContext(path: string, requestId: string): AssistantDevTraceContext {
  const threadMatch = path.match(/\/api\/assistant\/threads\/([^/?]+)/)
  return {
    assistant_thread_id: threadMatch?.[1] ?? null,
    assistant_trace_id: requestId,
  }
}

function parseAssistantRequestBody(body?: BodyInit | null): unknown {
  if (body == null) return null
  if (typeof body === 'string') {
    try {
      return { raw: body, json: JSON.parse(body) }
    } catch {
      return { raw: body }
    }
  }

  return {
    body_type: Object.prototype.toString.call(body),
  }
}

function assistantDemoWriteForbidden(): never {
  throw new Error('Sign in to use the ACM assistant')
}

export const assistantApi = {
  async listThreads(includeArchived = false): Promise<AssistantThread[]> {
    if (isAssistantDemoMode()) {
      return listAssistantDemoThreads(includeArchived)
    }
    const params = new URLSearchParams({ include_archived: includeArchived ? 'true' : 'false' })
    const response = await assistantRequest<{ threads: AssistantThread[] }>(`/api/assistant/threads?${params}`)
    return response.threads
  },

  async createThread(title: string): Promise<AssistantThread> {
    if (isAssistantDemoMode()) {
      assistantDemoWriteForbidden()
    }
    return assistantRequest<AssistantThread>('/api/assistant/threads', {
      method: 'POST',
      body: JSON.stringify({ title }),
    })
  },

  async updateThread(threadId: string, data: { title?: string; archived?: boolean }): Promise<AssistantThread> {
    if (isAssistantDemoMode()) {
      assistantDemoWriteForbidden()
    }
    return assistantRequest<AssistantThread>(`/api/assistant/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  async getThreadContext(threadId: string, limit = 40): Promise<AssistantThreadContext> {
    if (isAssistantDemoMode()) {
      return getAssistantDemoThreadContext(threadId, limit)
    }
    const params = new URLSearchParams({ limit: String(limit) })
    return assistantRequest<AssistantThreadContext>(`/api/assistant/threads/${threadId}/context?${params}`)
  },

  async addEvents(
    threadId: string,
    events: Array<{
      role: string
      event_type: string
      content?: string | null
      tool_name?: string | null
      tool_args_json?: Record<string, unknown> | null
      tool_result_json?: Record<string, unknown> | null
    }>,
  ): Promise<AssistantEvent[]> {
    if (isAssistantDemoMode()) {
      assistantDemoWriteForbidden()
    }
    const response = await assistantRequest<{ events: AssistantEvent[] }>(`/api/assistant/threads/${threadId}/events`, {
      method: 'POST',
      body: JSON.stringify({ events }),
    })
    return response.events
  },

  async transcribeAudio(audio: Blob): Promise<{ text: string; model?: string }> {
    if (isAssistantDemoMode()) {
      assistantDemoWriteForbidden()
    }
    const response = await assistantAudioRequest<{ text: string; model?: string }>('/api/copilotkit/transcribe', audio)
    return response
  },
}
