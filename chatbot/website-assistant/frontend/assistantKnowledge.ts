import coreSystemPrompt from '../../../../docs/assistant/knowledge/core-system-prompt.md?raw'
import acmHandbook from '../../../../docs/assistant/knowledge/acm-handbook.md?raw'
import acmGlossary from '../../../../docs/assistant/knowledge/acm-glossary.md?raw'
import toolReference from '../../../../docs/assistant/knowledge/tool-reference.md?raw'
import diagnosticPlaybooks from '../../../../docs/assistant/knowledge/diagnostic-playbooks.md?raw'
import fpfPresetQualityDoctrine from '../../../../docs/assistant/knowledge/fpf-preset-quality-doctrine.md?raw'
import engineSelectionAndPresetStrategy from '../../../../docs/assistant/knowledge/engine-selection-and-preset-strategy.md?raw'
import camelOwlEngine from '../../../../docs/assistant/knowledge/camel-owl-engine.md?raw'
import currentProjectStatus from '../../../../docs/assistant/knowledge/current-project-status.md?raw'

export const ASSISTANT_KNOWLEDGE_VERSION = 'ACM_ASSISTANT_KNOWLEDGE_PACK_V4'
export const ASSISTANT_KNOWLEDGE_MARKER = ASSISTANT_KNOWLEDGE_VERSION

const DEFAULT_MAX_SYSTEM_MESSAGE_CHARS = 180_000
const DEFAULT_MAX_CONTEXT_CHARS = 20_000
const LIVE_JSON_CHAR_BUDGET = 40_000
const MEMORY_SUMMARY_CHAR_BUDGET = 29_000
const DEFAULT_MAX_TOPIC_CHARS = 12_000
const MAX_TOPIC_CHARS = 24_000
const ALWAYS_ON_CORE_CHARS = 20_000

export type AssistantKnowledgeDoc = {
  id: string
  title: string
  sourcePath: string
  content: string
  required: boolean
  allowTruncation: boolean
}

export type AssistantKnowledgeBuildInput = {
  threadId: string | null
  pageContext: unknown
  memorySummary?: string | null
  pinnedFacts?: Record<string, unknown> | null
  maxChars?: number
}

export type AssistantKnowledgeManifestInput = {
  declaredFrontendTools?: readonly string[]
}

export type AssistantKnowledgeTopic = {
  id: string
  title: string
  description: string
  documentId: string
}

export const ASSISTANT_KNOWLEDGE_DOCS: AssistantKnowledgeDoc[] = [
  {
    id: 'core-system-prompt',
    title: 'Core System Prompt',
    sourcePath: 'docs/assistant/knowledge/core-system-prompt.md',
    content: coreSystemPrompt,
    required: true,
    allowTruncation: false,
  },
  {
    id: 'acm-glossary',
    title: 'ACM Glossary',
    sourcePath: 'docs/assistant/knowledge/acm-glossary.md',
    content: acmGlossary,
    required: true,
    allowTruncation: false,
  },
  {
    id: 'tool-reference',
    title: 'Tool Reference',
    sourcePath: 'docs/assistant/knowledge/tool-reference.md',
    content: toolReference,
    required: true,
    allowTruncation: false,
  },
  {
    id: 'current-project-status',
    title: 'Current Project Status',
    sourcePath: 'docs/assistant/knowledge/current-project-status.md',
    content: currentProjectStatus,
    required: true,
    allowTruncation: false,
  },
  {
    id: 'acm-handbook',
    title: 'ACM Handbook',
    sourcePath: 'docs/assistant/knowledge/acm-handbook.md',
    content: acmHandbook,
    required: true,
    allowTruncation: true,
  },
  {
    id: 'diagnostic-playbooks',
    title: 'Diagnostic Playbooks',
    sourcePath: 'docs/assistant/knowledge/diagnostic-playbooks.md',
    content: diagnosticPlaybooks,
    required: true,
    allowTruncation: true,
  },
  {
    id: 'fpf-preset-quality-doctrine',
    title: 'FPF Preset Quality Doctrine',
    sourcePath: 'docs/assistant/knowledge/fpf-preset-quality-doctrine.md',
    content: fpfPresetQualityDoctrine,
    required: true,
    allowTruncation: true,
  },
  {
    id: 'engine-selection-and-preset-strategy',
    title: 'Engine Selection And Preset Strategy',
    sourcePath: 'docs/assistant/knowledge/engine-selection-and-preset-strategy.md',
    content: engineSelectionAndPresetStrategy,
    required: true,
    allowTruncation: true,
  },
  {
    id: 'camel-owl-engine',
    title: 'CAMEL-AI OWL preset engine',
    sourcePath: 'docs/assistant/knowledge/camel-owl-engine.md',
    content: camelOwlEngine,
    required: true,
    allowTruncation: true,
  },
]

export const ASSISTANT_KNOWLEDGE_TOPICS: AssistantKnowledgeTopic[] = [
  {
    id: 'acm-overview',
    title: 'APICostX overview',
    description: 'What APICostX is, its main pages, and the core user workflow.',
    documentId: 'acm-handbook',
  },
  {
    id: 'engines-and-models',
    title: 'Engines and models',
    description: 'Engine names, model vocabulary, compatibility, and execution roles.',
    documentId: 'acm-glossary',
  },
  {
    id: 'presets-and-quality',
    title: 'Presets and quality',
    description: 'What a preset contains and how to design a strong runnable preset.',
    documentId: 'fpf-preset-quality-doctrine',
  },
  {
    id: 'engine-strategy',
    title: 'Engine selection and preset strategy',
    description: 'Provisional starting heuristics for choosing engines and building small testable presets.',
    documentId: 'engine-selection-and-preset-strategy',
  },
  {
    id: 'camel-owl-engine',
    title: 'CAMEL-AI OWL preset engine',
    description: 'What the APICostX OWL generation engine does, how it differs from Allie Owl, and its implementation limits.',
    documentId: 'camel-owl-engine',
  },
  {
    id: 'website-tools',
    title: 'Website tools',
    description: 'What Allie can read or change through the logged-in website page.',
    documentId: 'tool-reference',
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics and runs',
    description: 'How to interpret run states, costs, failures, logs, and missing outputs.',
    documentId: 'diagnostic-playbooks',
  },
  {
    id: 'current-project-status',
    title: 'Current project status',
    description: 'Versioned implementation status and known product limitations.',
    documentId: 'current-project-status',
  },
]

validateAssistantKnowledgeDocs()

export function buildAssistantKnowledgeSystemMessage({
  threadId,
  pageContext,
  memorySummary,
  pinnedFacts,
  maxChars = DEFAULT_MAX_SYSTEM_MESSAGE_CHARS,
}: AssistantKnowledgeBuildInput): string {
  const liveContext = buildLiveContextSection({ threadId, pageContext, memorySummary, pinnedFacts })
  const header = [
    ASSISTANT_KNOWLEDGE_MARKER,
    '',
    '# ACM Assistant Knowledge Pack',
    '',
    `Version: ${ASSISTANT_KNOWLEDGE_VERSION}`,
    '',
    'This system message is generated by the ACM frontend before each assistant run.',
    'It contains compact core guidance and an on-demand topic index, then live page/thread context at the end.',
    'Live page context, fresh tool results, thread memory, and pinned facts override stale static documentation.',
  ].join('\n')
  const footer = [
    '## Priority Reminder',
    '',
    'Use this knowledge to interpret ACM-specific terms and tool payloads.',
    'For current facts, prefer live page context and tool results over static project documentation.',
    'Do not claim runtime-side ACM backend access unless a verified runtime fact says so.',
  ].join('\n')

  const tail = [liveContext, footer].join('\n\n')
  const sections = [header, formatAlwaysOnCore(), formatKnowledgeTopicIndex(), tail]
  const message = sections.join('\n\n')
  if (message.length <= maxChars) return message

  const compactMessage = [header, formatCompactedDocSummary(), tail].join('\n\n')
  if (compactMessage.length <= maxChars) return compactMessage

  const failureMessage = `Assistant knowledge pack live context exceeds configured budget (${compactMessage.length}/${maxChars} chars).`
  if (import.meta.env.DEV) {
    throw new Error(failureMessage)
  }
  console.error(failureMessage)
  return compactMessage
}

export function isAssistantKnowledgeSystemMessage(message: { role?: string; content?: string } | null | undefined): boolean {
  return message?.role === 'system' && typeof message.content === 'string' && message.content.includes(ASSISTANT_KNOWLEDGE_MARKER)
}

export function buildAssistantKnowledgeContextValue({
  threadId,
  pageContext,
  memorySummary,
  pinnedFacts,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
}: AssistantKnowledgeBuildInput): string {
  const value = {
    knowledge_pack_version: ASSISTANT_KNOWLEDGE_VERSION,
    status: 'loaded',
    purpose: 'Compact CopilotKit context. A small core and topic index are injected; detailed feature docs are read on demand.',
    always_injected_channels: ['system_message_core_and_topic_index', 'copilotkit_context_summary', 'agent_state'],
    on_demand_tools: ['get_assistant_knowledge_manifest', 'read_knowledge_topic'],
    document_manifest: ASSISTANT_KNOWLEDGE_DOCS.map((doc) => ({
      id: doc.id,
      title: doc.title,
      source_path: doc.sourcePath,
      required: doc.required,
      allow_truncation: doc.allowTruncation,
      character_count: doc.content.length,
    })),
    live_context: {
      thread_id: threadId,
      page_context: pageContext,
      memory_summary: truncateText(memorySummary ?? '', MEMORY_SUMMARY_CHAR_BUDGET),
      pinned_facts: pinnedFacts ?? {},
    },
    topics: ASSISTANT_KNOWLEDGE_TOPICS,
    priority: 'Live page context, tool results, thread memory, and pinned facts override stale static documentation.',
  }

  return truncateText(JSON.stringify(value, null, 2), maxChars, 'CopilotKit context summary truncated; full docs remain in the system message.')
}

export function getAssistantKnowledgeManifest({ declaredFrontendTools = [] }: AssistantKnowledgeManifestInput = {}) {
  return {
    status: 'loaded',
    version: ASSISTANT_KNOWLEDGE_VERSION,
    marker: ASSISTANT_KNOWLEDGE_MARKER,
    always_injected_channels: ['system_message_core_and_topic_index', 'copilotkit_context_summary', 'agent_state'],
    on_demand_channels: ['get_assistant_knowledge_manifest', 'read_knowledge_topic'],
    runtime_side_knowledge_verified: false,
    declared_frontend_tool_count: declaredFrontendTools.length,
    declared_frontend_tools: declaredFrontendTools,
    max_system_message_chars: DEFAULT_MAX_SYSTEM_MESSAGE_CHARS,
    max_copilotkit_context_chars: DEFAULT_MAX_CONTEXT_CHARS,
    documents: ASSISTANT_KNOWLEDGE_DOCS.map((doc) => ({
      id: doc.id,
      title: doc.title,
      source_path: doc.sourcePath,
      required: doc.required,
      allow_truncation: doc.allowTruncation,
      character_count: doc.content.length,
    })),
    topics: ASSISTANT_KNOWLEDGE_TOPICS,
    interpretation_notes: [
      'This manifest describes the frontend-injected knowledge pack.',
      'A compact core and topic index are injected through the system message; detailed allowlisted Markdown is loaded only when a feature-specific question needs it.',
      'Use read_knowledge_topic for one feature at a time and keep live page/tool results authoritative for current state.',
      'Runtime-side prompt loading still needs direct verification on the CopilotKit node.',
      'Live page context and tool results override stale static documentation.',
    ],
  }
}

export function getAssistantKnowledgeStatus() {
  const totalChars = ASSISTANT_KNOWLEDGE_DOCS.reduce((sum, doc) => sum + doc.content.length, 0)
  return {
    version: ASSISTANT_KNOWLEDGE_VERSION,
    document_count: ASSISTANT_KNOWLEDGE_DOCS.length,
    topic_count: ASSISTANT_KNOWLEDGE_TOPICS.length,
    total_document_characters: totalChars,
    always_injected_channels: ['system_message_core_and_topic_index', 'copilotkit_context_summary', 'agent_state'],
    on_demand_channels: ['get_assistant_knowledge_manifest', 'read_knowledge_topic'],
    max_system_message_chars: DEFAULT_MAX_SYSTEM_MESSAGE_CHARS,
    max_copilotkit_context_chars: DEFAULT_MAX_CONTEXT_CHARS,
  }
}

export function readAssistantKnowledgeTopic(topic: string, maxChars = DEFAULT_MAX_TOPIC_CHARS) {
  const normalizedTopic = String(topic ?? '').trim().toLowerCase()
  const match = ASSISTANT_KNOWLEDGE_TOPICS.find((candidate) => candidate.id === normalizedTopic)
  if (!match) {
    return {
      status: 'not_found',
      requested_topic: topic,
      available_topics: ASSISTANT_KNOWLEDGE_TOPICS,
      message: 'That knowledge topic is not in the allowlisted assistant knowledge map.',
    }
  }

  const document = ASSISTANT_KNOWLEDGE_DOCS.find((candidate) => candidate.id === match.documentId)
  if (!document) {
    return {
      status: 'unavailable',
      topic_id: match.id,
      message: 'The topic is registered, but its source document is unavailable in this frontend build.',
    }
  }

  const limit = Math.max(1_000, Math.min(MAX_TOPIC_CHARS, Math.round(Number(maxChars) || DEFAULT_MAX_TOPIC_CHARS)))
  const content = truncateText(document.content.trim(), limit, 'Knowledge topic truncated for this read.')
  return {
    status: 'loaded',
    topic_id: match.id,
    topic_title: match.title,
    topic_description: match.description,
    document_id: document.id,
    source_path: document.sourcePath,
    content,
    truncated: content.length < document.content.trim().length,
    note: 'This is an allowlisted feature document. Current page state and live tool results remain authoritative.',
  }
}

function formatAlwaysOnCore() {
  const core = ASSISTANT_KNOWLEDGE_DOCS.find((doc) => doc.id === 'core-system-prompt')
  if (!core) return '# Always-On ACM Guidance\n\n[Core guidance unavailable.]'
  return [
    '# Always-On ACM Guidance',
    '',
    'This compact core is always available. Detailed feature documents are on demand through read_knowledge_topic.',
    '',
    truncateText(core.content.trim(), ALWAYS_ON_CORE_CHARS, 'Core guidance trimmed for the always-on budget.'),
  ].join('\n')
}

function formatKnowledgeTopicIndex() {
  return [
    '# On-Demand ACM Knowledge Topics',
    '',
    'Do not assume detailed feature facts from the topic names. Call read_knowledge_topic with the matching topic id when the user asks about one of these areas.',
    '',
    ...ASSISTANT_KNOWLEDGE_TOPICS.map((topic) => `- ${topic.id}: ${topic.title} — ${topic.description}`),
  ].join('\n')
}

function formatCompactedDocSummary() {
  return [
    '# Static Knowledge Compacted For Budget',
    '',
    'Detailed feature documents are available through the bounded read_knowledge_topic tool.',
    '',
    formatKnowledgeTopicIndex(),
  ].join('\n')
}

function buildLiveContextSection({
  threadId,
  pageContext,
  memorySummary,
  pinnedFacts,
}: AssistantKnowledgeBuildInput) {
  return [
    '# Live ACM Context For This Run',
    '',
    'This section is generated at submit time and is more current than the static docs above.',
    '',
    `Thread id: ${threadId ?? 'none'}`,
    '',
    'Current page context:',
    '',
    '```json',
    safeStringify(pageContext ?? {}, LIVE_JSON_CHAR_BUDGET),
    '```',
    '',
    'Thread memory summary:',
    '',
    memorySummary?.trim() ? truncateText(memorySummary.trim(), MEMORY_SUMMARY_CHAR_BUDGET) : '(none)',
    '',
    'Pinned facts:',
    '',
    '```json',
    safeStringify(pinnedFacts ?? {}, LIVE_JSON_CHAR_BUDGET),
    '```',
  ].join('\n')
}

function validateAssistantKnowledgeDocs() {
  const missing = ASSISTANT_KNOWLEDGE_DOCS
    .filter((doc) => doc.required && doc.content.trim().length === 0)
    .map((doc) => doc.sourcePath)

  const duplicateIds = ASSISTANT_KNOWLEDGE_DOCS
    .map((doc) => doc.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index)

  const malformed = ASSISTANT_KNOWLEDGE_DOCS
    .filter((doc) => doc.required && !doc.content.trimStart().startsWith('#'))
    .map((doc) => doc.sourcePath)

  const frontendUnsafe = ASSISTANT_KNOWLEDGE_DOCS
    .filter((doc) => /ubuntu@|Permission denied \(publickey\)|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(doc.content))
    .map((doc) => doc.sourcePath)

  const problems = [
    missing.length > 0 ? `missing required documents: ${missing.join(', ')}` : '',
    duplicateIds.length > 0 ? `duplicate document ids: ${duplicateIds.join(', ')}` : '',
    malformed.length > 0 ? `malformed required documents without a Markdown heading: ${malformed.join(', ')}` : '',
    frontendUnsafe.length > 0 ? `frontend-unsafe operational details: ${frontendUnsafe.join(', ')}` : '',
  ].filter(Boolean)

  if (problems.length === 0) return

  const message = `Assistant knowledge pack validation failed: ${problems.join('; ')}`
  if (import.meta.env.DEV) {
    throw new Error(message)
  }
  console.error(message)
}

function safeStringify(value: unknown, maxChars?: number): string {
  try {
    return truncateText(JSON.stringify(value, null, 2), maxChars)
  } catch {
    return JSON.stringify({ error: 'Value could not be serialized for assistant knowledge context.' }, null, 2)
  }
}

function truncateText(value: string, maxChars?: number, note = 'Value truncated for assistant knowledge budget.'): string {
  if (!maxChars || value.length <= maxChars) return value
  const suffix = `\n\n[${note} Original length: ${value.length} chars. Limit: ${maxChars} chars.]`
  return `${value.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`
}
