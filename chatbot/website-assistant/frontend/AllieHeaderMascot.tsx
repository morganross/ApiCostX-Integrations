import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ALLIE_MASCOT_DEFAULT_EXPRESSION,
  getAllieMascotExpressionAsset,
} from '@/assets/allieMascotExpressions'
import { canShowAssistant } from './assistantAvailability'
import { useAssistantChrome } from './AssistantChromeContext'
import { useAllieMascotIdleExpression } from './useAllieMascotIdleExpression'

const SITE_TITLE_SELECTOR = 'body.acm2-app-page header.wp-block-template-part .wp-block-site-title'
const ALLIE_MASCOT_HOST_ID = 'acm2-allie-mascot'

/** Matches `#acm2-assistant-dock` `duration-200` in Layout. */
const ASSISTANT_DOCK_TRANSITION_MS = 200
/** Pause after the dock is static before Allie re-enters the title bar. */
const HEADER_MASCOT_REAPPEAR_PAUSE_MS = 333
/** Slow title-bar entrance after chat closes. */
const HEADER_MASCOT_APPEAR_MS = 667

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

type AllieHeaderMascotProps = {
  pageShellReady: boolean
}

export function AllieHeaderMascot({ pageShellReady }: AllieHeaderMascotProps) {
  const { assistantOpen, openAssistant } = useAssistantChrome()
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null)
  const prevAssistantOpenRef = useRef(assistantOpen)
  const hasShownAfterShellReadyRef = useRef(false)
  const expression = useAllieMascotIdleExpression({
    baseExpression: ALLIE_MASCOT_DEFAULT_EXPRESSION,
    enabled: Boolean(mountNode && !assistantOpen && pageShellReady),
  })

  useEffect(() => {
    if (!canShowAssistant()) {
      return
    }

    const sync = () => {
      const siteTitle = document.querySelector(SITE_TITLE_SELECTOR)
      if (!siteTitle) {
        setMountNode(null)
        return
      }

      let host = document.getElementById(ALLIE_MASCOT_HOST_ID)
      if (!host) {
        host = document.createElement('span')
        host.id = ALLIE_MASCOT_HOST_ID
        host.className = 'acm2-allie-mascot'
        host.dataset.visible = 'false'
        siteTitle.appendChild(host)
      } else if (host.parentElement !== siteTitle) {
        siteTitle.appendChild(host)
      }

      setMountNode(host)
    }

    sync()

    const header = document.querySelector('body.acm2-app-page header.wp-block-template-part')
    const observer = new MutationObserver(sync)
    if (header) {
      observer.observe(header, { childList: true, subtree: true })
    }

    window.addEventListener('load', sync)

    return () => {
      observer.disconnect()
      window.removeEventListener('load', sync)
      document.getElementById(ALLIE_MASCOT_HOST_ID)?.remove()
      setMountNode(null)
    }
  }, [])

  useEffect(() => {
    if (!mountNode) {
      return
    }

    const wasOpen = prevAssistantOpenRef.current
    prevAssistantOpenRef.current = assistantOpen

    let delayTimeoutId = 0
    let enterTimeoutId = 0

    const hideMascot = () => {
      mountNode.dataset.visible = 'false'
      mountNode.classList.remove('acm2-allie-mascot--entering')
    }

    const showMascot = (animate: boolean) => {
      mountNode.dataset.visible = 'true'
      if (!animate || prefersReducedMotion()) {
        mountNode.classList.remove('acm2-allie-mascot--entering')
        return
      }
      mountNode.classList.add('acm2-allie-mascot--entering')
      enterTimeoutId = window.setTimeout(() => {
        mountNode.classList.remove('acm2-allie-mascot--entering')
      }, HEADER_MASCOT_APPEAR_MS)
    }

    if (assistantOpen || !pageShellReady) {
      hideMascot()
      return () => {
        window.clearTimeout(enterTimeoutId)
      }
    }

    const isClosingTransition = wasOpen && !assistantOpen
    if (isClosingTransition && !prefersReducedMotion()) {
      hideMascot()
      delayTimeoutId = window.setTimeout(() => {
        showMascot(true)
      }, ASSISTANT_DOCK_TRANSITION_MS + HEADER_MASCOT_REAPPEAR_PAUSE_MS)
    } else if (!hasShownAfterShellReadyRef.current) {
      hasShownAfterShellReadyRef.current = true
      showMascot(true)
    } else {
      showMascot(false)
    }

    return () => {
      window.clearTimeout(delayTimeoutId)
      window.clearTimeout(enterTimeoutId)
    }
  }, [assistantOpen, mountNode, pageShellReady])

  if (!mountNode || !canShowAssistant()) {
    return null
  }

  return createPortal(
    <button
      type="button"
      className="acm2-allie-mascot-btn"
      aria-label="Open chat with Allie"
      onClick={() => openAssistant()}
    >
      <img
        src={getAllieMascotExpressionAsset(expression)}
        alt=""
        aria-hidden="true"
        className="acm2-allie-mascot-img"
      />
    </button>,
    mountNode,
  )
}
