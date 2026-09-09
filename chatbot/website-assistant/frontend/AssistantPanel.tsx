import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Archive, Mic, PanelLeftClose, PanelLeftOpen, Plus, Send, Square, X } from 'lucide-react'
import { assistantApi, type AssistantEvent, type AssistantThread } from '@/api/assistant'
import {
  assistantAdvancedApi,
  type AdvancedAssistantMessage,
  type AdvancedAssistantToolRequest,
} from '@/api/assistantAdvanced'
import {
  createAssistantDevTraceId,
  logAssistantDevEvent,
  normalizeAssistantDevError,
  type AssistantDevTraceContext,
} from '@/api/assistantDevLogger'
import { settingsApi } from '@/api/settings'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel'
import { cn } from '@/lib/utils'
import { AssistantCopilotHooks } from './AssistantCopilotHooks'
import { AdvancedWebsiteToolBridge } from './AdvancedWebsiteToolBridge'
import {
  getBootstrapAssistantDefaultMode,
  hasBasicAssistantRuntimeConfig,
  readAssistantModeOverride,
} from './assistantConfig'
import { canShowAssistant, isAssistantDemoMode, isAssistantInteractive } from './assistantAvailability'
import { useAssistantChrome } from './AssistantChromeContext'
import { useAssistantSession } from './AssistantSessionContext'
import { ASSISTANT_KNOWLEDGE_VERSION, buildAssistantKnowledgeSystemMessage, isAssistantKnowledgeSystemMessage } from './assistantKnowledge'
import type { AssistantMode } from './assistantTypes'
import {
  ALLIE_MASCOT_DEFAULT_EXPRESSION,
  ALLIE_MASCOT_THINKING_EXPRESSION,
  getAllieMascotExpressionAsset,
  type AllieMascotExpression,
} from '@/assets/allieMascotExpressions'
import {
  reduceAllieMascotMood,
  resolveAllieMascotExpression,
  type AllieMascotToolSignal,
} from './allieMascotEmotion'
import { useAllieMascotIdleExpression } from './useAllieMascotIdleExpression'
import { useAssistantLocalGreeting } from './useAssistantLocalGreeting'
import { useAssistantVoiceInput } from './useAssistantVoiceInput'
type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content?: string
  toolCalls?: Array<{ id: string; name?: string }>
  toolCallId?: string
  name?: string
}

const HISTORY_OPEN_STORAGE_KEY = 'acm2-assistant-history-open'
const PENDING_ADVANCED_TOOL_STORAGE_KEY = 'acm2.assistant.pendingAdvancedToolRequest'
/** Scales with chat text size; change one value to resize the assistant drop-cap owl. */
const ASSISTANT_MASCOT_CAP_WIDTH = '3.3lh'
/** Empty band below the last bubble — keeps the viewport steady when the user sends next. */
const ASSISTANT_REPLY_ZONE_HEIGHT = 'clamp(6rem, 38vh, 20rem)'
const ASSISTANT_MESSAGES_BOTTOM_PAD = '1rem'
const ASSISTANT_RUN_IDLE_WATCHDOG_MS = 600_000
const ASSISTANT_RUN_HARD_WATCHDOG_MS = 1_800_000
const ASSISTANT_RUN_WATCHDOG_POLL_MS = 10_000
const ADVANCED_AUTO_TOOL_HOP_LIMIT = 24
const ASSISTANT_HEADER_ICON_BUTTON_STYLE = {
  backgroundImage: 'none',
  borderColor: 'transparent',
  boxShadow: 'none',
} as const

type AssistantMemoryState = {
  summary: string
  pinnedFacts: Record<string, unknown>
}

type PendingAdvancedToolRequest = {
  threadId: string
  request: AdvancedAssistantToolRequest
}

type AllieMascotMoodState = {
  contextKey: string
  expression: AllieMascotExpression
  repeatedCount: number
}

function isAdvancedToolRequest(value: unknown): value is AdvancedAssistantToolRequest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.type === 'tool_request' &&
    typeof record.tool_name === 'string' &&
    typeof record.request_id === 'string' &&
    typeof record.requires_confirmation === 'boolean' &&
    Boolean(record.arguments && typeof record.arguments === 'object')
  )
}

function readPendingAdvancedToolRequest(): PendingAdvancedToolRequest | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PENDING_ADVANCED_TOOL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.threadId !== 'string' || !isAdvancedToolRequest(parsed.request)) {
      window.localStorage.removeItem(PENDING_ADVANCED_TOOL_STORAGE_KEY)
      return null
    }
    return {
      threadId: parsed.threadId,
      request: parsed.request,
    }
  } catch {
    try {
      window.localStorage.removeItem(PENDING_ADVANCED_TOOL_STORAGE_KEY)
    } catch {
      // Pending confirmation recovery is best-effort.
    }
    return null
  }
}

function writePendingAdvancedToolRequest(pending: PendingAdvancedToolRequest | null): void {
  if (typeof window === 'undefined') return
  try {
    if (!pending) {
      window.localStorage.removeItem(PENDING_ADVANCED_TOOL_STORAGE_KEY)
      return
    }
    window.localStorage.setItem(PENDING_ADVANCED_TOOL_STORAGE_KEY, JSON.stringify(pending))
  } catch {
    // Pending confirmation recovery is best-effort.
  }
}

function buildCancelledAdvancedToolResult(request: AdvancedAssistantToolRequest) {
  return {
    status: 'cancelled',
    cancelled: true,
    tool_name: request.tool_name,
    message: `Website action was cancelled. I did not run ${request.tool_name}.`,
  }
}

function readHistoryOpenPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(HISTORY_OPEN_STORAGE_KEY)
    if (raw === '0') return false
    if (raw === '1') return true
  } catch {
    return false
  }
  return false
}

function writeHistoryOpenPreference(open: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(HISTORY_OPEN_STORAGE_KEY, open ? '1' : '0')
  } catch {
    // Preference storage is non-critical.
  }
}

function getPageContext() {
  const hashPath = window.location.hash.replace(/^#/, '') || '/'
  return {
    route: hashPath,
    page: hashPath.split('/').filter(Boolean)[0] || 'presets',
    active_preset_id: hashPath.match(/^\/presets\/([^/]+)/)?.[1] ?? null,
    current_run_id: hashPath.match(/^\/execute\/([^/]+)/)?.[1] ?? null,
  }
}

function getAssistantPageContext() {
  const context = getPageContext()
  return {
    route: context.route,
    page: context.page,
    active_preset_id: context.active_preset_id,
    current_run_id: context.current_run_id,
    logged_in: Boolean(window.acm2Config?.currentUser),
  }
}

function buildAssistantPanelTraceContext(
  threadId?: string | null,
  assistantRunId?: string | null,
  pageContext = getAssistantPageContext(),
): AssistantDevTraceContext {
  return {
    assistant_thread_id: threadId ?? null,
    assistant_run_id: assistantRunId ?? null,
    acm_run_id: pageContext.current_run_id,
    route: pageContext.route,
    page: pageContext.page,
  }
}

function createEmptyAssistantMemory(): AssistantMemoryState {
  return { summary: '', pinnedFacts: {} }
}

function buildAcmAgentState(threadId: string, pageContext: ReturnType<typeof getAssistantPageContext>, memory: AssistantMemoryState) {
  return {
    thread_id: threadId,
    page_context: pageContext,
    memory_summary: memory.summary,
    pinned_facts: memory.pinnedFacts,
    knowledge_pack_version: ASSISTANT_KNOWLEDGE_VERSION,
  }
}

function removeGeneratedSystemMessages(messages: AgentMessage[]) {
  return messages.filter((message) => {
    if (isAssistantKnowledgeSystemMessage(message)) return false
    if (message.role === 'system' && message.content?.startsWith('Current ACM assistant thread_id:')) return false
    return true
  })
}

function repairOrphanedAgentToolMessages(messages: AgentMessage[]) {
  const callIds = new Set(
    messages.flatMap((message) => message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : []),
  )
  const resultIds = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.toolCallId)
      .map((message) => message.toolCallId as string),
  )
  const completeIds = new Set([...callIds].filter((id) => resultIds.has(id)))
  let droppedAssistantCalls = 0
  let droppedToolResults = 0
  const repaired = messages.filter((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const ids = message.toolCalls.map((call) => call.id)
      if (ids.length === 0 || ids.some((id) => !completeIds.has(id))) {
        droppedAssistantCalls += 1
        return false
      }
    }
    if (message.role === 'tool' && (!message.toolCallId || !completeIds.has(message.toolCallId))) {
      droppedToolResults += 1
      return false
    }
    return true
  })
  return { messages: repaired, droppedAssistantCalls, droppedToolResults }
}

function eventToMessage(event: AssistantEvent): AgentMessage | null {
  if (!event.content || !['user', 'assistant', 'system', 'tool'].includes(event.role)) return null
  if (event.role === 'assistant' && isHistoricalToolCallStub(event)) return null
  if (event.role === 'tool') return eventToHistoricalToolSummary(event)
  return { id: `event-${event.id}`, role: event.role as AgentMessage['role'], content: event.content }
}

function isHistoricalToolCallStub(event: AssistantEvent): boolean {
  return event.event_type === 'message' && /^Tool:\s+call_[A-Za-z0-9_-]+/.test(event.content?.trim() ?? '')
}

function eventToHistoricalToolSummary(event: AssistantEvent): AgentMessage {
  const toolName = event.tool_name && event.tool_name !== 'tool' ? event.tool_name : undefined
  return {
    id: `event-${event.id}`,
    role: 'assistant',
    content: [
      `Previous tool result${toolName ? ` (${toolName})` : ''}:`,
      summarizeToolResult(event.content ?? '', toolName),
      'This is a historical tool summary; rerun a tool for current data.',
    ].join('\n'),
  }
}

function messageContent(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content
  if (message.toolCalls?.length) return message.toolCalls.map((tool) => `Tool: ${tool.name || tool.id}`).join('\n')
  return ''
}

function isLiveAssistantToolCallMessage(message: AgentMessage): boolean {
  return message.role === 'assistant' && !message.content && Boolean(message.toolCalls?.length)
}

function messageToolName(message: AgentMessage): string | undefined {
  return message.name ?? message.toolCalls?.[0]?.name ?? message.toolCallId
}

function collectRecentToolSignals(
  messages: AgentMessage[],
  assistantMessageId: string | null,
): AllieMascotToolSignal[] {
  if (!assistantMessageId) return []
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId)
  if (assistantIndex < 0) return []

  const signals: AllieMascotToolSignal[] = []
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'user') break
    if (message.role === 'tool') {
      signals.unshift({
        toolName: messageToolName(message),
        content: messageContent(message),
      })
    }
    if (isLiveAssistantToolCallMessage(message)) {
      signals.unshift({
        toolName: messageToolName(message),
        content: messageContent(message),
      })
    }
  }
  return signals
}

function buildMascotEmotionContextKey({
  assistantMessageId,
  assistantText,
  toolSignals,
  pendingToolRequestId,
  isThinking,
}: {
  assistantMessageId: string | null
  assistantText: string
  toolSignals: AllieMascotToolSignal[]
  pendingToolRequestId?: string
  isThinking: boolean
}): string {
  const toolKey = toolSignals
    .map((signal) => `${signal.toolName ?? ''}:${signal.content?.slice(0, 160) ?? ''}`)
    .join('|')
  return [
    assistantMessageId ?? 'none',
    assistantText.length,
    toolKey,
    pendingToolRequestId ?? '',
    isThinking ? 'thinking' : 'idle',
  ].join('::')
}

function displayMessageContent(message: AgentMessage): string {
  const content = messageContent(message)
  if (message.role !== 'tool') return content
  return summarizeToolResult(content, message.name)
}

function assistantMessageHasDisplayContent(message: AgentMessage): boolean {
  if (isLiveAssistantToolCallMessage(message)) return false
  return Boolean(displayMessageContent(message).trim())
}

function summarizeToolResult(content: string, toolName?: string): string {
  const parsed = tryParseJson(content)
  if (!parsed || typeof parsed !== 'object') return `Tool result${toolName ? `: ${toolName}` : ''}`
  const value = parsed as Record<string, unknown>
  const items = Array.isArray(value.items) ? value.items : Array.isArray(value.presets) ? value.presets : null
  if (items) {
    const names = items
      .slice(0, 8)
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const name = typeof row.name === 'string' ? row.name : typeof row.id === 'string' ? row.id : null
        if (!name) return null
        const runnable = typeof row.runnable === 'boolean' ? (row.runnable ? 'runnable' : 'not runnable') : null
        return runnable ? `${name} (${runnable})` : name
      })
      .filter((name): name is string => Boolean(name))
    return [
      `Tool result: ${items.length} preset${items.length === 1 ? '' : 's'} found.`,
      ...names.map((name) => `- ${name}`),
      items.length > names.length ? `...and ${items.length - names.length} more.` : '',
    ].filter(Boolean).join('\n')
  }
  if (typeof value.error === 'string') return `Tool error: ${value.error}`
  if (typeof value.status === 'string') return `Tool result: ${value.status}`
  return `Tool result${toolName ? `: ${toolName}` : ''}`
}

function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

function tryParseJsonRecord(content: string): Record<string, unknown> | undefined {
  const parsed = tryParseJson(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function normalizeAssistantMode(
  requestedMode: AssistantMode,
  options: { basicAvailable: boolean; advancedAvailable: boolean },
): AssistantMode {
  if (requestedMode === 'advanced' && options.advancedAvailable) {
    return 'advanced'
  }
  if (requestedMode === 'basic' && options.basicAvailable) {
    return 'basic'
  }
  if (options.advancedAvailable) {
    return 'advanced'
  }
  return 'basic'
}

function advancedMessageToAgentMessage(message: AdvancedAssistantMessage): AgentMessage {
  return {
    id: `advanced-message-${message.id}`,
    role: message.role,
    content: message.content,
  }
}

async function runAdvancedWebsiteTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const bridge = window.acm2AdvancedWebsiteTools
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'Advanced website tool bridge is not mounted.',
      requested_tool: toolName,
    }
  }
  return bridge.invoke(toolName, args)
}

export function AssistantPanel() {
  const { assistantOpen, closeAssistant } = useAssistantChrome()
  const basicModeAvailable = hasBasicAssistantRuntimeConfig()
  // Advanced remains implemented behind the scenes, but its backend graph does
  // not yet expose the page mutation tools reliably. Keep one safe user-facing
  // assistant until the advanced end-to-end mutation suite passes.
  const advancedModeAvailable = false
  const [activeMode, setActiveMode] = useState<AssistantMode>(() =>
    normalizeAssistantMode(readAssistantModeOverride() ?? getBootstrapAssistantDefaultMode(), {
      basicAvailable: basicModeAvailable,
      advancedAvailable: advancedModeAvailable,
    }),
  )
  const [modeLoading, setModeLoading] = useState(Boolean(window.acm2Config?.currentUser))
  const [historyOpen, setHistoryOpen] = useState(readHistoryOpenPreference)
  const [threads, setThreads] = useState<AssistantThread[]>([])
  const [activeThread, setActiveThread] = useState<AssistantThread | null>(null)
  const [input, setInput] = useState('')
  const [loadingThreads, setLoadingThreads] = useState(false)
  const [threadContextLoading, setThreadContextLoading] = useState(false)
  const [advancedSending, setAdvancedSending] = useState(false)
  const [basicRunInFlight, setBasicRunInFlight] = useState(false)
  const [composerReleasedThreadId, setComposerReleasedThreadId] = useState<string | null>(null)
  const [assistantReplyPending, setAssistantReplyPending] = useState(false)
  const [pendingAdvancedToolRequest, setPendingAdvancedToolRequest] = useState<PendingAdvancedToolRequest | null>(null)
  const [advancedToolDecisionInProgress, setAdvancedToolDecisionInProgress] = useState(false)
  const [loadedThreadContextId, setLoadedThreadContextId] = useState<string | null>(null)
  const [threadHasPersistedMessages, setThreadHasPersistedMessages] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [threadMemory, setThreadMemory] = useState<AssistantMemoryState>(createEmptyAssistantMemory)
  const [advancedMessages, setAdvancedMessages] = useState<AgentMessage[]>([])
  const [chatMascotMood, setChatMascotMood] = useState<AllieMascotMoodState>({
    contextKey: '',
    expression: ALLIE_MASCOT_DEFAULT_EXPRESSION,
    repeatedCount: 0,
  })
  const persistedMessageIds = useRef<Set<string>>(new Set())
  const assistantRunStartedAtRef = useRef<number | null>(null)
  const assistantRunLastProgressAtRef = useRef<number | null>(null)
  const assistantStopInProgressRef = useRef(false)
  const assistantRunInFlightRef = useRef(false)
  const pendingAdvancedToolStorageHydratedRef = useRef(false)
  const { agent, copilotkit, interactive } = useAssistantSession()
  const assistantPageContext = getAssistantPageContext()

  useEffect(() => {
    if (activeMode !== 'basic' || !activeThread?.id || basicRunInFlight) return
    if (agent.threadId === activeThread.id) return
    agent.setThreadId(activeThread.id)
  }, [activeMode, activeThread?.id, agent.setThreadId, agent.threadId, basicRunInFlight])
  const activeDisplayMessages = activeMode === 'advanced'
    ? advancedMessages
    : ((agent.messages || []) as AgentMessage[])
  const visibleMessages = useMemo(
    () => activeDisplayMessages.filter((message) => message.role !== 'system' && message.role !== 'tool'),
    [activeDisplayMessages],
  )
  const threadContextReady = Boolean(activeThread && loadedThreadContextId === activeThread.id && !threadContextLoading)
  useEffect(() => {
    setComposerReleasedThreadId(null)
  }, [activeThread?.id])
  const { greeting: localGreeting, clearGreeting: clearLocalGreeting } = useAssistantLocalGreeting({
    assistantOpen,
    threadContextReady,
    threadHasPersistedMessages,
    activeThreadId: activeThread?.id ?? null,
    interactive,
  })
  const displayMessages = useMemo(() => {
    if (!localGreeting) {
      return visibleMessages
    }
    const greetingMessage: AgentMessage = {
      id: localGreeting.id,
      role: 'assistant',
      content: localGreeting.content,
    }
    return [greetingMessage, ...visibleMessages]
  }, [localGreeting, visibleMessages])

  useEffect(() => {
    if (activeMode !== 'advanced') {
      pendingAdvancedToolStorageHydratedRef.current = true
      writePendingAdvancedToolRequest(null)
      return
    }
    if (!activeThread || pendingAdvancedToolRequest) {
      return
    }
    const stored = readPendingAdvancedToolRequest()
    pendingAdvancedToolStorageHydratedRef.current = true
    if (!stored) {
      return
    }
    if (stored.threadId === activeThread.id) {
      setPendingAdvancedToolRequest(stored)
      return
    }
    writePendingAdvancedToolRequest(null)
  }, [activeMode, activeThread, pendingAdvancedToolRequest])

  useEffect(() => {
    if (!pendingAdvancedToolStorageHydratedRef.current) {
      return
    }
    writePendingAdvancedToolRequest(pendingAdvancedToolRequest)
  }, [pendingAdvancedToolRequest])
  const latestAssistantMessageId = useMemo(() => {
    for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
      const message = displayMessages[index]
      if (message?.role === 'assistant') {
        return message.id
      }
    }
    return null
  }, [displayMessages])
  const chatMascotMessageId = useMemo(() => {
    if (localGreeting) {
      return localGreeting.id
    }
    const lastMessage = visibleMessages[visibleMessages.length - 1]
    if (lastMessage?.role !== 'assistant') {
      return null
    }
    return lastMessage.id
  }, [localGreeting, visibleMessages])
  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1] ?? null
  const lastDisplayMessageId = displayMessages[displayMessages.length - 1]?.id ?? null
  const showAssistantThinking = useMemo(() => {
    if (!assistantReplyPending || !lastVisibleMessage) {
      return false
    }
    if (lastVisibleMessage.role === 'user') {
      return true
    }
    if (lastVisibleMessage.role === 'assistant') {
      return !assistantMessageHasDisplayContent(lastVisibleMessage)
    }
    return false
  }, [assistantReplyPending, lastVisibleMessage])
  const latestAssistantMessage = useMemo(() => {
    if (!chatMascotMessageId) return null
    return displayMessages.find((message) => message.id === chatMascotMessageId) ?? null
  }, [chatMascotMessageId, displayMessages])
  const chatMascotToolSignals = useMemo(() => {
    if (!chatMascotMessageId || localGreeting) return []
    return collectRecentToolSignals(activeDisplayMessages, chatMascotMessageId)
  }, [activeDisplayMessages, chatMascotMessageId, localGreeting])
  const chatMascotEmotionContext = useMemo(() => {
    const assistantText = latestAssistantMessage ? displayMessageContent(latestAssistantMessage) : ''
    const contextKey = buildMascotEmotionContextKey({
      assistantMessageId: chatMascotMessageId,
      assistantText,
      toolSignals: chatMascotToolSignals,
      pendingToolRequestId: pendingAdvancedToolRequest?.request.request_id,
      isThinking: showAssistantThinking,
    })
    const rawExpression = resolveAllieMascotExpression({
      assistantText,
      toolSignals: chatMascotToolSignals,
      pendingToolRequest: Boolean(pendingAdvancedToolRequest),
      isThinking: showAssistantThinking,
    })
    return { contextKey, rawExpression }
  }, [
    chatMascotMessageId,
    chatMascotToolSignals,
    latestAssistantMessage,
    pendingAdvancedToolRequest,
    showAssistantThinking,
  ])
  const displayedChatMascotExpression = useAllieMascotIdleExpression({
    baseExpression: chatMascotMood.expression,
    enabled: Boolean(assistantOpen && chatMascotMessageId && !showAssistantThinking && !pendingAdvancedToolRequest),
  })
  const chatMascotImageUrl = getAllieMascotExpressionAsset(displayedChatMascotExpression)
  const thinkingMascotImageUrl = getAllieMascotExpressionAsset(ALLIE_MASCOT_THINKING_EXPRESSION)
  const prevChatMascotMessageIdRef = useRef<string | null>(null)
  const [enteringMascotMessageId, setEnteringMascotMessageId] = useState<string | null>(null)

  useEffect(() => {
    setChatMascotMood((current) => {
      if (chatMascotEmotionContext.contextKey === current.contextKey) {
        return current
      }
      const nextMood = reduceAllieMascotMood({
        rawExpression: chatMascotEmotionContext.rawExpression,
        previousExpression: current.expression,
        repeatedCount: current.repeatedCount,
      })
      return {
        contextKey: chatMascotEmotionContext.contextKey,
        expression: nextMood.expression,
        repeatedCount: nextMood.repeatedCount,
      }
    })
  }, [chatMascotEmotionContext])

  useEffect(() => {
    if (!chatMascotMessageId) {
      prevChatMascotMessageIdRef.current = null
      return
    }
    if (chatMascotMessageId === prevChatMascotMessageIdRef.current) {
      return
    }
    prevChatMascotMessageIdRef.current = chatMascotMessageId
    setEnteringMascotMessageId(chatMascotMessageId)
  }, [chatMascotMessageId])

  useEffect(() => {
    if (!enteringMascotMessageId) {
      return
    }
    const timeoutId = window.setTimeout(() => setEnteringMascotMessageId(null), 220)
    return () => window.clearTimeout(timeoutId)
  }, [enteringMascotMessageId])

  useEffect(() => {
    if (!assistantReplyPending || !lastVisibleMessage) {
      return
    }
    if (
      lastVisibleMessage.role === 'assistant' &&
      assistantMessageHasDisplayContent(lastVisibleMessage)
    ) {
      setAssistantReplyPending(false)
    }
  }, [assistantReplyPending, lastVisibleMessage])

  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const messageScrollKey = useMemo(() => {
    const lastMessage = displayMessages[displayMessages.length - 1]
    if (!lastMessage) {
      return `0:${showAssistantThinking ? 'thinking' : 'idle'}`
    }
    return `${displayMessages.length}:${lastMessage.id}:${lastMessage.content?.length ?? 0}:${showAssistantThinking ? 'thinking' : 'idle'}`
  }, [displayMessages, showAssistantThinking])

  const scrollMessagesToBottom = useCallback(() => {
    const element = messagesScrollRef.current
    if (!element) {
      return
    }
    const scrollToEnd = () => {
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      element.scrollTop = maxScrollTop
    }
    scrollToEnd()
    window.requestAnimationFrame(() => {
      scrollToEnd()
      window.requestAnimationFrame(scrollToEnd)
    })
  }, [])

  const scrollForAppendedContent = useCallback((previousScrollHeight: number) => {
    const element = messagesScrollRef.current
    if (!element || !stickToBottomRef.current) {
      return
    }
    const apply = () => {
      const delta = element.scrollHeight - previousScrollHeight
      if (delta > 0) {
        element.scrollTop += delta
        return
      }
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    }
    apply()
    window.requestAnimationFrame(apply)
  }, [])

  const handleMessagesScroll = useCallback(() => {
    const element = messagesScrollRef.current
    if (!element) {
      return
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottomRef.current = distanceFromBottom <= 48
  }, [])

  useEffect(() => {
    const element = messagesScrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) {
        return
      }
      scrollMessagesToBottom()
    })
    observer.observe(element)
    for (const child of element.children) {
      observer.observe(child)
    }
    return () => observer.disconnect()
  }, [assistantOpen, displayMessages.length, scrollMessagesToBottom])

  useLayoutEffect(() => {
    if (!assistantOpen) {
      return
    }
    stickToBottomRef.current = true
    scrollMessagesToBottom()
    const rafId = window.requestAnimationFrame(() => scrollMessagesToBottom())
    return () => window.cancelAnimationFrame(rafId)
  }, [assistantOpen, scrollMessagesToBottom])

  useLayoutEffect(() => {
    if (!assistantOpen || !stickToBottomRef.current) {
      return
    }
    scrollMessagesToBottom()
  }, [assistantOpen, messageScrollKey, scrollMessagesToBottom])
  const basicComposerBlocked = basicRunInFlight || (!threadContextReady && composerReleasedThreadId !== activeThread?.id)
  const advancedComposerBlocked =
    advancedSending || advancedToolDecisionInProgress || Boolean(pendingAdvancedToolRequest) || !threadContextReady
  const composerDisabled =
    !interactive ||
    modeLoading ||
    !activeThread ||
    (activeMode === 'advanced' ? advancedComposerBlocked : basicComposerBlocked)
  const handleVoiceTranscript = useCallback((transcript: string) => {
    setInput((current) => {
      const trimmedCurrent = current.trim()
      return trimmedCurrent ? `${trimmedCurrent} ${transcript}` : transcript
    })
    window.requestAnimationFrame(() => {
      document.getElementById('acm-assistant-composer')?.focus()
    })
  }, [])
  const handleVoiceError = useCallback((message: string) => {
    setError(message)
  }, [])
  const {
    isRecording: voiceRecording,
    isTranscribing: voiceTranscribing,
    isSupported: voiceSupported,
    statusText: voiceStatusText,
    toggleRecording: toggleVoiceRecording,
  } = useAssistantVoiceInput({
    onTranscript: handleVoiceTranscript,
    onError: handleVoiceError,
  })
  const voiceBusy = voiceRecording || voiceTranscribing
  const voiceDisabled = !voiceRecording && (composerDisabled || voiceTranscribing || !voiceSupported)

  useEffect(() => {
    let cancelled = false
    const bootstrapDefault = normalizeAssistantMode(getBootstrapAssistantDefaultMode(), {
      basicAvailable: basicModeAvailable,
      advancedAvailable: advancedModeAvailable,
    })
    const override = readAssistantModeOverride()
    const normalizedOverride = override
      ? normalizeAssistantMode(override, {
          basicAvailable: basicModeAvailable,
          advancedAvailable: advancedModeAvailable,
        })
      : null
    setModeLoading(Boolean(window.acm2Config?.currentUser))

    if (!window.acm2Config?.currentUser) {
      setActiveMode(normalizedOverride ?? bootstrapDefault)
      setModeLoading(false)
      return () => {
        cancelled = true
      }
    }

    settingsApi.get()
      .then((settings) => {
        if (cancelled) return
        const saved = settings.assistant?.defaultMode === 'advanced' ? 'advanced' : bootstrapDefault
        const normalizedSaved = normalizeAssistantMode(saved, {
          basicAvailable: basicModeAvailable,
          advancedAvailable: advancedModeAvailable,
        })
        setActiveMode(normalizedOverride ?? normalizedSaved)
      })
      .catch(() => {
        if (cancelled) return
        setActiveMode(normalizedOverride ?? bootstrapDefault)
      })
      .finally(() => {
        if (!cancelled) {
          setModeLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [advancedModeAvailable, basicModeAvailable])

  const agentSetMessagesRef = useRef(agent.setMessages)
  agentSetMessagesRef.current = agent.setMessages
  const setAgentMessages = useCallback((messages: unknown) => {
    // CopilotKit/AG-UI agents implement setters as instance methods; keep the receiver bound.
    agentSetMessagesRef.current(messages)
  }, [])
  useEffect(() => {
    setThreads([])
    setActiveThread(null)
    setThreadContextLoading(false)
    setLoadedThreadContextId(null)
    setThreadMemory(createEmptyAssistantMemory())
    setAdvancedSending(false)
    setBasicRunInFlight(false)
    setComposerReleasedThreadId(null)
    assistantRunInFlightRef.current = false
    setPendingAdvancedToolRequest(null)
    setAdvancedToolDecisionInProgress(false)
    persistedMessageIds.current = new Set()
    setAdvancedMessages([])
    setAssistantReplyPending(false)
    setAgentMessages([])
    setError(null)
  }, [activeMode, setAgentMessages])

  const stopAssistantRun = useCallback((reason: 'manual' | 'watchdog_idle' | 'watchdog_timeout' = 'manual') => {
    if (!interactive || !copilotkit) return
    const traceContext = buildAssistantPanelTraceContext(activeThread?.id)
    if (!basicRunInFlight && reason === 'manual') return

    assistantStopInProgressRef.current = true
    if (reason !== 'manual') {
      setError('Assistant run looked stuck, so ACM stopped it. You can try again.')
    }

    logAssistantDevEvent({
      event: 'assistant_run_stop',
      phase: 'request',
      trace_context: traceContext,
      payload: {
        reason,
        started_at_ms: assistantRunStartedAtRef.current,
        last_progress_at_ms: assistantRunLastProgressAtRef.current,
        agent_messages: agent.messages,
        agent_state: agent.state,
      },
    })

    try {
      const stoppableCopilotkit = copilotkit as typeof copilotkit & { stopAgent?: (params: { agent: typeof agent }) => void }
      if (typeof stoppableCopilotkit.stopAgent === 'function') {
        stoppableCopilotkit.stopAgent({ agent })
      } else {
        const stoppableAgent = agent as typeof agent & { abortRun?: () => void }
        stoppableAgent.abortRun?.()
      }
      logAssistantDevEvent({
        event: 'assistant_run_stop',
        phase: 'success',
        trace_context: traceContext,
        payload: { reason },
      })
    } catch (error) {
      logAssistantDevEvent({
        event: 'assistant_run_stop',
        phase: 'error',
        trace_context: traceContext,
        payload: { reason },
        error: normalizeAssistantDevError(error),
      })
      try {
        const stoppableAgent = agent as typeof agent & { abortRun?: () => void }
        stoppableAgent.abortRun?.()
      } catch (abortError) {
        logAssistantDevEvent({
          event: 'assistant_run_stop_fallback',
          phase: 'error',
          trace_context: traceContext,
          payload: { reason },
          error: normalizeAssistantDevError(abortError),
        })
      }
    }
  }, [activeThread?.id, agent, basicRunInFlight, copilotkit, interactive])

  const toggleHistoryOpen = useCallback(() => {
    setHistoryOpen((current) => {
      const next = !current
      writeHistoryOpenPreference(next)
      return next
    })
  }, [])

  const loadThreads = useCallback(async () => {
    if (modeLoading) return
    if (!canShowAssistant()) return
    setLoadingThreads(true)
    setError(null)
    const traceContext = buildAssistantPanelTraceContext(null)
    logAssistantDevEvent({
      event: 'assistant_threads_load',
      phase: 'start',
      trace_context: traceContext,
      payload: { page_context: getAssistantPageContext() },
    })
    try {
      const demoAssistant = isAssistantDemoMode()
      let nextThreads =
        !demoAssistant && activeMode === 'advanced'
          ? await assistantAdvancedApi.listThreads()
          : await assistantApi.listThreads()
      if (nextThreads.length === 0 && !demoAssistant && (activeMode === 'advanced' || isAssistantInteractive())) {
        nextThreads = [
          activeMode === 'advanced'
            ? await assistantAdvancedApi.createThread('New ACM advanced assistant thread')
            : await assistantApi.createThread('New ACM assistant thread'),
        ]
      }
      setThreads(nextThreads)
      setActiveThread((current) => current ?? nextThreads[0] ?? null)
      logAssistantDevEvent({
        event: 'assistant_threads_load',
        phase: 'success',
        trace_context: buildAssistantPanelTraceContext(nextThreads[0]?.id),
        payload: { threads: nextThreads, default_selected_thread: nextThreads[0] ?? null },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assistant threads failed to load')
      logAssistantDevEvent({
        event: 'assistant_threads_load',
        phase: 'error',
        trace_context: traceContext,
        error: normalizeAssistantDevError(err),
      })
    } finally {
      setLoadingThreads(false)
    }
  }, [activeMode, modeLoading])

  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  useEffect(() => {
    if (activeMode !== 'basic') return
    if (basicRunInFlight) {
      const now = Date.now()
      assistantRunStartedAtRef.current = assistantRunStartedAtRef.current ?? now
      assistantRunLastProgressAtRef.current = assistantRunLastProgressAtRef.current ?? now
      return
    }

    assistantRunStartedAtRef.current = null
    assistantRunLastProgressAtRef.current = null
    assistantStopInProgressRef.current = false
  }, [activeMode, basicRunInFlight])

  useEffect(() => {
    if (activeMode !== 'basic') return
    if (!basicRunInFlight) return
    assistantRunLastProgressAtRef.current = Date.now()
  }, [activeMode, agent.messages, basicRunInFlight])

  useEffect(() => {
    if (activeMode !== 'basic') return
    if (!basicRunInFlight) return

    const intervalId = window.setInterval(() => {
      if (!basicRunInFlight || assistantStopInProgressRef.current) return

      const now = Date.now()
      const startedAt = assistantRunStartedAtRef.current ?? now
      const lastProgressAt = assistantRunLastProgressAtRef.current ?? startedAt
      const idleMs = now - lastProgressAt
      const totalMs = now - startedAt

      if (idleMs >= ASSISTANT_RUN_IDLE_WATCHDOG_MS) {
        logAssistantDevEvent({
          event: 'assistant_run_watchdog',
          phase: 'idle_timeout',
          trace_context: buildAssistantPanelTraceContext(activeThread?.id),
          payload: {
            idle_ms: idleMs,
            total_ms: totalMs,
            messages: agent.messages,
            state: agent.state,
          },
        })
        stopAssistantRun('watchdog_idle')
        return
      }

      if (totalMs >= ASSISTANT_RUN_HARD_WATCHDOG_MS) {
        logAssistantDevEvent({
          event: 'assistant_run_watchdog',
          phase: 'hard_timeout',
          trace_context: buildAssistantPanelTraceContext(activeThread?.id),
          payload: {
            idle_ms: idleMs,
            total_ms: totalMs,
            messages: agent.messages,
            state: agent.state,
          },
        })
        stopAssistantRun('watchdog_timeout')
      }
    }, ASSISTANT_RUN_WATCHDOG_POLL_MS)

    return () => window.clearInterval(intervalId)
  }, [activeMode, activeThread?.id, agent.messages, agent.state, basicRunInFlight, stopAssistantRun])

  useEffect(() => {
    const emptyMemory = createEmptyAssistantMemory()
    if (!activeThread) {
      setThreadContextLoading(false)
      setLoadedThreadContextId(null)
      setThreadHasPersistedMessages(false)
      setThreadMemory(emptyMemory)
      persistedMessageIds.current = new Set()
      setAdvancedMessages([])
      agent.setMessages([] )
      return
    }
    let cancelled = false
    setThreadContextLoading(true)
    setLoadedThreadContextId(null)
    setThreadHasPersistedMessages(false)
    setThreadMemory(emptyMemory)
    persistedMessageIds.current = new Set()
    setAdvancedMessages([])
    agent.setMessages([] )
    const initialPageContext = getAssistantPageContext()
    agent.setState({ ...(agent.state || {}), acm: buildAcmAgentState(activeThread.id, initialPageContext, emptyMemory) })
    if (!isAssistantDemoMode() && activeMode === 'advanced') {
      assistantAdvancedApi.getThread(activeThread.id)
        .then((context) => {
          if (cancelled) return
          const messages = (context?.messages ?? []).map(advancedMessageToAgentMessage)
          setThreadMemory(emptyMemory)
          setLoadedThreadContextId(activeThread.id)
          setThreadHasPersistedMessages(messages.length > 0)
          persistedMessageIds.current = new Set(messages.map((message) => message.id))
          setAdvancedMessages(messages)
        })
        .catch((err) => {
          if (cancelled) return
          setError(err instanceof Error ? err.message : 'Advanced assistant thread failed to load')
        })
        .finally(() => {
          if (!cancelled) setThreadContextLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
    logAssistantDevEvent({
      event: 'assistant_thread_context_load',
      phase: 'start',
      trace_context: buildAssistantPanelTraceContext(activeThread.id, null, initialPageContext),
      payload: {
        thread: activeThread,
        initial_page_context: initialPageContext,
        initial_memory: emptyMemory,
      },
    })
    assistantApi.getThreadContext(activeThread.id)
      .then((context) => {
        if (cancelled) return
        const messages = context.recent_events.map(eventToMessage).filter((message): message is AgentMessage => Boolean(message))
        const nextMemory = {
          summary: context.memory.summary ?? '',
          pinnedFacts: context.memory.pinned_facts_json ?? {},
        }
        setThreadMemory(nextMemory)
        setLoadedThreadContextId(activeThread.id)
        setThreadHasPersistedMessages(messages.length > 0)
        persistedMessageIds.current = new Set(messages.map((message) => message.id))
        agent.setMessages(removeGeneratedSystemMessages(messages) )
        const loadedPageContext = getAssistantPageContext()
        agent.setState({ ...(agent.state || {}), acm: buildAcmAgentState(activeThread.id, loadedPageContext, nextMemory) })
        logAssistantDevEvent({
          event: 'assistant_thread_context_load',
          phase: 'success',
          trace_context: buildAssistantPanelTraceContext(activeThread.id, null, loadedPageContext),
          payload: {
            context,
            restored_messages: messages,
            restored_messages_without_generated_system: removeGeneratedSystemMessages(messages),
            memory: nextMemory,
            page_context: loadedPageContext,
          },
        })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Assistant thread context failed to load')
        logAssistantDevEvent({
          event: 'assistant_thread_context_load',
          phase: 'error',
          trace_context: buildAssistantPanelTraceContext(activeThread.id),
          error: normalizeAssistantDevError(err),
        })
      })
      .finally(() => {
        if (!cancelled) setThreadContextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeMode, activeThread?.id])

  useEffect(() => {
    if (activeMode !== 'basic') return
    if (!interactive || !activeThread || basicRunInFlight) return
    const toPersist = ((agent.messages || []) as AgentMessage[])
      .filter((message) => message.role === 'assistant' || message.role === 'tool')
      .filter((message) => !persistedMessageIds.current.has(message.id))
      .filter((message) => !isLiveAssistantToolCallMessage(message))
      .filter((message) => messageContent(message))
    if (toPersist.length === 0) return
    toPersist.forEach((message) => persistedMessageIds.current.add(message.id))
    const eventsToPersist = toPersist.map((message) => {
      const content = messageContent(message)
      if (message.role === 'tool') {
        const toolName = messageToolName(message) ?? 'tool'
        return {
          role: 'assistant',
          event_type: 'tool_result',
          content: summarizeToolResult(content, toolName),
          tool_name: toolName,
          tool_result_json: tryParseJsonRecord(content),
        }
      }
      return {
        role: message.role,
        event_type: 'message',
        content,
      }
    })
    const traceContext = buildAssistantPanelTraceContext(activeThread.id)
    logAssistantDevEvent({
      event: 'assistant_persist_events',
      phase: 'request',
      trace_context: traceContext,
      payload: {
        thread: activeThread,
        source_messages: toPersist,
        events: eventsToPersist,
        agent_messages: agent.messages,
        agent_state: agent.state,
      },
    })
    void assistantApi.addEvents(activeThread.id, eventsToPersist)
      .then((persistedEvents) => {
        logAssistantDevEvent({
          event: 'assistant_persist_events',
          phase: 'success',
          trace_context: traceContext,
          payload: { persisted_events: persistedEvents },
        })
        return loadThreads()
      })
      .catch((err) => {
        logAssistantDevEvent({
          event: 'assistant_persist_events',
          phase: 'error',
          trace_context: traceContext,
          payload: { events: eventsToPersist },
          error: normalizeAssistantDevError(err),
        })
      })
  }, [activeThread?.id, agent.messages, basicRunInFlight, interactive, loadThreads])

  useEffect(() => {
    if (!assistantOpen) return
    logAssistantDevEvent({
      event: 'assistant_panel_opened',
      phase: 'open',
      trace_context: buildAssistantPanelTraceContext(activeThread?.id),
      payload: {
        active_thread: activeThread,
        threads,
        page_context: getAssistantPageContext(),
        memory: threadMemory,
        agent_messages: agent.messages,
        agent_state: agent.state,
      },
    })
    if (!interactive) return
    window.requestAnimationFrame(() => {
      document.getElementById('acm-assistant-composer')?.focus()
    })
  }, [assistantOpen, interactive])

  if (!canShowAssistant()) return null
  if (!assistantOpen) return null

  const createThread = async () => {
    setError(null)
    try {
      const created =
        activeMode === 'advanced'
          ? await assistantAdvancedApi.createThread('New ACM advanced assistant thread')
          : await assistantApi.createThread('New ACM assistant thread')
      setThreads((current) => [created, ...current])
      setThreadContextLoading(true)
      setLoadedThreadContextId(null)
      setActiveThread(created)
      setThreadMemory(createEmptyAssistantMemory())
      setPendingAdvancedToolRequest(null)
      setAdvancedMessages([])
      agent.setMessages([])
      persistedMessageIds.current = new Set()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Thread creation failed')
    }
  }

  const archiveThread = async () => {
    if (!activeThread) return
    setError(null)
    try {
      if (activeMode === 'advanced') {
        await assistantAdvancedApi.updateThread(activeThread.id, { archived: true })
      } else {
        await assistantApi.updateThread(activeThread.id, { archived: true })
      }
      const remaining = threads.filter((thread) => thread.id !== activeThread.id)
      const nextActiveThread = remaining[0] ?? null
      setThreads(remaining)
      setThreadContextLoading(Boolean(nextActiveThread))
      setLoadedThreadContextId(null)
      setThreadMemory(createEmptyAssistantMemory())
      setPendingAdvancedToolRequest(null)
      persistedMessageIds.current = new Set()
      setAdvancedMessages([])
      agent.setMessages([])
      setActiveThread(nextActiveThread)
      if (remaining.length === 0) await createThread()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Thread archive failed')
    }
  }

  const selectThread = (thread: AssistantThread) => {
    if (thread.id === activeThread?.id) return
    setError(null)
    setThreadContextLoading(true)
    setLoadedThreadContextId(null)
    setThreadMemory(createEmptyAssistantMemory())
    setPendingAdvancedToolRequest(null)
    persistedMessageIds.current = new Set()
    setAdvancedMessages([])
    agent.setMessages([])
    setActiveThread(thread)
  }

  const applyAdvancedToolResponse = (
    response: Awaited<ReturnType<typeof assistantAdvancedApi.postToolResult>>,
    fallbackThread: AssistantThread,
  ) => {
    const nextMessages = (response?.messages ?? []).map(advancedMessageToAgentMessage)
    const nextThread = response?.thread ?? fallbackThread
    persistedMessageIds.current = new Set(nextMessages.map((message) => message.id))
    setAdvancedMessages(nextMessages)
    setThreads((current) => {
      const rest = current.filter((thread) => thread.id !== nextThread.id)
      return [nextThread, ...rest]
    })
    setActiveThread(nextThread)
    setLoadedThreadContextId(nextThread.id)
  }

  const finishAdvancedToolRequest = async (decision: 'approved' | 'cancelled') => {
    if (!pendingAdvancedToolRequest || !activeThread) return
    const pending = pendingAdvancedToolRequest
    if (pending.threadId !== activeThread.id) {
      setPendingAdvancedToolRequest(null)
      return
    }
    setError(null)
    setAdvancedToolDecisionInProgress(true)
    writePendingAdvancedToolRequest(null)
    setPendingAdvancedToolRequest(null)
    try {
      const result =
        decision === 'approved'
          ? await runAdvancedWebsiteTool(
              pending.request.tool_name,
              { ...(pending.request.arguments ?? {}), ...(pending.request.tool_name.startsWith('apicostx_') ? { confirm: true } : {}) },
            )
          : buildCancelledAdvancedToolResult(pending.request)
      const toolResponse = await assistantAdvancedApi.postToolResult(activeThread.id, {
        request_id: pending.request.request_id,
        tool_name: pending.request.tool_name,
        result,
        page_context: getAssistantPageContext(),
      })
      let nextResponse = toolResponse
      let nextThread = nextResponse?.thread ?? activeThread
      let nextToolRequest = nextResponse.tool_request ?? null
      let toolHopCount = 0
      while (nextToolRequest && toolHopCount < ADVANCED_AUTO_TOOL_HOP_LIMIT) {
        if (nextToolRequest.requires_confirmation) {
          setPendingAdvancedToolRequest({
            threadId: nextThread.id,
            request: nextToolRequest,
          })
          break
        }
        toolHopCount += 1
        const followUpToolResult = await runAdvancedWebsiteTool(
          nextToolRequest.tool_name,
          nextToolRequest.arguments ?? {},
        )
        nextResponse = await assistantAdvancedApi.postToolResult(nextThread.id, {
          request_id: nextToolRequest.request_id,
          tool_name: nextToolRequest.tool_name,
          result: followUpToolResult,
          page_context: getAssistantPageContext(),
        })
        nextThread = nextResponse?.thread ?? nextThread
        nextToolRequest = nextResponse.tool_request ?? null
      }
      if (nextToolRequest && toolHopCount >= ADVANCED_AUTO_TOOL_HOP_LIMIT) {
        setError('Advanced assistant stopped after too many website tool steps. Please try a narrower request.')
      }
      applyAdvancedToolResponse(nextResponse, nextThread)
      await loadThreads()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Advanced assistant tool action failed')
    } finally {
      setAdvancedToolDecisionInProgress(false)
    }
  }

  const submit = async () => {
    const text = input.trim()
    if (!interactive || !text || !activeThread || !threadContextReady) return
    if (activeMode === 'advanced') {
      if (advancedSending) return
      clearLocalGreeting()
      setInput('')
      setError(null)
      setPendingAdvancedToolRequest(null)
      setAdvancedSending(true)
      const optimisticUserMessage: AgentMessage = {
        id: `advanced-local-user-${crypto.randomUUID()}`,
        role: 'user',
        content: text,
      }
      const optimisticMessages = [
        ...removeGeneratedSystemMessages(advancedMessages),
        optimisticUserMessage,
      ]
      const scrollHeightBeforeUserMessage = messagesScrollRef.current?.scrollHeight ?? 0
      stickToBottomRef.current = true
      setAdvancedMessages(optimisticMessages)
      scrollForAppendedContent(scrollHeightBeforeUserMessage)
      setAssistantReplyPending(true)
      try {
        const response = await assistantAdvancedApi.postMessage(
          activeThread.id,
          text,
          getAssistantPageContext(),
        )
        let nextMessages = (response?.messages ?? []).map(advancedMessageToAgentMessage)
        let nextThread = response?.thread ?? activeThread
        let nextToolRequest = response.tool_request ?? null
        let toolHopCount = 0
        while (nextToolRequest && toolHopCount < ADVANCED_AUTO_TOOL_HOP_LIMIT) {
          if (nextToolRequest.requires_confirmation) {
            setPendingAdvancedToolRequest({
              threadId: activeThread.id,
              request: nextToolRequest,
            })
            break
          }
          toolHopCount += 1
          const toolResult = await runAdvancedWebsiteTool(
            nextToolRequest.tool_name,
            nextToolRequest.arguments ?? {},
          )
          const toolResponse = await assistantAdvancedApi.postToolResult(activeThread.id, {
            request_id: nextToolRequest.request_id,
            tool_name: nextToolRequest.tool_name,
            result: toolResult,
            page_context: getAssistantPageContext(),
          })
          nextMessages = (toolResponse?.messages ?? nextMessages).map(advancedMessageToAgentMessage)
          nextThread = toolResponse?.thread ?? nextThread
          nextToolRequest = toolResponse.tool_request ?? null
        }
        if (nextToolRequest && toolHopCount >= ADVANCED_AUTO_TOOL_HOP_LIMIT) {
          setError('Advanced assistant stopped after too many website tool steps. Please try a narrower request.')
        }
        persistedMessageIds.current = new Set(nextMessages.map((message) => message.id))
        setAdvancedMessages(nextMessages)
        setThreads((current) => {
          const rest = current.filter((thread) => thread.id !== nextThread.id)
          return [nextThread, ...rest]
        })
        setActiveThread(nextThread)
        setLoadedThreadContextId(nextThread.id)
        await loadThreads()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Advanced assistant message failed')
      } finally {
        setAdvancedSending(false)
        setAssistantReplyPending(false)
      }
      return
    }
    if (!copilotkit || basicRunInFlight) return
    if (assistantRunInFlightRef.current) {
      logAssistantDevEvent({
        event: 'assistant_run_stale_guard_recovered',
        phase: 'recovered',
        trace_context: buildAssistantPanelTraceContext(activeThread.id),
        payload: {
          reason: 'The UI was idle while the synchronous duplicate-submit guard remained set.',
        },
      })
      assistantRunInFlightRef.current = false
    }
    clearLocalGreeting()
    setInput('')
    setError(null)
    const assistantRunId = createAssistantDevTraceId('assistant-run')
    const pageContext = getAssistantPageContext()
    const traceContext = buildAssistantPanelTraceContext(activeThread.id, assistantRunId, pageContext)
    const userMessage: AgentMessage = { id: crypto.randomUUID(), role: 'user', content: text }
    const systemMessage: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'system',
      content: buildAssistantKnowledgeSystemMessage({
        threadId: activeThread.id,
        pageContext,
        memorySummary: threadMemory.summary,
        pinnedFacts: threadMemory.pinnedFacts,
      }),
    }
    assistantRunInFlightRef.current = true
    setBasicRunInFlight(true)
    persistedMessageIds.current.add(userMessage.id)
    const repairedHistory = repairOrphanedAgentToolMessages((agent.messages || []) as AgentMessage[])
    const existingMessages = removeGeneratedSystemMessages(repairedHistory.messages)
    const nextMessages = [...existingMessages, systemMessage, userMessage]
    const nextAcmState = buildAcmAgentState(activeThread.id, pageContext, threadMemory)
    const nextAgentState = { ...(agent.state || {}), acm: nextAcmState }
    logAssistantDevEvent({
      event: 'assistant_submit',
      phase: 'prepared',
      trace_context: traceContext,
      payload: {
        input_text: text,
        thread: activeThread,
        page_context: pageContext,
        memory: threadMemory,
        existing_messages: existingMessages,
        generated_system_message: systemMessage,
        user_message: userMessage,
        next_messages: nextMessages,
        previous_agent_messages: agent.messages,
        repaired_history: {
          dropped_assistant_tool_calls: repairedHistory.droppedAssistantCalls,
          dropped_tool_results: repairedHistory.droppedToolResults,
        },
        previous_agent_state: agent.state,
        next_agent_state: nextAgentState,
      },
    })
    const scrollHeightBeforeUserMessage = messagesScrollRef.current?.scrollHeight ?? 0
    stickToBottomRef.current = true
    agent.setMessages(nextMessages )
    agent.setState(nextAgentState)
    scrollForAppendedContent(scrollHeightBeforeUserMessage)
    try {
      const userEvents = [{ role: 'user', event_type: 'message', content: text }]
      logAssistantDevEvent({
        event: 'assistant_submit_user_event_persist',
        phase: 'request',
        trace_context: traceContext,
        payload: { thread: activeThread, events: userEvents },
      })
      const persistedUserEvents = await assistantApi.addEvents(activeThread.id, userEvents)
      logAssistantDevEvent({
        event: 'assistant_submit_user_event_persist',
        phase: 'success',
        trace_context: traceContext,
        payload: { persisted_events: persistedUserEvents },
      })
      setAssistantReplyPending(true)
      logAssistantDevEvent({
        event: 'assistant_run_agent',
        phase: 'start',
        trace_context: traceContext,
        payload: {
          thread: activeThread,
          page_context: pageContext,
          messages: nextMessages,
          state: nextAgentState,
        },
      })
      await copilotkit.runAgent({ agent })
      logAssistantDevEvent({
        event: 'assistant_run_agent',
        phase: 'success',
        trace_context: traceContext,
        payload: {
          thread: activeThread,
          agent_messages: agent.messages,
          agent_state: agent.state,
          visible_messages: visibleMessages,
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assistant run failed')
      logAssistantDevEvent({
        event: 'assistant_run_agent',
        phase: 'error',
        trace_context: traceContext,
        payload: {
          thread: activeThread,
          page_context: pageContext,
          messages: nextMessages,
          state: nextAgentState,
        },
        error: normalizeAssistantDevError(err),
      })
    } finally {
      assistantRunInFlightRef.current = false
      setBasicRunInFlight(false)
      setAssistantReplyPending(false)
      setLoadedThreadContextId(activeThread.id)
      setThreadContextLoading(false)
      setComposerReleasedThreadId(activeThread.id)
      logAssistantDevEvent({
        event: 'assistant_run_ui_release',
        phase: 'released',
        trace_context: traceContext,
        payload: { active_thread_id: activeThread.id },
      })
      void agent.detachActiveRun?.().catch((detachError) => {
        logAssistantDevEvent({
          event: 'assistant_run_detach',
          phase: 'error',
          trace_context: traceContext,
          error: normalizeAssistantDevError(detachError),
        })
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {interactive ? (
        <AdvancedWebsiteToolBridge
          enabled={assistantOpen && activeMode === 'advanced'}
          getPageContext={getPageContext}
        />
      ) : null}
      {interactive && activeMode === 'basic' ? (
        <AssistantCopilotHooks
          enabled={assistantOpen}
          getPageContext={getPageContext}
          threadId={activeThread?.id ?? null}
          pageContext={assistantPageContext}
          memorySummary={threadMemory.summary}
          pinnedFacts={threadMemory.pinnedFacts}
        />
      ) : null}
      <Panel
        surface="panel"
        variant="raised"
        aria-label="ACM assistant"
        className="relative grid h-full w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-none border-0 p-0 shadow-none"
      >
        <PanelHeader
          className="flex min-w-0 items-center justify-between gap-2 border-b border-border"
          style={{ paddingInline: '0.5rem', paddingBlock: '0.375rem' }}
        >
          <div className="inline-flex rounded-md border border-border bg-background/40 p-0.5" aria-label="Allie assistant">
            <span className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
              Allie
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 px-0"
              style={ASSISTANT_HEADER_ICON_BUTTON_STYLE}
              aria-label="New conversation"
              icon={<Plus className="w-3.5 h-3.5" />}
              disabled={!interactive || modeLoading || advancedSending || basicRunInFlight}
              onClick={() => void createThread()}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 px-0"
              style={ASSISTANT_HEADER_ICON_BUTTON_STYLE}
              aria-label={historyOpen ? 'Hide conversation history' : 'Show conversation history'}
              aria-pressed={historyOpen}
              onClick={toggleHistoryOpen}
            >
              {historyOpen ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeftOpen className="w-3.5 h-3.5" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 px-0"
              style={ASSISTANT_HEADER_ICON_BUTTON_STYLE}
              disabled={!interactive || !activeThread || modeLoading || advancedSending}
              aria-label="Archive thread"
              onClick={() => void archiveThread()}
            >
              <Archive className="w-3.5 h-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 px-0"
              style={ASSISTANT_HEADER_ICON_BUTTON_STYLE}
              aria-label="Close assistant"
              onClick={closeAssistant}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </PanelHeader>

        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto_auto]">
          <PanelBody className="flex min-h-0 flex-1 flex-col p-0" style={{ padding: 0, minHeight: 0 }}>
            <div
              ref={messagesScrollRef}
              onScroll={handleMessagesScroll}
              className="flex min-h-0 flex-1 flex-col gap-[0.75lh] overflow-x-hidden overflow-y-auto"
              style={{ padding: '0.375rem 0.25rem', paddingBottom: ASSISTANT_MESSAGES_BOTTOM_PAD }}
            >
            {error ? (
              <Callout variant="danger" className="px-2 py-1.5 text-xs">
                {error}
              </Callout>
            ) : null}
            {visibleMessages.length === 0 && !localGreeting && !threadContextLoading ? (
              <EmptyState
                className="p-2 text-xs"
                title={activeMode === 'advanced' ? 'Advanced scaffold is ready' : 'Start a conversation'}
                body={
                  activeMode === 'advanced'
                    ? 'Advanced mode already routes to the new backend shell. Messages are stored separately while the real operator is still being built.'
                    : 'Ask ACM to inspect presets, run a preset, or read your run logs.'
                }
              />
            ) : displayMessages.length > 0 ? (
              displayMessages.map((message) => {
                const content = displayMessageContent(message)
                const messageClass = cn(
                  'acm2-assistant-message min-w-0 w-full max-w-full text-xs leading-snug',
                  message.role === 'user' && 'text-info',
                  message.role === 'assistant' && 'text-foreground',
                  message.role === 'tool' && 'text-[11px] text-muted-foreground',
                )

                if (message.role === 'assistant') {
                  const isActiveGreeting = localGreeting?.id === message.id
                  const isLastDisplayMessage = message.id === lastDisplayMessageId
                  const isMascotAnchorMessage =
                    isLastDisplayMessage &&
                    message.id === latestAssistantMessageId &&
                    (assistantMessageHasDisplayContent(message) || isActiveGreeting)
                  const isMascotVisible =
                    isLastDisplayMessage &&
                    message.id === chatMascotMessageId &&
                    (assistantMessageHasDisplayContent(message) || isActiveGreeting)
                  const shouldLeadText =
                    message.id === enteringMascotMessageId && isMascotVisible && isActiveGreeting
                  return (
                    <div
                      key={message.id}
                      className={cn(messageClass, isMascotAnchorMessage && 'flow-root')}
                      style={
                        isMascotAnchorMessage
                          ? {
                              paddingTop: `max(0px, calc(${ASSISTANT_MASCOT_CAP_WIDTH} - 1lh))`,
                              minHeight: ASSISTANT_MASCOT_CAP_WIDTH,
                            }
                          : undefined
                      }
                    >
                      {isMascotAnchorMessage ? (
                        <button
                          type="button"
                          className="relative float-left mr-[0.35lh] shrink-0 cursor-pointer border-0 bg-transparent p-0"
                          style={{ width: ASSISTANT_MASCOT_CAP_WIDTH, height: ASSISTANT_MASCOT_CAP_WIDTH }}
                          aria-label="Close chat"
                          onClick={closeAssistant}
                        >
                          <img
                            src={chatMascotImageUrl}
                            alt=""
                            aria-hidden="true"
                            className={cn(
                              'acm2-allie-chat-mascot pointer-events-none absolute bottom-0 left-0 w-full aspect-square object-contain',
                              isMascotVisible && 'acm2-allie-chat-mascot--visible',
                              isMascotVisible && message.id === enteringMascotMessageId && 'acm2-allie-chat-mascot--enter',
                            )}
                          />
                        </button>
                      ) : null}
                      <span
                        className={cn(
                          'acm2-assistant-message-text',
                          shouldLeadText && 'acm2-assistant-text--mascot-leads',
                        )}
                      >
                        {content}
                      </span>
                    </div>
                  )
                }

                return (
                  <div key={message.id} className={messageClass}>
                    {content}
                  </div>
                )
              })
            ) : null}
            {showAssistantThinking ? (
              <div
                className="acm2-assistant-message flex min-h-[2.75lh] items-end gap-[0.35lh] text-xs leading-snug text-muted-foreground"
                aria-live="polite"
              >
                <span
                  className="relative h-[1.25lh] w-[1.25lh] shrink-0"
                  aria-hidden="true"
                >
                  <img
                    src={thinkingMascotImageUrl}
                    alt=""
                    aria-hidden="true"
                    className="acm2-allie-chat-mascot acm2-allie-chat-mascot--visible absolute bottom-0 left-0 h-full w-full object-contain"
                  />
                </span>
                <span>Allie is thinking…</span>
              </div>
            ) : null}
            {displayMessages.length > 0 ? (
              <div
                aria-hidden="true"
                className="w-full shrink-0"
                style={{ minHeight: ASSISTANT_REPLY_ZONE_HEIGHT }}
                data-acm-assistant-reply-well=""
              />
            ) : null}
            </div>
          </PanelBody>

          {activeMode === 'advanced' && pendingAdvancedToolRequest ? (
            <div className="border-t border-border p-2">
              <Callout variant="warning" className="px-2 py-2 text-xs">
                <div className="font-semibold text-foreground">Confirm website action</div>
                <div className="mt-1 text-muted-foreground">
                  Advanced mode wants to run <span className="font-mono">{pendingAdvancedToolRequest.request.tool_name}</span>.
                  This uses the visible logged-in website page and will not expose browser tokens or database keys to LangGraph.
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    variant="success"
                    size="sm"
                    className="h-7"
                    loading={advancedToolDecisionInProgress}
                    disabled={advancedToolDecisionInProgress || advancedSending}
                    onClick={() => void finishAdvancedToolRequest('approved')}
                  >
                    Approve and run
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={advancedToolDecisionInProgress || advancedSending}
                    onClick={() => void finishAdvancedToolRequest('cancelled')}
                  >
                    Cancel
                  </Button>
                </div>
              </Callout>
            </div>
          ) : null}

          <form
            className="flex min-w-0 items-center gap-1.5 border-t border-border p-2"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <Input
              id="acm-assistant-composer"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                interactive
                  ? activeMode === 'advanced'
                    ? 'Ask the advanced assistant shell...'
                    : 'Ask ACM...'
                  : 'Sign in to chat with ACM'
              }
              disabled={composerDisabled}
              readOnly={!interactive}
              className="min-w-0 flex-1 text-xs"
            />
            {voiceStatusText ? (
              <div
                className={cn(
                  'acm2-assistant-voice-status hidden shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] sm:inline-flex',
                  voiceRecording ? 'acm2-assistant-voice-status--recording' : 'acm2-assistant-voice-status--transcribing'
                )}
                role="status"
                aria-live="polite"
              >
                <span className="acm2-assistant-voice-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                {voiceStatusText}
              </div>
            ) : null}
            <Button
              type="button"
              variant={voiceRecording ? 'danger' : 'ghost'}
              size="sm"
              className={cn(
                'h-7 w-7 shrink-0 px-0',
                voiceRecording ? 'acm2-assistant-voice-button--recording' : '',
                voiceTranscribing ? 'acm2-assistant-voice-button--transcribing' : ''
              )}
              style={voiceRecording ? undefined : ASSISTANT_HEADER_ICON_BUTTON_STYLE}
              disabled={voiceDisabled}
              loading={voiceTranscribing}
              icon={voiceRecording ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              aria-label={
                voiceRecording
                  ? 'Stop voice input'
                  : voiceTranscribing
                    ? 'Transcribing voice input'
                    : voiceSupported
                      ? 'Start voice input'
                      : 'Voice input is not supported'
              }
              aria-pressed={voiceRecording}
              onClick={() => void toggleVoiceRecording()}
            />
            <Button
              type={activeMode === 'basic' && basicRunInFlight ? 'button' : 'submit'}
              variant={activeMode === 'basic' && basicRunInFlight ? 'danger' : 'primary'}
              size="sm"
              className="acx-assistant-send-button h-7 w-7 shrink-0 px-0"
              disabled={activeMode === 'basic' && basicRunInFlight ? false : composerDisabled || voiceBusy || !input.trim()}
              icon={activeMode === 'basic' && basicRunInFlight ? <X className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
              aria-label={activeMode === 'basic' && basicRunInFlight ? 'Stop assistant run' : 'Send message'}
              onClick={activeMode === 'basic' && basicRunInFlight ? () => stopAssistantRun('manual') : undefined}
            />
          </form>

          {historyOpen ? (
            <div className="flex min-h-0 flex-col border-t border-border bg-secondary/30">
              <div className="flex items-center justify-between gap-1 px-2 py-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {activeMode === 'advanced' ? 'Advanced conversations' : 'Conversations'}
                </span>
                {loadingThreads ? <Button variant="ghost" size="sm" loading disabled className="min-w-7 px-1" aria-label="Loading threads" /> : null}
              </div>
              <div className="flex max-h-32 min-h-0 flex-col gap-1 overflow-y-auto px-1.5 pb-1.5">
                {threads.map((thread) => {
                  const active = thread.id === activeThread?.id
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className={cn(
                        'acx-filter-chip w-full rounded-md px-1.5 py-1.5 text-left text-[11px]',
                        active ? 'acx-filter-chip--active' : 'acx-filter-chip--off',
                      )}
                      onClick={() => selectThread(thread)}
                    >
                      <span className="block truncate">{thread.title}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  )
}
