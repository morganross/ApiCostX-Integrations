export const DEFAULT_BASE_URL = 'https://api.apicostx.com'
export const API_KEY_HEADER = 'X-ACM2-API-Key'

const TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'canceled',
  'error',
])

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ApiClientOptions {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  retryBackoffMs?: number
  fetchImpl?: FetchLike
}

export interface ExecuteOverrides {
  run_name?: string
  run_description?: string
  iterations?: 1 | 2 | 3
  eval_iterations?: 1 | 2 | 3
}

export interface ExecuteOptions {
  inputContentIds?: string[]
  idempotencyKey?: string
  overrides?: ExecuteOverrides
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class AuthenticationError extends ApiError {}
export class PermissionError extends ApiError {}
export class NotFoundError extends ApiError {}
export class RateLimitError extends ApiError {
  constructor(message: string, status: number, detail?: unknown, public readonly retryAfter?: number) {
    super(message, status, detail)
  }
}

export class ApiCostXClient {
  private readonly apiKey?: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryBackoffMs: number
  private readonly fetchImpl: FetchLike

  constructor(options: ApiClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.retryBackoffMs = Math.max(0, options.retryBackoffMs ?? 500)
    this.fetchImpl = options.fetchImpl || fetch
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true, binary = false, deadline = Infinity): Promise<T> {
    if (authenticated && !this.apiKey) throw new AuthenticationError('APICOSTX_API_KEY is required', 401)
    const method = (init.method || 'GET').toUpperCase()
    const safeToRetry = ['GET', 'HEAD', 'OPTIONS'].includes(method)
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (authenticated) headers.set(API_KEY_HEADER, this.apiKey || '')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    for (let attempt = 0; ; attempt += 1) {
      if (Date.now() >= deadline) throw new Error('Run wait timeout exceeded')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, deadline - Date.now()))
      let response: Response
      let bytes: ArrayBuffer
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal, redirect: 'manual' })
        // Consume the body under the same timeout and release it before retrying.
        bytes = await response.arrayBuffer()
      } catch (error) {
        if (!safeToRetry || attempt >= this.maxRetries) throw error
        await this.delay(Math.min(this.retryBackoffMs * 2 ** attempt, Math.max(0, deadline - Date.now())))
        continue
      } finally {
        clearTimeout(timeout)
      }
      if (safeToRetry && [429, 502, 503, 504].includes(response.status) && attempt < this.maxRetries) {
        const delay = this.retryDelay(response, attempt)
        await this.delay(Math.min(delay, Math.max(0, deadline - Date.now())))
        continue
      }
      const text = new TextDecoder().decode(bytes)
      if (!response.ok) this.raise(response, text)
      if (response.status === 204 || response.status === 205) return undefined as T
      if (binary) return new Uint8Array(bytes) as T
      if (!text) return undefined as T
      const contentType = response.headers.get('content-type') || ''
      return (contentType.includes('json') ? JSON.parse(text) : text) as T
    }
  }

  private retryDelay(response: Response, attempt: number): number {
    const raw = response.headers.get('Retry-After')
    if (raw !== null && raw.trim() !== '') {
      const seconds = Number(raw)
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
      const date = Date.parse(raw)
      if (Number.isFinite(date)) return Math.max(0, date - Date.now())
    }
    return this.retryBackoffMs * 2 ** attempt
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
  }

  private raise(response: Response, text: string): never {
    let detail: unknown = text
    try { detail = text ? JSON.parse(text).detail ?? JSON.parse(text) : text } catch { /* plain text */ }
    const message = typeof detail === 'string' ? detail : `APICostX request failed (${response.status})`
    if (response.status === 401) throw new AuthenticationError(message, response.status, detail)
    if (response.status === 403) throw new PermissionError(message, response.status, detail)
    if (response.status === 404) throw new NotFoundError(message, response.status, detail)
    if (response.status === 429) throw new RateLimitError(message, response.status, detail, Number(response.headers.get('Retry-After')) || undefined)
    throw new ApiError(message, response.status, detail)
  }

  health(): Promise<Record<string, unknown>> { return this.request('/api/health', {}, false) }
  listPresets(page = 1, pageSize = 100): Promise<Record<string, unknown>> { return this.request(`/api/presets?page=${page}&page_size=${pageSize}`) }
  getPreset(presetId: string): Promise<Record<string, unknown>> { return this.request(`/api/presets/${encodeURIComponent(presetId)}`) }
  checkPreset(presetId: string): Promise<Record<string, unknown>> { return this.request(`/api/presets/${encodeURIComponent(presetId)}/runnable`) }

  executePreset(presetId: string, options: ExecuteOptions = {}): Promise<Record<string, unknown>> {
    const body = {
      ...(options.inputContentIds ? { input_content_ids: options.inputContentIds } : {}),
      ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    }
    const headers = options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined
    return this.request(`/api/presets/${encodeURIComponent(presetId)}/execute`, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  listRuns(status?: string, limit = 100, offset = 0): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (status) query.set('status', status)
    return this.request(`/api/runs?${query}`)
  }
  getRun(runId: string): Promise<Record<string, unknown>> { return this.request(`/api/runs/${encodeURIComponent(runId)}`) }
  getLiveSummary(runId: string): Promise<Record<string, unknown>> { return this.request(`/api/runs/${encodeURIComponent(runId)}/live-summary`) }
  getGeneratedResults(runId: string, sourceDocId?: string, limit = 50, offset = 0): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (sourceDocId) query.set('source_doc_id', sourceDocId)
    return this.request(`/api/runs/${encodeURIComponent(runId)}/sections/generated?${query}`)
  }
  getEvaluationResults(runId: string, sourceDocId: string, limit = 25, offset = 0): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ source_doc_id: sourceDocId, limit: String(limit), offset: String(offset) })
    return this.request(`/api/runs/${encodeURIComponent(runId)}/sections/evaluation?${query}`)
  }

  async waitForRun(runId: string, options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<Record<string, unknown>> {
    const deadline = Date.now() + (options.timeoutMs ?? 3_600_000)
    while (true) {
      const summary = await this.request<Record<string, unknown>>(`/api/runs/${encodeURIComponent(runId)}/live-summary`, {}, true, false, deadline)
      const status = String(summary.status || summary.run_status || '').toLowerCase()
      if (TERMINAL_STATUSES.has(status)) return this.request(`/api/runs/${encodeURIComponent(runId)}`, {}, true, false, deadline)
      if (Date.now() >= deadline) throw new Error(`Run ${runId} did not finish before the timeout`)
      await this.delay(Math.min(options.pollIntervalMs ?? 2_000, Math.max(0, deadline - Date.now())))
    }
  }

  async downloadExport(runId: string): Promise<Uint8Array> {
    const path = `/api/runs/${encodeURIComponent(runId)}/export`
    return this.request(path, {}, true, true)
  }
}

export { ApiCostXClient as ApiClient }
