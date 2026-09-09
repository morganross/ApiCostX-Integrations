import { useCallback, useEffect, useRef, useState, type PointerEventHandler } from 'react'

const STORAGE_KEY = 'acm2-assistant-dock-width'
const DEFAULT_WIDTH_PX = 352
const MIN_WIDTH_PX = 256
/** Soft cap; viewport minus nav and main minimum is the practical limit. */
const MAX_WIDTH_PX = 1280
const MAIN_CONTENT_MIN_PX = 200

function readStoredAssistantDockWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_WIDTH_PX
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return DEFAULT_WIDTH_PX
    }
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) {
      return DEFAULT_WIDTH_PX
    }
    return Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, parsed))
  } catch {
    return DEFAULT_WIDTH_PX
  }
}

function writeStoredAssistantDockWidth(widthPx: number): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, String(widthPx))
  } catch {
    // Preference storage is non-critical.
  }
}

function clampAssistantDockWidth(widthPx: number, navWidthPx: number): number {
  if (typeof window === 'undefined') {
    return Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, widthPx))
  }
  const viewportMax = Math.max(
    MIN_WIDTH_PX,
    window.innerWidth - navWidthPx - MAIN_CONTENT_MIN_PX,
  )
  const maxWidth = Math.min(MAX_WIDTH_PX, viewportMax)
  return Math.min(maxWidth, Math.max(MIN_WIDTH_PX, widthPx))
}

type UseAssistantDockWidthParams = {
  enabled: boolean
  navWidthPx: number
}

export function useAssistantDockWidth({ enabled, navWidthPx }: UseAssistantDockWidthParams) {
  const [widthPx, setWidthPx] = useState(readStoredAssistantDockWidth)
  const [isResizing, setIsResizing] = useState(false)
  const resizeSessionRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    setWidthPx((current) => clampAssistantDockWidth(current, navWidthPx))
  }, [navWidthPx])

  useEffect(() => {
    if (!enabled || isResizing) {
      return
    }
    const handleResize = () => {
      setWidthPx((current) => clampAssistantDockWidth(current, navWidthPx))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [enabled, isResizing, navWidthPx])

  const onResizePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (!enabled || event.button !== 0) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      resizeSessionRef.current = { startX: event.clientX, startWidth: widthPx }
      setIsResizing(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [enabled, widthPx],
  )

  useEffect(() => {
    if (!isResizing) {
      return
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent) => {
      const session = resizeSessionRef.current
      if (!session) {
        return
      }
      const delta = event.clientX - session.startX
      setWidthPx(clampAssistantDockWidth(session.startWidth + delta, navWidthPx))
    }

    const finishResize = () => {
      setIsResizing(false)
      resizeSessionRef.current = null
      setWidthPx((current) => {
        const clamped = clampAssistantDockWidth(current, navWidthPx)
        writeStoredAssistantDockWidth(clamped)
        return clamped
      })
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
    }
  }, [isResizing, navWidthPx])

  return {
    widthPx,
    maxWidthPx: clampAssistantDockWidth(MAX_WIDTH_PX, navWidthPx),
    isResizing,
    onResizePointerDown,
  }
}
