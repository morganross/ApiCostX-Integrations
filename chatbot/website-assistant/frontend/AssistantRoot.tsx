import { useEffect, useMemo } from 'react'
import { CopilotKitContext, CopilotKitCoreReact, EMPTY_SET, useCopilotKit } from '@copilotkit/react-core/v2/context'
import { useAgent } from '@copilotkit/react-core/v2/headless'
import { canRenderAssistant, isAssistantDemoMode } from './assistantAvailability'
import { AssistantPanel } from './AssistantPanel'
import {
  AssistantSessionProvider,
  useDemoAssistantAgent,
} from './AssistantSessionContext'
import {
  getBasicAssistantEndpoint,
  hasAdvancedAssistantConfig,
  hasBasicAssistantRuntimeConfig,
} from './assistantConfig'

function LiveAssistantSessionBridge() {
  const { agent } = useAgent({ agentId: 'default' })
  const { copilotkit } = useCopilotKit()

  return (
    <AssistantSessionProvider agent={agent as never} copilotkit={copilotkit as never} interactive>
      <AssistantPanel />
    </AssistantSessionProvider>
  )
}

function LiveAssistantRoot() {
  const basicEndpoint = getBasicAssistantEndpoint()
  const runtimeUrl = basicEndpoint?.runtimeUrl
  const assistantToken = basicEndpoint?.assistantToken
  const debugEnabled = typeof window !== 'undefined'
    && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
  const headers = useMemo(() => ({ 'X-ACM2-Assistant-Token': assistantToken ?? '' }), [assistantToken])
  const copilotkit = useMemo(() => {
    if (!runtimeUrl) return null
    if (!debugEnabled && (!assistantToken || !window.acm2Config?.currentUser)) return null
    return new CopilotKitCoreReact({
      runtimeUrl,
      runtimeTransport: 'single',
      headers,
    })
  }, [assistantToken, debugEnabled, headers, runtimeUrl])

  useEffect(() => {
    if (!copilotkit || !runtimeUrl) return
    copilotkit.setRuntimeUrl(runtimeUrl)
    copilotkit.setRuntimeTransport('single')
    copilotkit.setHeaders(headers)
  }, [copilotkit, headers, runtimeUrl])

  if (!copilotkit) return null

  return (
    <CopilotKitContext.Provider value={{ copilotkit, executingToolCallIds: EMPTY_SET }}>
      <LiveAssistantSessionBridge />
    </CopilotKitContext.Provider>
  )
}

function LocalInteractiveAssistantRoot() {
  const agent = useDemoAssistantAgent()

  return (
    <AssistantSessionProvider agent={agent} copilotkit={null} interactive>
      <AssistantPanel />
    </AssistantSessionProvider>
  )
}

function DemoAssistantRoot() {
  const agent = useDemoAssistantAgent()

  return (
    <AssistantSessionProvider agent={agent} copilotkit={null} interactive={false}>
      <AssistantPanel />
    </AssistantSessionProvider>
  )
}

export default function AssistantRoot() {
  if (hasBasicAssistantRuntimeConfig()) return <LiveAssistantRoot />
  if (canRenderAssistant() && hasAdvancedAssistantConfig()) return <LocalInteractiveAssistantRoot />
  if (isAssistantDemoMode()) return <DemoAssistantRoot />
  return null
}
