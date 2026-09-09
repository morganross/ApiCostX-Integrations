import { apiClient } from './client'
import { getAdvancedAssistantEndpoint } from '@/components/assistant/assistantConfig'

export interface AdvancedAssistantThread {
  id: string
  title: string
  archived: boolean
  created_at: string
  updated_at?: string | null
}

export interface AdvancedAssistantMessage {
  id: number
  thread_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  created_at: string
}

export interface AdvancedAssistantToolRequest {
  type: 'tool_request'
  tool_name: string
  arguments: Record<string, unknown>
  requires_confirmation: boolean
  request_id: string
}

export interface AdvancedAssistantThreadDetail {
  thread: AdvancedAssistantThread
  messages: AdvancedAssistantMessage[]
}

export interface AdvancedAssistantPostMessageResponse {
  thread: AdvancedAssistantThread
  user_message: AdvancedAssistantMessage
  assistant_message?: AdvancedAssistantMessage | null
  messages: AdvancedAssistantMessage[]
  tool_request?: AdvancedAssistantToolRequest | null
}

export interface AdvancedAssistantToolResultResponse {
  thread: AdvancedAssistantThread
  tool_message: AdvancedAssistantMessage
  assistant_message: AdvancedAssistantMessage
  messages: AdvancedAssistantMessage[]
  tool_request?: AdvancedAssistantToolRequest | null
}

export interface AdvancedAssistantCapabilities {
  mode: 'advanced'
  transport: 'backend_api'
  scaffolded: boolean
  streaming: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function threadListResponse(value: unknown): AdvancedAssistantThread[] {
  return isRecord(value) ? arrayValue<AdvancedAssistantThread>(value.threads) : []
}

function threadDetailResponse(value: unknown): AdvancedAssistantThreadDetail {
  const record = isRecord(value) ? value : {}
  return {
    thread: record.thread as AdvancedAssistantThread,
    messages: arrayValue<AdvancedAssistantMessage>(record.messages),
  }
}

function messageResponse<T extends { messages: AdvancedAssistantMessage[] }>(value: unknown): T {
  const record = isRecord(value) ? value : {}
  return {
    ...record,
    messages: arrayValue<AdvancedAssistantMessage>(record.messages),
  } as T
}

function advancedEndpointPrefix(): string {
  const configuredBaseUrl = getAdvancedAssistantEndpoint()?.baseUrl
  if (!configuredBaseUrl) {
    return '/assistant-advanced'
  }

  try {
    const configuredUrl = new URL(configuredBaseUrl, window.location.origin)
    const apiBaseUrl = new URL(window.acm2Config?.apiUrl || '/api', window.location.origin)
    if (
      configuredUrl.origin === apiBaseUrl.origin &&
      configuredUrl.pathname.startsWith(apiBaseUrl.pathname)
    ) {
      const relativePath = configuredUrl.pathname.slice(apiBaseUrl.pathname.length)
      return relativePath.startsWith('/') ? relativePath : `/${relativePath}`
    }
  } catch {
    // Fall through to the default relative API path.
  }

  return '/assistant-advanced'
}

export const assistantAdvancedApi = {
  async health(): Promise<{ ok: boolean }> {
    return apiClient.get<{ ok: boolean }>(`${advancedEndpointPrefix()}/health`)
  },

  async capabilities(): Promise<AdvancedAssistantCapabilities> {
    return apiClient.get<AdvancedAssistantCapabilities>(`${advancedEndpointPrefix()}/capabilities`)
  },

  async listThreads(includeArchived = false): Promise<AdvancedAssistantThread[]> {
    const response = await apiClient.get<unknown>(
      `${advancedEndpointPrefix()}/threads`,
      { include_archived: includeArchived },
    )
    return threadListResponse(response)
  },

  async createThread(title: string): Promise<AdvancedAssistantThread> {
    return apiClient.post<AdvancedAssistantThread>(`${advancedEndpointPrefix()}/threads`, { title })
  },

  async updateThread(
    threadId: string,
    data: { title?: string; archived?: boolean },
  ): Promise<AdvancedAssistantThread> {
    return apiClient.patch<AdvancedAssistantThread>(`${advancedEndpointPrefix()}/threads/${threadId}`, data)
  },

  async getThread(threadId: string, limit = 100): Promise<AdvancedAssistantThreadDetail> {
    const response = await apiClient.get<unknown>(`${advancedEndpointPrefix()}/threads/${threadId}`, { limit })
    return threadDetailResponse(response)
  },

  async postMessage(
    threadId: string,
    content: string,
    pageContext?: Record<string, unknown>,
  ): Promise<AdvancedAssistantPostMessageResponse> {
    const response = await apiClient.post<unknown>(`${advancedEndpointPrefix()}/threads/${threadId}/messages`, {
      content,
      page_context: pageContext,
    })
    return messageResponse<AdvancedAssistantPostMessageResponse>(response)
  },

  async postToolResult(
    threadId: string,
    data: {
      request_id: string
      tool_name: string
      result: Record<string, unknown>
      page_context?: Record<string, unknown>
    },
  ): Promise<AdvancedAssistantToolResultResponse> {
    const response = await apiClient.post<unknown>(`${advancedEndpointPrefix()}/threads/${threadId}/tool-results`, data)
    return messageResponse<AdvancedAssistantToolResultResponse>(response)
  },
}
