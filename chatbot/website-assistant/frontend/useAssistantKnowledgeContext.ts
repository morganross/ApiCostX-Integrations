import { useMemo } from 'react'
import { useAgentContext } from '@copilotkit/react-core/v2/headless'
import { buildAssistantKnowledgeContextValue } from './assistantKnowledge'

type AssistantKnowledgeContextInput = {
  threadId: string | null
  pageContext: unknown
  memorySummary?: string | null
  pinnedFacts?: Record<string, unknown> | null
}

export function useAssistantKnowledgeContext({
  threadId,
  pageContext,
  memorySummary,
  pinnedFacts,
}: AssistantKnowledgeContextInput) {
  const compactKnowledgeContext = useMemo(() => {
    return buildAssistantKnowledgeContextValue({
      threadId,
      pageContext,
      memorySummary,
      pinnedFacts,
    })
  }, [memorySummary, pageContext, pinnedFacts, threadId])

  useAgentContext({
    description: 'Compact ACM assistant knowledge index, live page context, memory summary, pinned facts, and knowledge-pack version. Read detailed feature docs on demand with read_knowledge_topic.',
    value: compactKnowledgeContext,
  })
}
