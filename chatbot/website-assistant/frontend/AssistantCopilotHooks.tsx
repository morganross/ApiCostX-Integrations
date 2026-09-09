import { useAssistantKnowledgeContext } from './useAssistantKnowledgeContext'
import { useAssistantPageTools } from './useAssistantPageTools'

type PageContext = {
  route: string
  page: string
  active_preset_id: string | null
  current_run_id: string | null
}

type AssistantCopilotHooksProps = {
  enabled: boolean
  getPageContext: () => PageContext
  threadId: string | null
  pageContext: unknown
  memorySummary: string
  pinnedFacts: Record<string, unknown>
}

export function AssistantCopilotHooks({
  enabled,
  getPageContext,
  threadId,
  pageContext,
  memorySummary,
  pinnedFacts,
}: AssistantCopilotHooksProps) {
  useAssistantPageTools({ getPageContext, enabled })
  useAssistantKnowledgeContext({
    threadId,
    pageContext,
    memorySummary,
    pinnedFacts,
  })
  return null
}
