import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type AssistantSessionAgent = {
  threadId?: string
  messages: unknown
  isRunning: boolean
  state: Record<string, unknown>
  setThreadId: (threadId: string) => void
  setMessages: (messages: unknown) => void
  setState: (state: Record<string, unknown>) => void
  detachActiveRun?: () => Promise<void>
}

export type AssistantSessionCopilotKit = {
  runAgent: (params: { agent: unknown }) => Promise<unknown>
  stopAgent?: (params: { agent: unknown }) => void
}

type AssistantSessionContextValue = {
  agent: AssistantSessionAgent
  copilotkit: AssistantSessionCopilotKit | null
  interactive: boolean
}

const AssistantSessionContext = createContext<AssistantSessionContextValue | null>(null)

const fallbackAssistantAgent: AssistantSessionAgent = {
  threadId: undefined,
  messages: [],
  isRunning: false,
  state: {},
  setThreadId: () => {},
  setMessages: () => {},
  setState: () => {},
}

function normalizeAssistantAgent(agent: AssistantSessionAgent | null | undefined): AssistantSessionAgent {
  if (!agent) return fallbackAssistantAgent
  const setMessages =
    typeof agent.setMessages === 'function'
      ? (messages: unknown) => agent.setMessages.call(agent, messages)
      : fallbackAssistantAgent.setMessages
  const setThreadId = (threadId: string) => {
    agent.threadId = threadId
  }
  const setState =
    typeof agent.setState === 'function'
      ? (state: Record<string, unknown>) => agent.setState.call(agent, state)
      : fallbackAssistantAgent.setState
  const detachActiveRun =
    typeof agent.detachActiveRun === 'function'
      ? () => agent.detachActiveRun?.call(agent) ?? Promise.resolve()
      : undefined
  return {
    threadId: typeof agent.threadId === 'string' ? agent.threadId : undefined,
    messages: Array.isArray(agent.messages) ? agent.messages : [],
    isRunning: Boolean(agent.isRunning),
    state: agent.state && typeof agent.state === 'object' ? agent.state : {},
    setThreadId,
    setMessages,
    setState,
    ...(detachActiveRun ? { detachActiveRun } : {}),
  }
}

function normalizeCopilotKit(
  copilotkit: AssistantSessionCopilotKit | null,
  liveAgent: AssistantSessionAgent | null | undefined,
): AssistantSessionCopilotKit | null {
  if (!copilotkit) return null
  const getRunParams = (params: { agent: unknown }) => ({
    ...params,
    // CopilotKit/AG-UI run methods expect the original agent instance, not
    // ACM's normalized display wrapper.
    agent: liveAgent ?? params.agent,
  })
  const runAgent =
    typeof copilotkit.runAgent === 'function'
      ? (params: { agent: unknown }) => copilotkit.runAgent.call(copilotkit, getRunParams(params))
      : async () => null
  const stopAgent =
    typeof copilotkit.stopAgent === 'function'
      ? (params: { agent: unknown }) => copilotkit.stopAgent?.call(copilotkit, getRunParams(params))
      : undefined
  return {
    runAgent,
    ...(stopAgent ? { stopAgent } : {}),
  }
}

export function AssistantSessionProvider({
  agent,
  copilotkit,
  interactive,
  children,
}: {
  agent: AssistantSessionAgent | null | undefined
  copilotkit: AssistantSessionCopilotKit | null
  interactive: boolean
  children: ReactNode
}) {
  // CopilotKit keeps the same agent object while replacing its mutable message,
  // state, and run-status fields. Normalize on every bridge render so consumers
  // receive the latest values instead of a memoized empty snapshot.
  const normalizedAgent = normalizeAssistantAgent(agent)
  const normalizedCopilotKit = useMemo(() => normalizeCopilotKit(copilotkit, agent), [agent, copilotkit])
  const value = useMemo(
    () => ({ agent: normalizedAgent, copilotkit: normalizedCopilotKit, interactive: Boolean(interactive && agent) }),
    [agent, interactive, normalizedAgent, normalizedCopilotKit],
  )

  return <AssistantSessionContext.Provider value={value}>{children}</AssistantSessionContext.Provider>
}

export function useAssistantSession(): AssistantSessionContextValue {
  const context = useContext(AssistantSessionContext)
  if (!context) {
    throw new Error('useAssistantSession must be used within AssistantSessionProvider')
  }
  return context
}

export function useDemoAssistantAgent(): AssistantSessionAgent {
  const [threadId, setThreadId] = useState<string>()
  const [messages, setMessagesState] = useState<unknown[]>([])
  const [state, setStateState] = useState<Record<string, unknown>>({})

  const setMessages = useCallback((next: unknown) => {
    setMessagesState(Array.isArray(next) ? next : [])
  }, [])

  const setState = useCallback((next: Record<string, unknown>) => {
    setStateState(next)
  }, [])

  return useMemo(
    () => ({
      threadId,
      messages,
      isRunning: false,
      state,
      setThreadId,
      setMessages,
      setState,
    }),
    [messages, setMessages, setState, setThreadId, state, threadId],
  )
}
