import {
  ALLIE_MASCOT_DEFAULT_EXPRESSION,
  type AllieMascotExpression,
} from '@/assets/allieMascotExpressions'

export type AllieMascotToolSignal = {
  toolName?: string
  content?: string
}

export type AllieMascotEmotionInput = {
  assistantText?: string
  toolSignals?: AllieMascotToolSignal[]
  pendingToolRequest?: boolean
  isThinking?: boolean
}

type AllieMascotMoodInput = {
  rawExpression: AllieMascotExpression
  previousExpression: AllieMascotExpression
  repeatedCount: number
}

type AllieMascotMoodResult = {
  expression: AllieMascotExpression
  repeatedCount: number
}

const EXCITED_TEXT_PATTERNS = [
  /\b(done|created|saved|complete|completed|success|successful|ready|runnable|verified|found|great|excellent)\b/i,
  /\bI found\b/i,
  /\bI created\b/i,
  /\bI saved\b/i,
]

const SAD_TEXT_PATTERNS = [
  /\b(sorry|failed|failure|could not|can't|cannot|unable|blocked|missing|unavailable|not available)\b/i,
  /\bno .*found\b/i,
]

const ANGRY_TEXT_PATTERNS = [
  /\b(traceback|exception|crash|crashed|fatal|invalid|corrupt|stuck|loop|too many)\b/i,
  /\bworker_crash\b/i,
]

const CONFUSED_TEXT_PATTERNS = [
  /\b(confused|not sure|unclear|which|what do you want|choose|provide|need more|current .* null)\b/i,
  /\bI don't know\b/i,
]

const WINK_TEXT_PATTERNS = [
  /\b(optional|if you want|your choice|recommend|next step)\b/i,
]

const SUCCESS_STATUSES = new Set(['ok', 'success', 'successful', 'complete', 'completed', 'ready', 'saved', 'created'])
const ERROR_STATUSES = new Set(['error', 'failed', 'failure', 'unavailable', 'blocked', 'cancelled', 'invalid'])

export function resolveAllieMascotExpression(input: AllieMascotEmotionInput): AllieMascotExpression {
  if (input.isThinking) return 'lookRight'
  if (input.pendingToolRequest) return 'turnRight'

  const toolExpression = resolveToolExpression(input.toolSignals ?? [])
  if (toolExpression) return toolExpression

  return resolveTextExpression(input.assistantText ?? '')
}

export function reduceAllieMascotMood({
  rawExpression,
  previousExpression,
  repeatedCount,
}: AllieMascotMoodInput): AllieMascotMoodResult {
  const nextRepeatedCount = rawExpression === previousExpression ? repeatedCount + 1 : 1

  if (rawExpression === 'sad' && previousExpression === 'sad' && nextRepeatedCount >= 2) {
    return { expression: 'angry', repeatedCount: nextRepeatedCount }
  }
  if (rawExpression === 'confused' && previousExpression === 'confused' && nextRepeatedCount >= 2) {
    return { expression: 'sad', repeatedCount: nextRepeatedCount }
  }
  if (rawExpression === 'angry' && previousExpression === 'angry' && nextRepeatedCount >= 2) {
    return { expression: 'confused', repeatedCount: nextRepeatedCount }
  }

  return { expression: rawExpression, repeatedCount: nextRepeatedCount }
}

function resolveToolExpression(toolSignals: AllieMascotToolSignal[]): AllieMascotExpression | null {
  for (let index = toolSignals.length - 1; index >= 0; index -= 1) {
    const signal = toolSignals[index]
    const content = signal?.content?.trim()
    if (!content) continue

    const parsed = tryParseJsonRecord(content)
    if (parsed) {
      const expression = resolveJsonToolExpression(parsed)
      if (expression) return expression
    }

    const textExpression = resolveToolTextExpression(content)
    if (textExpression) return textExpression
  }

  return null
}

function resolveJsonToolExpression(value: Record<string, unknown>): AllieMascotExpression | null {
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : ''
  const severity = typeof value.severity === 'string' ? value.severity.toLowerCase() : ''
  const error = typeof value.error === 'string' ? value.error : ''
  const message = typeof value.message === 'string' ? value.message : ''
  const failureType = typeof value.failure_type === 'string' ? value.failure_type : ''

  if (status && ERROR_STATUSES.has(status)) return status === 'cancelled' ? 'sad' : 'angry'
  if (severity === 'error') return 'angry'
  if (error || failureType) return /unavailable|missing|not found/i.test(`${error} ${failureType}`) ? 'confused' : 'angry'
  if (Array.isArray(value.top_errors) && value.top_errors.length > 0) return 'angry'
  if (Array.isArray(value.errors) && value.errors.length > 0) return 'angry'
  if (value.cancelled === true) return 'sad'
  if (value.runnable === false) return 'confused'
  if (value.ok === false) return 'sad'
  if (value.ok === true) return 'excited'
  if (status && SUCCESS_STATUSES.has(status)) return 'excited'
  if (/unavailable|missing|not found|no .*selected/i.test(message)) return 'confused'
  if (/created|saved|complete|completed|success|verified|runnable/i.test(message)) return 'excited'

  return null
}

function resolveToolTextExpression(content: string): AllieMascotExpression | null {
  if (/\b(traceback|exception|worker_crash|failed|failure|fatal|crash)\b/i.test(content)) return 'angry'
  if (/\b(unavailable|missing|not found|current_run_id.*null|no .*selected)\b/i.test(content)) return 'confused'
  if (/\b(cancelled|canceled)\b/i.test(content)) return 'sad'
  if (/\b(created|saved|completed|success|successful|verified|runnable)\b/i.test(content)) return 'excited'
  return null
}

function resolveTextExpression(content: string): AllieMascotExpression {
  const text = content.trim()
  if (!text) return ALLIE_MASCOT_DEFAULT_EXPRESSION

  if (matchesAny(text, ANGRY_TEXT_PATTERNS)) return 'angry'
  if (matchesAny(text, CONFUSED_TEXT_PATTERNS)) return 'confused'
  if (matchesAny(text, SAD_TEXT_PATTERNS)) return 'sad'
  if (matchesAny(text, EXCITED_TEXT_PATTERNS)) return 'excited'
  if (matchesAny(text, WINK_TEXT_PATTERNS)) return 'wink'

  return ALLIE_MASCOT_DEFAULT_EXPRESSION
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function tryParseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
