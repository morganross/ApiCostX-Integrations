import { useEffect, useState } from 'react'

/**
 * Latches true once the document has loaded, startup/bootstrap gates have cleared,
 * fonts are ready, and two animation frames have passed (layout painted).
 * Stays true for the remainder of the page session.
 */
export function useAcmPageShellReady(appStartupBlocked: boolean): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (ready || appStartupBlocked) {
      return
    }

    let cancelled = false

    const markReadyAfterPaint = () => {
      if (cancelled || appStartupBlocked) {
        return
      }
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!cancelled && !appStartupBlocked) {
            setReady(true)
          }
        })
      })
    }

    const attemptReady = () => {
      if (cancelled || appStartupBlocked || document.readyState !== 'complete') {
        return
      }
      if (document.fonts?.ready) {
        void document.fonts.ready.then(markReadyAfterPaint).catch(markReadyAfterPaint)
        return
      }
      markReadyAfterPaint()
    }

    if (document.readyState === 'complete') {
      attemptReady()
    } else {
      window.addEventListener('load', attemptReady, { once: true })
    }

    return () => {
      cancelled = true
      window.removeEventListener('load', attemptReady)
    }
  }, [appStartupBlocked, ready])

  return ready
}
