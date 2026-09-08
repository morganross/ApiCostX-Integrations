export type ChatMessage = { role: 'system'|'developer'|'user'|'assistant'|'tool'; content: string; name?: string; tool_call_id?: string };
export type ChatCompletionRequest = { model: string; messages: ChatMessage[]; stream?: boolean; store?: boolean; conversation_id?: string; [key: string]: unknown };

export class AllieOwlError extends Error { constructor(message: string, public readonly status: number, public readonly code: string) { super(message); } }

export class AllieOwl {
  readonly chat = { completions: { create: (body: ChatCompletionRequest) => body.stream ? Promise.resolve(this.stream(body)) : this.request('/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) }) } };
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://assistant.apicostx.com/owl') {}
  async request(path: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch(this.baseUrl.replace(/\/$/, '') + path, { ...init, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}`, ...(init.headers || {}) } });
    const data = await response.json();
    if (!response.ok) { const error = data.error || {}; throw new AllieOwlError(error.message || 'Allie Owl request failed', response.status, error.code || 'request_failed'); }
    return data;
  }
  models() { return this.request('/v1/models'); }
  conversations() { return this.request('/v1/conversations'); }
  tools() { return this.request('/v1/tools'); }
  usage(days = 30) { return this.request(`/v1/usage?days=${encodeURIComponent(String(days))}`); }
  callTool(name: string, arguments_: Record<string, unknown> = {}) { return this.request('/v1/tools/call', { method: 'POST', body: JSON.stringify({ name, arguments: arguments_ }) }); }
  async *stream(body: ChatCompletionRequest): AsyncGenerator<unknown> {
    const response = await fetch(this.baseUrl.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!response.ok || !response.body) {
      throw new AllieOwlError('Allie Owl stream failed', response.status, 'stream_failed');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trimEnd();
          pending = pending.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          const chunk = JSON.parse(data);
          if (chunk.error) throw new AllieOwlError(chunk.error.message, 502, chunk.error.code);
          yield chunk;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}
