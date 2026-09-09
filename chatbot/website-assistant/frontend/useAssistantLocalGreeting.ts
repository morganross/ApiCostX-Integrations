import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ASSISTANT_LOCAL_GREETING,
  buildLocalGreetingMessageId,
} from './assistantGreeting'

export type LocalGreetingMessage = {
  id: string
  role: 'assistant'
  content: string
  isComplete: boolean
}

/** Delay before typewriter starts so the owl can lead the text by ~1ms. */
const OWL_LEAD_DELAY_MS = 1
const TYPEWRITER_CHARS_PER_TICK = 2
const TYPEWRITER_TICK_MS = 18

type UseAssistantLocalGreetingParams = {
  assistantOpen: boolean
  threadContextReady: boolean
  /** True once thread context has loaded and the thread already has stored messages. */
  threadHasPersistedMessages: boolean
  activeThreadId: string | null
  interactive: boolean
}

export function useAssistantLocalGreeting({
  assistantOpen,
  threadContextReady,
  threadHasPersistedMessages,
  activeThreadId,
  interactive,
}: UseAssistantLocalGreetingParams) {
  const [greeting, setGreeting] = useState<LocalGreetingMessage | null>(null)
  const startedForThreadRef = useRef<string | null>(null)
  const typewriterTimeoutRef = useRef(0)

  const clearTypewriter = useCallback(() => {
    if (typewriterTimeoutRef.current) {
      window.clearTimeout(typewriterTimeoutRef.current)
      typewriterTimeoutRef.current = 0
    }
  }, [])

  const clearGreeting = useCallback(() => {
    clearTypewriter()
    startedForThreadRef.current = null
    setGreeting(null)
  }, [clearTypewriter])

  useEffect(() => {
    clearTypewriter()
    setGreeting(null)
    startedForThreadRef.current = null
  }, [activeThreadId, clearTypewriter])

  useEffect(() => {
    if (!assistantOpen) {
      clearTypewriter()
      startedForThreadRef.current = null
      setGreeting(null)
      return
    }

    if (
      !interactive ||
      !threadContextReady ||
      !activeThreadId ||
      threadHasPersistedMessages
    ) {
      return
    }

    if (startedForThreadRef.current === activeThreadId) {
      return
    }

    startedForThreadRef.current = activeThreadId
    const greetingId = buildLocalGreetingMessageId(activeThreadId)
    const fullText = ASSISTANT_LOCAL_GREETING
    let index = 0

    setGreeting({
      id: greetingId,
      role: 'assistant',
      content: '',
      isComplete: false,
    })

    const tick = () => {
      index = Math.min(index + TYPEWRITER_CHARS_PER_TICK, fullText.length)
      setGreeting({
        id: greetingId,
        role: 'assistant',
        content: fullText.slice(0, index),
        isComplete: index >= fullText.length,
      })
      if (index < fullText.length) {
        typewriterTimeoutRef.current = window.setTimeout(tick, TYPEWRITER_TICK_MS)
      }
    }

    typewriterTimeoutRef.current = window.setTimeout(tick, OWL_LEAD_DELAY_MS)

    return () => {
      clearTypewriter()
    }
  }, [
    activeThreadId,
    assistantOpen,
    clearTypewriter,
    interactive,
    threadContextReady,
    threadHasPersistedMessages,
  ])

  useEffect(() => () => clearTypewriter(), [clearTypewriter])

  return { greeting, clearGreeting }
}
