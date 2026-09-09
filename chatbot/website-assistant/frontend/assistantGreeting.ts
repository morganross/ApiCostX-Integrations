/** Prefix for UI-only greeting message ids (never sent to CopilotKit or persisted). */
export const ASSISTANT_LOCAL_GREETING_ID_PREFIX = 'acm2-local-greeting:'

export const ASSISTANT_LOCAL_GREETING =
  "Hi! I'm Allie. Ask me about presets, runs, or anything on this page."

export function buildLocalGreetingMessageId(threadId: string): string {
  return `${ASSISTANT_LOCAL_GREETING_ID_PREFIX}${threadId}`
}
