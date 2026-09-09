import { useEffect, useRef, useState } from 'react'
import {
  ALLIE_MASCOT_IDLE_EXPRESSIONS,
  type AllieMascotExpression,
} from '@/assets/allieMascotExpressions'

const ALLIE_MASCOT_IDLE_MIN_DELAY_MS = 15_000
const ALLIE_MASCOT_IDLE_MAX_DELAY_MS = 50_000
const ALLIE_MASCOT_IDLE_HOLD_MS = 1_000

type UseAllieMascotIdleExpressionOptions = {
  baseExpression: AllieMascotExpression
  enabled: boolean
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function randomIdleDelayMs(): number {
  const range = ALLIE_MASCOT_IDLE_MAX_DELAY_MS - ALLIE_MASCOT_IDLE_MIN_DELAY_MS
  return ALLIE_MASCOT_IDLE_MIN_DELAY_MS + Math.round(Math.random() * range)
}

export function useAllieMascotIdleExpression({
  baseExpression,
  enabled,
}: UseAllieMascotIdleExpressionOptions): AllieMascotExpression {
  const [idleExpression, setIdleExpression] = useState<AllieMascotExpression | null>(null)
  const idleExpressionIndexRef = useRef(0)

  useEffect(() => {
    setIdleExpression(null)
    if (!enabled || prefersReducedMotion()) {
      return
    }

    let delayTimeoutId = 0
    let holdTimeoutId = 0
    let cancelled = false

    const scheduleNextIdle = () => {
      delayTimeoutId = window.setTimeout(() => {
        if (cancelled) return
        const idleCandidates = ALLIE_MASCOT_IDLE_EXPRESSIONS.filter((expression) => expression !== baseExpression)
        const nextExpression =
          idleCandidates[idleExpressionIndexRef.current % idleCandidates.length] ??
          ALLIE_MASCOT_IDLE_EXPRESSIONS[idleExpressionIndexRef.current % ALLIE_MASCOT_IDLE_EXPRESSIONS.length] ??
          baseExpression

        idleExpressionIndexRef.current += 1
        setIdleExpression(nextExpression)

        holdTimeoutId = window.setTimeout(() => {
          if (cancelled) return
          setIdleExpression(null)
          scheduleNextIdle()
        }, ALLIE_MASCOT_IDLE_HOLD_MS)
      }, randomIdleDelayMs())
    }

    scheduleNextIdle()

    return () => {
      cancelled = true
      window.clearTimeout(delayTimeoutId)
      window.clearTimeout(holdTimeoutId)
      setIdleExpression(null)
    }
  }, [baseExpression, enabled])

  return idleExpression ?? baseExpression
}
