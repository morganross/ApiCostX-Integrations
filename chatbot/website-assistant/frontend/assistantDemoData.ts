import type { AssistantEvent, AssistantThread, AssistantThreadContext } from './assistant'

const DEMO_TIMESTAMP = '2026-06-01T14:30:00.000Z'

function demoEvent(
  id: number,
  role: AssistantEvent['role'],
  eventType: string,
  content: string,
  toolName?: string,
): AssistantEvent {
  return {
    id,
    role,
    event_type: eventType,
    content,
    tool_name: toolName ?? null,
    tool_args_json: null,
    tool_result_json: null,
    created_at: DEMO_TIMESTAMP,
  }
}

const demoThreadPresets: AssistantThread = {
  id: 'demo-thread-presets',
  title: 'Inspect presets',
  archived: false,
  created_at: DEMO_TIMESTAMP,
  updated_at: DEMO_TIMESTAMP,
}

const demoThreadRun: AssistantThread = {
  id: 'demo-thread-run',
  title: 'Check a run',
  archived: false,
  created_at: DEMO_TIMESTAMP,
  updated_at: DEMO_TIMESTAMP,
}

export const ASSISTANT_DEMO_THREADS: AssistantThread[] = [demoThreadPresets, demoThreadRun]

const ASSISTANT_DEMO_CONTEXTS: Record<string, AssistantThreadContext> = {
  'demo-thread-presets': {
    thread: demoThreadPresets,
    memory: {
      summary: 'Visitor is browsing the presets workspace.',
      pinned_facts_json: {},
      summarized_through_event_id: 4,
      updated_at: DEMO_TIMESTAMP,
    },
    recent_events: [
      demoEvent(1, 'user', 'message', 'What presets do I have?'),
      demoEvent(
        2,
        'assistant',
        'message',
        [
          'You have 3 presets in this workspace:',
          '- Blog draft pipeline (runnable)',
          '- Competitor scan (runnable)',
          '- Weekly newsletter (not runnable — missing source prompt)',
          '',
          'Ask me to open one, or sign in to run a preset yourself.',
        ].join('\n'),
      ),
      demoEvent(3, 'user', 'message', 'Why is Weekly newsletter not runnable?'),
      demoEvent(
        4,
        'assistant',
        'message',
        [
          'Weekly newsletter is missing a source prompt configuration.',
          'Once you sign in, ACM can walk you through enabling source prompt mode and selecting models.',
        ].join('\n'),
      ),
    ],
    last_summarized_event_id: 4,
  },
  'demo-thread-run': {
    thread: demoThreadRun,
    memory: {
      summary: 'Visitor asked about a recent execute run.',
      pinned_facts_json: { latest_demo_run_id: 'demo-run-1042' },
      summarized_through_event_id: 3,
      updated_at: DEMO_TIMESTAMP,
    },
    recent_events: [
      demoEvent(1, 'user', 'message', 'What is the status of my latest run?'),
      demoEvent(
        2,
        'assistant',
        'message',
        [
          'Latest run demo-run-1042 (Blog draft pipeline) finished successfully.',
          'Generated 2 artifacts and passed quality checks.',
          'Sign in to view live logs, outputs, and rerun from Execute.',
        ].join('\n'),
      ),
      demoEvent(3, 'user', 'message', 'Show me the run log highlights'),
      demoEvent(
        4,
        'assistant',
        'tool_result',
        JSON.stringify({
          status: 'completed',
          items: [
            { id: 'demo-run-1042', name: 'Blog draft pipeline', runnable: true },
          ],
        }),
        'get_run_status',
      ),
    ],
    last_summarized_event_id: 3,
  },
}

export function listAssistantDemoThreads(includeArchived = false): AssistantThread[] {
  return ASSISTANT_DEMO_THREADS.filter((thread) => includeArchived || !thread.archived)
}

export function getAssistantDemoThreadContext(threadId: string, limit = 40): AssistantThreadContext {
  const context = ASSISTANT_DEMO_CONTEXTS[threadId]
  if (!context) {
    throw new Error(`Assistant thread not found: ${threadId}`)
  }

  return {
    ...context,
    recent_events: context.recent_events.slice(-Math.max(1, limit)),
  }
}
