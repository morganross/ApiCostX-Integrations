import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const OPEN_STORAGE_KEY = 'acm2-assistant-open'

function readAssistantOpenPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(OPEN_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeAssistantOpenPreference(open: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0')
  } catch {
    // Preference storage is non-critical.
  }
}

type AssistantChromeContextValue = {
  assistantOpen: boolean
  isCompactNav: boolean
  toggleAssistant: () => void
  openAssistant: () => void
  closeAssistant: () => void
}

const AssistantChromeContext = createContext<AssistantChromeContextValue | null>(null)

export function AssistantChromeProvider({
  children,
  isCompactNav,
  onOpenAssistant,
}: {
  children: ReactNode
  isCompactNav: boolean
  onOpenAssistant?: () => void
}) {
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpenPreference)

  const setOpen = useCallback(
    (next: boolean) => {
      setAssistantOpen(next)
      writeAssistantOpenPreference(next)
    },
    [],
  )

  const openAssistant = useCallback(() => {
    onOpenAssistant?.()
    setOpen(true)
  }, [onOpenAssistant, setOpen])

  const closeAssistant = useCallback(() => {
    setOpen(false)
    window.requestAnimationFrame(() => {
      document.getElementById('acm2-assistant-nav-toggle')?.focus()
    })
  }, [setOpen])

  const toggleAssistant = useCallback(() => {
    if (assistantOpen) {
      closeAssistant()
      return
    }
    openAssistant()
  }, [assistantOpen, closeAssistant, openAssistant])

  useEffect(() => {
    if (!assistantOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAssistant()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [assistantOpen, closeAssistant])

  const value = useMemo(
    () => ({
      assistantOpen,
      isCompactNav,
      toggleAssistant,
      openAssistant,
      closeAssistant,
    }),
    [assistantOpen, closeAssistant, isCompactNav, openAssistant, toggleAssistant],
  )

  return <AssistantChromeContext.Provider value={value}>{children}</AssistantChromeContext.Provider>
}

export function useAssistantChrome(): AssistantChromeContextValue {
  const context = useContext(AssistantChromeContext)
  if (!context) {
    throw new Error('useAssistantChrome must be used within AssistantChromeProvider')
  }
  return context
}
