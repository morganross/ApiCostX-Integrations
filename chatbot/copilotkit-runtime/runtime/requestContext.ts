import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  assistantToken: string;
  user: { uuid: string; token_expires_at: number };
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  const context = storage.getStore();
  if (!context) throw new Error("Assistant request context is missing");
  return context;
}
