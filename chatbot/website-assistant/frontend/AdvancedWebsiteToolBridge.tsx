import { useEffect } from 'react'
import { apiClient } from '@/api/client'
import { contentsApi, type ContentType } from '@/api/contents'
import { getPreset, listPresets } from '@/api/presets'
import { runsApi } from '@/api/runs'
import { ALLIE_OWL_SHARED_ACTION_NAMES, ALLIE_OWL_SHARED_ACTIONS } from './allieOwlActionContract'
import { createSharedUserActionInvoker } from './sharedUserActionInvoker'

type PageContext = {
  route: string
  page: string
  active_preset_id: string | null
  current_run_id: string | null
}

type AdvancedWebsiteToolBridgeApi = {
  listTools: () => string[]
  invoke: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

declare global {
  interface Window {
    acm2AdvancedWebsiteTools?: AdvancedWebsiteToolBridgeApi
  }
}

const ADVANCED_READONLY_TOOLS = [
  'get_available_assistant_actions',
  'get_current_route_context',
  'get_visible_page_state',
  'get_loaded_preset_list',
  'load_preset_for_assistant',
  'get_content_library_summary',
  'search_content_library_for_assistant',
  'load_content_for_assistant',
  'get_current_preset_content_assets',
  'get_current_preset_summary',
  'get_current_preset_runnability',
  'get_current_preset_models',
  'get_current_preset_documents',
  'get_current_preset_instructions',
  'get_recent_runs_for_assistant',
  'get_latest_run_context',
  'load_run_for_assistant',
  'get_run_status_summary',
  'get_run_failure_signals',
  'get_run_output_summary',
  'load_run_logs_for_assistant',
] as const

const ADVANCED_CONFIRMATION_TOOLS = [
  'create_content_for_assistant',
  'update_content_for_assistant',
  'start_new_preset_draft',
  'configure_fpf_preset_draft',
  'save_current_preset_draft',
  'attach_generation_instructions_to_current_preset',
  'attach_input_document_to_current_preset',
  'attach_eval_asset_to_current_preset',
  'attach_combine_instructions_to_current_preset',
  'set_current_preset_engine_models',
  'execute_current_preset',
] as const

const ADVANCED_SHARED_READONLY_TOOLS = ALLIE_OWL_SHARED_ACTIONS
  .filter((action) => !action.mutatesPage)
  .map((action) => action.name)
const ADVANCED_SHARED_CONFIRMATION_TOOLS = ALLIE_OWL_SHARED_ACTIONS
  .filter((action) => action.mutatesPage)
  .map((action) => action.name)

const ADVANCED_WEBSITE_TOOLS = [
  ...ADVANCED_READONLY_TOOLS,
  ...ADVANCED_CONFIRMATION_TOOLS,
  ...ALLIE_OWL_SHARED_ACTION_NAMES,
] as const

function sanitizePageContext(context: PageContext) {
  return {
    route: context.route,
    page: context.page,
    active_preset_id: context.active_preset_id,
    current_run_id: context.current_run_id,
    logged_in: Boolean(window.acm2Config?.currentUser),
  }
}

function buildAvailableAssistantActions(pageContext: ReturnType<typeof sanitizePageContext>) {
  return {
    status: 'loaded',
    page_context: pageContext,
    tools: [...ADVANCED_WEBSITE_TOOLS],
    readonly_tools: [...ADVANCED_READONLY_TOOLS, ...ADVANCED_SHARED_READONLY_TOOLS],
    mutation_tools: [...ADVANCED_CONFIRMATION_TOOLS, ...ADVANCED_SHARED_CONFIRMATION_TOOLS],
    yolo_mode: true,
    note:
      'Advanced mode can invoke these named website tools through the logged-in page bridge. Secrets stay in the website/browser/backend session boundary, not in the graph runtime.',
  }
}

function buildCurrentPresetSummary(pageContext: ReturnType<typeof sanitizePageContext>) {
  const draft = window.acm2AssistantPresetBridge?.getDraft?.()
  if (!draft || typeof draft !== 'object') {
    return {
      status: 'unavailable',
      message: 'No visible preset draft is available on the current website page.',
      page_context: pageContext,
    }
  }

  const visibleDraft = draft as Record<string, unknown>
  const config = asRecord(visibleDraft.config)
  const enabledEngines = getEnabledDraftEngines(config)
  const selectedModels = getSelectedDraftModels(config)
  const selectedDocuments = Array.isArray(visibleDraft.selectedInputDocuments)
    ? visibleDraft.selectedInputDocuments
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 12)
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id : null,
          name: typeof item.name === 'string' ? item.name : null,
        }))
    : []

  return {
    status: 'loaded',
    source: 'visible_preset_draft',
    page_context: pageContext,
    preset_id: stringOrNull(visibleDraft.selectedPresetId) ?? pageContext.active_preset_id,
    name: stringOrNull(visibleDraft.presetName) ?? '',
    description: stringOrNull(visibleDraft.runDescription) ?? '',
    summary: {
      enabled_engines: enabledEngines,
      selected_models: selectedModels,
      report_modes: getDraftReportModes(config, enabledEngines),
      document_count: Array.isArray(visibleDraft.selectedInputDocIds)
        ? visibleDraft.selectedInputDocIds.length
        : selectedDocuments.length,
      selected_documents: selectedDocuments,
      selected_instruction_id: stringOrNull(visibleDraft.selectedInstructionId),
      input_source_type: stringOrNull(visibleDraft.inputSourceType),
      active_search_provider: getDraftSearchProvider(config),
    },
    notes: [
      'This is a bounded summary of the visible preset draft on the logged-in website.',
      'It does not include browser tokens, database keys, provider keys, plugin secrets, or raw backend API authority.',
      'Use later deeper tools for runnability, instruction details, or full model breakdowns.',
    ],
  }
}

function buildCurrentPresetRunnability(pageContext: ReturnType<typeof sanitizePageContext>) {
  const draft = window.acm2AssistantPresetBridge?.getDraft?.()
  if (!draft || typeof draft !== 'object') {
    return {
      status: 'unavailable',
      message: 'No visible preset draft is available on the current website page.',
      page_context: pageContext,
    }
  }

  const visibleDraft = draft as Record<string, unknown>
  const config = asRecord(visibleDraft.config)
  if (!config) {
    return {
      status: 'indeterminate',
      message: 'Preset runnability could not be determined because the visible draft did not expose config.',
      missing_checks: ['config'],
      page_context: pageContext,
    }
  }

  const generationModelCount = getDraftGenerationModelCount(config)
  const selectedInputDocIds = Array.isArray(visibleDraft.selectedInputDocIds)
    ? visibleDraft.selectedInputDocIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  const githubInputPaths = Array.isArray(visibleDraft.githubInputPaths)
    ? visibleDraft.githubInputPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    : []
  const inputSourceType = stringOrNull(visibleDraft.inputSourceType)
  const hasDocuments = selectedInputDocIds.length > 0 || (inputSourceType === 'github' && githubInputPaths.length > 0)
  const generationInstructionsRequired = !Boolean(visibleDraft.sourcePromptModeEnabled)
  const hasGenerationInstructions = Boolean(stringOrNull(visibleDraft.selectedInstructionId))
  const evalConfig = asRecord(config.eval)
  const judgeModels = arrayOfStrings(evalConfig?.judgeModels)
  const singleEvalInstructionId = stringOrNull(evalConfig?.singleEvalInstructionsId)
  const pairwiseEvalInstructionId = stringOrNull(evalConfig?.pairwiseEvalInstructionsId)
  const pairwiseEnabled = Boolean(evalConfig?.enablePairwise)
  const combineConfig = asRecord(config.combine)
  const combineModels = arrayOfStrings(combineConfig?.selectedModels)
  const combineInstructionsId = stringOrNull(combineConfig?.combineInstructionsId)

  const blockingReasons: string[] = []
  const warnings: string[] = []

  if (generationModelCount === 0) {
    blockingReasons.push('No generation models are selected.')
  }
  if (!hasDocuments) {
    blockingReasons.push('No input documents or GitHub input paths are selected.')
  }
  if (generationInstructionsRequired && !hasGenerationInstructions) {
    blockingReasons.push('No generation instructions are selected.')
  }
  if (judgeModels.length > 0 && !singleEvalInstructionId) {
    blockingReasons.push('Single-eval judge models are selected, but no single-eval instructions are attached.')
  }
  if (pairwiseEnabled && generationModelCount >= 2 && !pairwiseEvalInstructionId) {
    blockingReasons.push('Pairwise comparison is enabled, but no pairwise-eval instructions are attached.')
  }
  if (combineModels.length > 0 && !combineInstructionsId) {
    warnings.push('Combine models are selected, but no combine instructions are attached.')
  }

  return {
    status: 'evaluated',
    source: 'visible_preset_draft',
    page_context: pageContext,
    subject: {
      preset_id: stringOrNull(visibleDraft.selectedPresetId) ?? pageContext.active_preset_id,
      preset_name: stringOrNull(visibleDraft.presetName) ?? '',
    },
    runnable: blockingReasons.length === 0,
    blocking_reasons: blockingReasons,
    warnings,
    checks: {
      has_models: generationModelCount > 0,
      generation_model_count: generationModelCount,
      has_generation_instructions: hasGenerationInstructions,
      generation_instructions_required: generationInstructionsRequired,
      has_documents: hasDocuments,
      document_count: selectedInputDocIds.length,
      github_input_path_count: githubInputPaths.length,
      has_visible_page_bridge: true,
    },
    notes: [
      'Blocking reasons prevent execution.',
      'Warnings do not prevent execution by themselves.',
      'This is based on the visible preset draft owned by the logged-in website.',
    ],
  }
}

function buildCurrentPresetModels(pageContext: ReturnType<typeof sanitizePageContext>) {
  const draft = getVisiblePresetDraft(pageContext)
  if ('status' in draft) return draft
  const config = asRecord(draft.config)
  if (!config) {
    return {
      status: 'indeterminate',
      message: 'Preset model selections could not be determined because the visible draft did not expose config.',
      missing_checks: ['config'],
      page_context: pageContext,
    }
  }
  const byEngine = normalizeModelBuckets({
    fpf: arrayOfStrings(asRecord(config.fpf)?.selectedModels),
    gptr: arrayOfStrings(asRecord(config.gptr)?.selectedModels),
    dr: arrayOfStrings(asRecord(config.dr)?.selectedModels),
    msagent: arrayOfStrings(asRecord(config.msagent)?.selectedModels),
    aiq: arrayOfStrings(asRecord(config.aiq)?.selectedModels),
    owl: arrayOfStrings(asRecord(config.owl)?.selectedModels),
    translation_agent: arrayOfStrings(asRecord(config.translationAgent)?.selectedModels),
    marian: arrayOfStrings(asRecord(config.marian)?.selectedModels),
    pdfmathtranslate: arrayOfStrings(asRecord(config.pdfMathTranslate)?.selectedModels),
    eval: arrayOfStrings(asRecord(config.eval)?.judgeModels),
    combine: arrayOfStrings(asRecord(config.combine)?.selectedModels),
  })
  const selectedModels = uniqueStrings(Object.values(byEngine).flat()).slice(0, 80)
  return {
    status: 'loaded',
    source: 'visible_preset_draft',
    page_context: pageContext,
    preset_id: stringOrNull(draft.selectedPresetId) ?? pageContext.active_preset_id,
    models: {
      selected_models: selectedModels,
      by_engine: byEngine,
      has_any_models: selectedModels.length > 0,
    },
    interpretation_notes: [
      'Model selection is configuration evidence only; it does not prove execution success or output quality.',
    ],
  }
}

function buildCurrentPresetDocuments(pageContext: ReturnType<typeof sanitizePageContext>) {
  const draft = getVisiblePresetDraft(pageContext)
  if ('status' in draft) return draft
  const selectedInputDocIds = Array.isArray(draft.selectedInputDocIds)
    ? draft.selectedInputDocIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  const selectedInputDocuments = Array.isArray(draft.selectedInputDocuments)
    ? draft.selectedInputDocuments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
  const nameById = new Map(
    selectedInputDocuments.map((item) => [
      typeof item.id === 'string' ? item.id : '',
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : typeof item.id === 'string' ? item.id : '',
    ] as const),
  )
  const items = selectedInputDocIds.slice(0, 50).map((id) => ({
    id,
    name: nameById.get(id) ?? id,
  }))
  const githubInputPaths = Array.isArray(draft.githubInputPaths)
    ? draft.githubInputPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0).slice(0, 50)
    : []
  return {
    status: 'loaded',
    source: 'visible_preset_draft',
    page_context: pageContext,
    preset_id: stringOrNull(draft.selectedPresetId) ?? pageContext.active_preset_id,
    documents: {
      document_count: items.length,
      items,
      github_input_path_count: githubInputPaths.length,
      github_input_paths: githubInputPaths,
      input_source_type: stringOrNull(draft.inputSourceType),
    },
    interpretation_notes: [
      'Document attachment means source material appears selected; it does not prove the content is relevant or sufficient.',
    ],
  }
}

function buildCurrentPresetInstructions(pageContext: ReturnType<typeof sanitizePageContext>) {
  const draft = getVisiblePresetDraft(pageContext)
  if ('status' in draft) return draft
  const config = asRecord(draft.config)
  const evalConfig = asRecord(config?.eval)
  const combineConfig = asRecord(config?.combine)
  const buildAttachment = (id: unknown) => {
    const normalized = stringOrNull(id)
    return normalized ? { attached: true, id: normalized } : { attached: false }
  }
  return {
    status: 'loaded',
    source: 'visible_preset_draft',
    page_context: pageContext,
    preset_id: stringOrNull(draft.selectedPresetId) ?? pageContext.active_preset_id,
    instructions: {
      generation: buildAttachment(draft.selectedInstructionId),
      single_eval: buildAttachment(evalConfig?.singleEvalInstructionsId),
      pairwise_eval: buildAttachment(evalConfig?.pairwiseEvalInstructionsId),
      eval_criteria: buildAttachment(evalConfig?.evalCriteriaId),
      combine: buildAttachment(combineConfig?.combineInstructionsId),
    },
    interpretation_notes: [
      'Instruction attachment means an instruction asset appears selected; it does not prove the prompt content is correct or complete.',
    ],
  }
}

async function buildLoadedPresetList() {
  const visiblePresetOptions = window.acm2AssistantPresetBridge?.getPresetOptions?.()
  if (Array.isArray(visiblePresetOptions) && visiblePresetOptions.length > 0) {
    return {
      status: 'loaded',
      source: 'visible_preset_page',
      total: visiblePresetOptions.length,
      items: visiblePresetOptions.slice(0, 100).map(normalizePresetListItem),
      notes: [
        'This list comes from preset options already loaded by the visible website page.',
        'It is bounded to 100 rows and does not include browser tokens, database keys, provider keys, or raw backend API authority.',
      ],
    }
  }

  const list = await listPresets(1, 100)
  return {
    status: 'loaded',
    source: 'frontend_preset_api',
    total: list.total,
    page: list.page,
    page_size: list.page_size,
    pages: list.pages,
    items: list.items.slice(0, 100).map(normalizePresetListItem),
    notes: [
      'This list was loaded by the logged-in website through its normal preset API client.',
      'It is bounded to 100 rows and does not include browser tokens, database keys, provider keys, or raw backend API authority.',
    ],
  }
}

async function loadPresetForAssistant(args: Record<string, unknown>) {
  let presetId = stringOrNull(args.preset_id)
  const nameQuery = stringOrNull(args.name_query)
  if (!presetId && nameQuery) {
    const list = await buildLoadedPresetList()
    const query = nameQuery.toLowerCase()
    const match = Array.isArray(list.items)
      ? list.items.find((item) => typeof item.name === 'string' && item.name.toLowerCase().includes(query))
      : null
    if (match?.id) {
      presetId = match.id
    } else {
      return {
        status: 'not_found',
        requested_preset_id: null,
        name_query: nameQuery,
        message: 'No matching preset id or name was found.',
        next_steps: [
          'Ask for the loaded preset list and choose one of the returned names or ids.',
          'Try a shorter name substring.',
        ],
      }
    }
  }
  if (!presetId) {
    return {
      status: 'not_found',
      requested_preset_id: null,
      name_query: nameQuery,
      message: 'No preset id or name query was provided.',
      next_steps: ['Ask for the loaded preset list first, then load one returned preset by name or id.'],
    }
  }

  try {
    const preset = await getPreset(presetId)
    return buildStoredPresetSummary(preset)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preset could not be loaded.'
    return {
      status: message.toLowerCase().includes('not found') ? 'not_found' : 'error',
      requested_preset_id: presetId,
      name_query: nameQuery,
      message,
    }
  }
}

function normalizePresetListItem(item: unknown) {
  const record = asRecord(item) ?? {}
  return {
    id: stringOrNull(record.id),
    name: stringOrNull(record.name) ?? stringOrNull(record.title) ?? stringOrNull(record.id),
    description: stringOrNull(record.description) ?? '',
    runnable: typeof record.runnable === 'boolean' ? record.runnable : null,
    updated_at: stringOrNull(record.updated_at),
    created_at: stringOrNull(record.created_at),
  }
}

function buildStoredPresetSummary(preset: unknown) {
  const record = asRecord(preset) ?? {}
  const fpf = asRecord(record.fpf_config)
  const gptr = asRecord(record.gptr_config)
  const dr = asRecord(record.dr_config)
  const msagent = asRecord(record.msagent_config)
  const aiq = asRecord(record.aiq_config)
  const owl = asRecord(record.owl_config)
  const translationAgent = asRecord(record.translation_agent_config)
  const marian = asRecord(record.marian_config)
  const pdfMathTranslate = asRecord(record.pdfmathtranslate_config)
  const evalConfig = asRecord(record.eval_config)
  const combine = asRecord(record.combine_config)
  const byEngine = normalizeModelBuckets({
    fpf: arrayOfStrings(fpf?.selected_models),
    gptr: arrayOfStrings(gptr?.selected_models),
    dr: arrayOfStrings(dr?.selected_models),
    msagent: arrayOfStrings(msagent?.selected_models),
    aiq: arrayOfStrings(aiq?.selected_models),
    owl: arrayOfStrings(owl?.selected_models),
    translation_agent: arrayOfStrings(translationAgent?.selected_models),
    marian: arrayOfStrings(marian?.selected_models),
    pdfmathtranslate: arrayOfStrings(pdfMathTranslate?.selected_models),
    eval: arrayOfStrings(evalConfig?.judge_models),
    combine: arrayOfStrings(combine?.selected_models),
  })
  const enabledEngines = [
    ['fpf', fpf],
    ['gptr', gptr],
    ['dr', dr],
    ['msagent', msagent],
    ['aiq', aiq],
    ['owl', owl],
    ['translation_agent', translationAgent],
    ['marian', marian],
    ['pdfmathtranslate', pdfMathTranslate],
    ['combine', combine],
  ]
    .filter(([, config]) => Boolean(asRecord(config)?.enabled))
    .map(([engine]) => engine)
  const selectedModels = uniqueStrings(Object.values(byEngine).flat()).slice(0, 80)
  const documents = Array.isArray(record.documents) ? record.documents : []
  return {
    status: 'loaded',
    source: 'frontend_preset_api',
    preset_id: stringOrNull(record.id),
    name: stringOrNull(record.name) ?? '',
    description: stringOrNull(record.description) ?? '',
    summary: {
      enabled_engines: enabledEngines,
      selected_models: selectedModels,
      model_buckets: byEngine,
      document_count: documents.length,
      generation_instructions_attached: Boolean(record.generation_instructions_id),
      single_eval_instructions_attached: Boolean(record.single_eval_instructions_id),
      pairwise_eval_instructions_attached: Boolean(record.pairwise_eval_instructions_id),
      combine_instructions_attached: Boolean(record.combine_instructions_id),
      input_source_type: stringOrNull(record.input_source_type),
      active_search_provider: getStoredPresetSearchProvider({ aiq, dr, gptr, msagent }),
    },
    notes: [
      'This is a bounded summary of one stored preset loaded by the logged-in website.',
      'It does not include browser tokens, database keys, provider keys, plugin secrets, or raw backend API authority.',
    ],
  }
}

function getStoredPresetSearchProvider(configs: {
  aiq: Record<string, unknown> | null
  dr: Record<string, unknown> | null
  gptr: Record<string, unknown> | null
  msagent: Record<string, unknown> | null
}) {
  return (
    stringOrNull(configs.aiq?.search_provider) ??
    stringOrNull(configs.aiq?.run_search_provider) ??
    stringOrNull(configs.dr?.search_provider) ??
    stringOrNull(configs.dr?.run_search_provider) ??
    stringOrNull(configs.gptr?.search_provider) ??
    stringOrNull(configs.msagent?.retriever)
  )
}

async function buildContentLibrarySummary(args: Record<string, unknown>) {
  const contentType = normalizeContentType(args.content_type)
  const search = stringOrNull(args.search)
  const list = await contentsApi.list({
    content_type: contentType ?? undefined,
    search: search ?? undefined,
    page: 1,
    page_size: 50,
  })
  return {
    status: 'loaded',
    source: 'frontend_content_api',
    filter: {
      content_type: contentType,
      search,
    },
    total: list.total,
    page: list.page,
    page_size: list.page_size,
    pages: list.pages,
    items: list.items.slice(0, 50).map((item) => ({
      id: item.id,
      name: item.name,
      content_type: item.content_type,
      description: item.description,
      folder_path: item.folder_path,
      tags: item.tags.slice(0, 12),
      body_preview: limitText(item.body_preview, 240),
      updated_at: item.updated_at,
      created_at: item.created_at,
    })),
    notes: [
      'This is a bounded metadata and preview listing from the logged-in website content library.',
      'It does not include browser tokens, database keys, provider keys, plugin secrets, or raw backend API authority.',
    ],
  }
}

async function searchContentLibraryForAssistant(args: Record<string, unknown>) {
  const contentType = normalizeContentType(args.content_type)
  const search = stringOrNull(args.search)
  const tag = stringOrNull(args.tag)
  const folderPath = stringOrNull(args.folder_path)
  const limit = clampPositiveInt(args.limit, 50, 10, 100)
  const [list, counts, folders] = await Promise.all([
    contentsApi.list({
      content_type: contentType ?? undefined,
      search: search ?? undefined,
      tag: tag ?? undefined,
      folder_path: folderPath ?? undefined,
      page: 1,
      page_size: limit,
    }),
    contentsApi.counts({ folder_path: folderPath ?? undefined }).catch(() => null),
    contentsApi.folders({ content_type: contentType ?? undefined }).catch(() => null),
  ])
  const items = list.items.slice(0, limit).map((item) => ({
    id: item.id,
    name: item.name,
    content_type: item.content_type,
    description: item.description,
    folder_path: item.folder_path,
    tags: item.tags.slice(0, 16),
    body_preview: limitText(item.body_preview, 360),
    updated_at: item.updated_at,
    created_at: item.created_at,
  }))
  const byType: Record<string, number> = {}
  const byFolder: Record<string, number> = {}
  const tagCounts: Record<string, number> = {}
  for (const item of items) {
    byType[item.content_type] = (byType[item.content_type] ?? 0) + 1
    byFolder[item.folder_path || '/'] = (byFolder[item.folder_path || '/'] ?? 0) + 1
    for (const itemTag of item.tags) {
      tagCounts[itemTag] = (tagCounts[itemTag] ?? 0) + 1
    }
  }
  return {
    status: 'loaded',
    source: 'frontend_content_api',
    filter: {
      content_type: contentType,
      search,
      tag,
      folder_path: folderPath,
      limit,
    },
    total: list.total,
    page: list.page,
    page_size: list.page_size,
    pages: list.pages,
    counts: counts ?? null,
    folders: folders?.items?.slice(0, 50) ?? [],
    returned_summary: {
      returned_count: items.length,
      by_type: byType,
      by_folder: byFolder,
      top_tags: Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 20)
        .map(([name, count]) => ({ name, count })),
    },
    items,
    notes: [
      'This is a filtered content-library search through the logged-in website frontend API.',
      'Use this for topic files, instruction variants, folder/tag discovery, and content inventory questions.',
      'Body previews are bounded and raw full bodies are not returned by this search tool.',
    ],
  }
}

async function loadContentForAssistant(args: Record<string, unknown>) {
  let contentId = stringOrNull(args.content_id)
  const nameQuery = stringOrNull(args.name_query)
  const contentType = normalizeContentType(args.content_type)
  const includeBodyExcerpt = args.include_body_excerpt !== false
  const maxChars = clampPositiveInt(args.max_chars, 1200, 200, 12000)

  if (!contentId && nameQuery) {
    const list = await contentsApi.list({
      content_type: contentType ?? undefined,
      search: nameQuery,
      page: 1,
      page_size: 20,
    })
    const query = nameQuery.toLowerCase()
    const match = list.items.find((item) => item.name.toLowerCase().includes(query)) ?? list.items[0]
    if (match) {
      contentId = match.id
    } else {
      return {
        status: 'not_found',
        requested_content_id: null,
        name_query: nameQuery,
        content_type: contentType,
        message: 'No matching content record was found.',
      }
    }
  }

  if (!contentId) {
    return {
      status: 'not_found',
      requested_content_id: null,
      name_query: nameQuery,
      content_type: contentType,
      message: 'No content id or name query was provided.',
    }
  }

  const detail = await contentsApi.get(contentId)
  return {
    status: 'loaded',
    source: 'frontend_content_api',
    content: {
      id: detail.id,
      name: detail.name,
      content_type: detail.content_type,
      description: detail.description,
      folder_path: detail.folder_path,
      tags: detail.tags.slice(0, 12),
      variable_names: Object.keys(detail.variables ?? {}).slice(0, 50),
      body_length: detail.body.length,
      body_excerpt: includeBodyExcerpt ? limitText(detail.body, maxChars) : null,
      excerpt_char_limit: includeBodyExcerpt ? maxChars : 0,
      body_excerpt_complete: includeBodyExcerpt ? detail.body.length <= maxChars : false,
      body_excerpt_truncated: includeBodyExcerpt ? detail.body.length > maxChars : false,
      updated_at: detail.updated_at,
      created_at: detail.created_at,
    },
    notes: [
      'Body text is bounded and intended for interpretation, not bulk export. Explicit deep-read requests can return a larger bounded excerpt.',
      'The advanced assistant still did not receive browser tokens, database keys, provider keys, plugin secrets, or raw backend API authority.',
    ],
  }
}

async function createContentForAssistant(args: Record<string, unknown>) {
  const name = stringOrNull(args.name)
  const contentType = normalizeContentType(args.content_type)
  const body = typeof args.body === 'string' ? args.body : ''
  if (!name || !contentType || !body.trim()) {
    return {
      status: 'rejected',
      message: 'Content creation requires name, content_type, and non-empty body.',
      requested: {
        name,
        content_type: contentType,
        body_length: body.length,
      },
    }
  }

  const created = await contentsApi.create({
    name,
    content_type: contentType,
    body,
    description: stringOrNull(args.description) ?? undefined,
    folder_path: stringOrNull(args.folder_path) ?? undefined,
    tags: arrayOfStrings(args.tags).slice(0, 24),
    variables: asStringRecord(args.variables) ?? undefined,
  })

  return {
    status: 'created',
    source: 'frontend_content_api',
    content: {
      id: created.id,
      name: created.name,
      content_type: created.content_type,
      description: created.description,
      folder_path: created.folder_path,
      tags: created.tags.slice(0, 24),
      variable_names: Object.keys(created.variables ?? {}).slice(0, 50),
      body_length: created.body.length,
      body_preview: limitText(created.body, 600),
      created_at: created.created_at,
      updated_at: created.updated_at,
    },
    notes: [
      'This content record was created by the logged-in website through its normal frontend API client.',
      'Advanced YOLO mode ran this named website tool without a confirmation card.',
      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
    ],
  }
}

async function updateContentForAssistant(args: Record<string, unknown>) {
  const contentId = stringOrNull(args.content_id)
  if (!contentId) {
    return {
      status: 'rejected',
      message: 'Content update requires content_id.',
    }
  }

  const update: {
    name?: string
    body?: string
    description?: string
    folder_path?: string
    tags?: string[]
    variables?: Record<string, string | null>
  } = {}
  const name = stringOrNull(args.name)
  if (name) update.name = name
  if (typeof args.body === 'string') update.body = args.body
  if (typeof args.description === 'string') update.description = args.description
  if (typeof args.folder_path === 'string') update.folder_path = args.folder_path
  if (Array.isArray(args.tags)) update.tags = arrayOfStrings(args.tags).slice(0, 24)
  const variables = asStringRecord(args.variables)
  if (variables) update.variables = variables

  const updated = await contentsApi.update(contentId, update)
  return {
    status: 'updated',
    source: 'frontend_content_api',
    content: {
      id: updated.id,
      name: updated.name,
      content_type: updated.content_type,
      description: updated.description,
      folder_path: updated.folder_path,
      tags: updated.tags.slice(0, 24),
      variable_names: Object.keys(updated.variables ?? {}).slice(0, 50),
      body_length: updated.body.length,
      body_preview: limitText(updated.body, 600),
      updated_at: updated.updated_at,
    },
    notes: [
      'This content record was updated by the logged-in website through its normal frontend API client.',
      'Advanced YOLO mode ran this named website tool without a confirmation card.',
      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
    ],
  }
}

async function buildCurrentPresetContentAssets(pageContext: ReturnType<typeof sanitizePageContext>) {
  const draft = getVisiblePresetDraft(pageContext)
  const ids: Array<{ slot: string; id: string | null; type_hint: ContentType | null }> = []

  if (!('status' in draft)) {
    const config = asRecord(draft.config)
    const evalConfig = asRecord(config?.eval)
    const combineConfig = asRecord(config?.combine)
    ids.push(
      { slot: 'generation_instructions', id: stringOrNull(draft.selectedInstructionId), type_hint: 'generation_instructions' },
      { slot: 'single_eval_instructions', id: stringOrNull(evalConfig?.singleEvalInstructionsId), type_hint: 'single_eval_instructions' },
      { slot: 'pairwise_eval_instructions', id: stringOrNull(evalConfig?.pairwiseEvalInstructionsId), type_hint: 'pairwise_eval_instructions' },
      { slot: 'combine_instructions', id: stringOrNull(combineConfig?.combineInstructionsId), type_hint: 'combine_instructions' },
    )
    const documentIds = Array.isArray(draft.selectedInputDocIds)
      ? draft.selectedInputDocIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
    documentIds.slice(0, 50).forEach((id, index) => {
      ids.push({ slot: `input_document_${index + 1}`, id, type_hint: 'input_document' })
    })
  }

  const loadedAssets = await Promise.all(
    ids
      .filter((item): item is { slot: string; id: string; type_hint: ContentType | null } => Boolean(item.id))
      .map(async (item) => {
        try {
          const detail = await contentsApi.get(item.id)
          return {
            slot: item.slot,
            id: detail.id,
            name: detail.name,
            content_type: detail.content_type,
            description: detail.description,
            folder_path: detail.folder_path,
            body_preview: limitText(detail.body, 240),
          }
        } catch (error) {
          return {
            slot: item.slot,
            id: item.id,
            content_type: item.type_hint,
            status: 'unavailable',
            message: error instanceof Error ? error.message : 'Content asset could not be loaded.',
          }
        }
      }),
  )

  return {
    status: 'loaded',
    source: 'visible_preset_draft',
    page_context: pageContext,
    preset_id: !('status' in draft) ? stringOrNull(draft.selectedPresetId) ?? pageContext.active_preset_id : pageContext.active_preset_id,
    assets: loadedAssets,
    attached_count: loadedAssets.length,
    missing_slots: ids.filter((item) => !item.id).map((item) => item.slot),
    notes: [
      'This maps visible preset attachment ids to bounded content-library metadata/previews.',
      'It does not load full document or instruction bodies.',
    ],
  }
}

async function startNewPresetDraft(pageContext: ReturnType<typeof sanitizePageContext>) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge?.startNewPresetDraft) {
    return {
      status: 'unavailable',
      message: 'No visible preset page draft reset is available.',
      page_context: pageContext,
    }
  }
  const previousDraft = window.acm2AssistantPresetBridge?.getDraft?.()
  const previousPresetId = previousDraft && typeof previousDraft === 'object'
    ? stringOrNull((previousDraft as Record<string, unknown>).selectedPresetId)
    : null
  const result = await bridge.startNewPresetDraft()
  await waitForBrowserFrame()
  const verification = buildCurrentPresetSummary(sanitizePageContext({
    ...pageContext,
    active_preset_id: null,
  }))
  return {
    status: result.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    previous_preset_id: previousPresetId,
    verification,
    notes: [
      'This started a clean visible preset draft before from-scratch configuration.',
      'This prevents save_current_preset_draft from accidentally updating the previously loaded preset.',
      'Advanced YOLO mode ran this named website tool without a confirmation card.',
    ],
  }
}

async function saveCurrentPresetDraft(pageContext: ReturnType<typeof sanitizePageContext>) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page is mounted, so there is no page-owned draft to save.',
      page_context: pageContext,
    }
  }

  const result = normalizePageBridgeMutationResult(await bridge.saveCurrentPreset(), 'saved')
  return {
    status: result.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    result,
    verification: buildCurrentPresetSummary(pageContext),
    notes: [
      'This write was performed by the logged-in website page through advanced YOLO mode.',
      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
    ],
  }
}

async function configureFpfPresetDraft(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page draft is mounted, so there is no page-owned draft to configure.',
      page_context: pageContext,
    }
  }

  const presetName = stringOrNull(args.preset_name)
  const runDescription = stringOrNull(args.run_description) ?? ''
  const generationInstructionsId = stringOrNull(args.generation_instructions_id)
  const inputDocumentIds = arrayOfStrings(args.input_document_ids).slice(0, 20)
  const model = stringOrNull(args.model) ?? 'openai:gpt-5-mini'
  if (!presetName || !generationInstructionsId || inputDocumentIds.length === 0) {
    return {
      status: 'rejected',
      message: 'FPF draft configuration requires preset_name, generation_instructions_id, and at least one input_document_id.',
      page_context: pageContext,
    }
  }

  const writes: Array<{ path: string; value: unknown; result: unknown }> = []
  const setDraftValue = async (path: string, value: unknown) => {
    const result = await bridge.setDraftValue(path, value)
    writes.push({ path, value, result })
  }

  await setDraftValue('presetName', presetName)
  await setDraftValue('runName', presetName)
  await setDraftValue('runDescription', runDescription)
  await setDraftValue('selectedInstructionId', generationInstructionsId)
  await setDraftValue('selectedInputDocIds', inputDocumentIds)
  await setDraftValue('inputSourceType', 'database')
  await setDraftValue('sourcePromptModeEnabled', false)

  const selectedModelList = [model]
  await setDraftValue('fpf.selectedModels', selectedModelList)
  await setDraftValue('fpf.enabled', true)

  const modelListPaths = [
    'gptr.selectedModels',
    'dr.selectedModels',
    'msagent.selectedModels',
    'aiq.selectedModels',
    'owl.selectedModels',
    'translationAgent.selectedModels',
    'marian.selectedModels',
    'pdfMathTranslate.selectedModels',
    'combine.selectedModels',
    'eval.judgeModels',
  ]
  for (const path of modelListPaths) {
    await setDraftValue(path, [])
  }

  const enabledPaths = [
    'gptr.enabled',
    'dr.enabled',
    'msagent.enabled',
    'aiq.enabled',
    'owl.enabled',
    'translationAgent.enabled',
    'marian.enabled',
    'pdfMathTranslate.enabled',
    'combine.enabled',
    'eval.enabled',
  ]
  for (const path of enabledPaths) {
    await setDraftValue(path, false)
  }
  await waitForBrowserFrame()

  return {
    status: 'configured',
    source: 'visible_preset_page',
    page_context: pageContext,
    preset_name: presetName,
    run_description: runDescription,
    engine: 'fpf',
    model,
    generation_instructions_id: generationInstructionsId,
    input_document_ids: inputDocumentIds,
    updated_paths: writes.map((item) => item.path),
    verification: buildCurrentPresetSummary(pageContext),
    notes: [
      'This configured a clean visible draft as an FPF-only preset.',
      'All non-FPF model selections were cleared for this milestone.',
      'Saving the preset remains a separate website action.',
      'Advanced YOLO mode ran this named website tool without a confirmation card.',
    ],
  }
}

async function waitForBrowserFrame() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

async function executeCurrentPreset(pageContext: ReturnType<typeof sanitizePageContext>) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page is mounted, so there is no page-owned preset execution workflow to use.',
      page_context: pageContext,
    }
  }

  const result = normalizePageBridgeMutationResult(await bridge.executeCurrentPreset(), 'started')
  return {
    status: result.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    result,
    run_id: typeof result === 'object' && 'run_id' in result ? result.run_id : null,
    execute_url: typeof result === 'object' && 'execute_url' in result ? result.execute_url : null,
    notes: [
      'This execution was started by the logged-in website page through advanced YOLO mode.',
      'The page-owned workflow performed its normal validation and run creation/start calls.',
      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
    ],
  }
}

async function attachGenerationInstructionsToCurrentPreset(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page draft is mounted, so there is no page-owned draft to update.',
      page_context: pageContext,
    }
  }

  const requestedId = stringOrNull(args.instruction_id) ?? stringOrNull(args.content_id)
  const nameQuery = stringOrNull(args.name_query)
  let instructionId = requestedId
  let contentRecord: Awaited<ReturnType<typeof contentsApi.get>> | null = null

  if (!instructionId && nameQuery) {
    const list = await contentsApi.list({
      content_type: 'generation_instructions',
      search: nameQuery,
      page: 1,
      page_size: 20,
    })
    const query = nameQuery.toLowerCase()
    const match = list.items.find((item) => item.name.toLowerCase().includes(query)) ?? list.items[0]
    instructionId = match?.id ?? null
  }

  if (!instructionId) {
    return {
      status: 'not_found',
      message: 'No generation-instructions content id or matching name was provided.',
      name_query: nameQuery,
      page_context: pageContext,
    }
  }

  try {
    contentRecord = await contentsApi.get(instructionId)
  } catch (error) {
    return {
      status: 'not_found',
      instruction_id: instructionId,
      message: error instanceof Error ? error.message : 'Generation-instructions content record could not be loaded.',
      page_context: pageContext,
    }
  }

  if (contentRecord.content_type !== 'generation_instructions') {
    return {
      status: 'rejected',
      instruction_id: instructionId,
      content_type: contentRecord.content_type,
      message: 'The selected content record is not a generation-instructions record.',
      page_context: pageContext,
    }
  }

  const result = normalizePageBridgeMutationResult(
    await bridge.setDraftValue('selectedInstructionId', instructionId),
    'updated',
  )
  return {
    status: result.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    generation_instructions_id: instructionId,
    content: {
      id: contentRecord.id,
      name: contentRecord.name,
      content_type: contentRecord.content_type,
      description: contentRecord.description,
      folder_path: contentRecord.folder_path,
      tags: contentRecord.tags.slice(0, 12),
      body_preview: limitText(contentRecord.body, 240),
    },
    result,
    verification: buildCurrentPresetSummary(pageContext),
    notes: [
      'This write updated only the visible preset draft through advanced YOLO mode.',
      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
      'Saving the preset remains a separate website action.',
    ],
  }
}

async function attachInputDocumentToCurrentPreset(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page draft is mounted, so there is no page-owned draft to update.',
      page_context: pageContext,
    }
  }

  const requestedId = stringOrNull(args.document_id) ?? stringOrNull(args.content_id)
  const nameQuery = stringOrNull(args.name_query)
  let documentId = requestedId
  let contentRecord: Awaited<ReturnType<typeof contentsApi.get>> | null = null

  if (!documentId && nameQuery) {
    const list = await contentsApi.list({
      content_type: 'input_document',
      search: nameQuery,
      page: 1,
      page_size: 20,
    })
    const query = nameQuery.toLowerCase()
    const match = list.items.find((item) => item.name.toLowerCase().includes(query)) ?? list.items[0]
    documentId = match?.id ?? null
  }

  if (!documentId) {
    return {
      status: 'not_found',
      message: 'No input-document content id or matching name was provided.',
      name_query: nameQuery,
      page_context: pageContext,
    }
  }

  try {
    contentRecord = await contentsApi.get(documentId)
  } catch (error) {
    return {
      status: 'not_found',
      input_document_id: documentId,
      message: error instanceof Error ? error.message : 'Input-document content record could not be loaded.',
      page_context: pageContext,
    }
  }

  if (contentRecord.content_type !== 'input_document') {
    return {
      status: 'rejected',
      input_document_id: documentId,
      content_type: contentRecord.content_type,
      message: 'The selected content record is not an input-document record.',
      page_context: pageContext,
    }
  }

  const draft = bridge.getDraft()
  const draftRecord = draft && typeof draft === 'object' ? draft as Record<string, unknown> : {}
  const existingIds = Array.isArray(draftRecord.selectedInputDocIds)
    ? draftRecord.selectedInputDocIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  const nextIds = Array.from(new Set([...existingIds, documentId]))
  const alreadyAttached = existingIds.includes(documentId)
  const result = alreadyAttached
    ? { status: 'unchanged', path: 'selectedInputDocIds', value: nextIds }
    : normalizePageBridgeMutationResult(
        await bridge.setDraftValue('selectedInputDocIds', nextIds),
        'updated',
      )
  const selectedDocumentsById = new Map<string, { id: string; name: string | null }>()
  if (Array.isArray(draftRecord.selectedInputDocuments)) {
    draftRecord.selectedInputDocuments.forEach((item) => {
      if (!item || typeof item !== 'object') return
      const record = item as Record<string, unknown>
      const id = stringOrNull(record.id)
      if (!id) return
      selectedDocumentsById.set(id, {
        id,
        name: stringOrNull(record.name),
      })
    })
  }
  selectedDocumentsById.set(documentId, {
    id: documentId,
    name: contentRecord.name,
  })
  const verification = buildCurrentPresetSummary(pageContext)
  const verificationRecord = verification as Record<string, unknown>
  const verificationSummary = asRecord(verificationRecord.summary)
  if (verificationSummary) {
    verificationRecord.summary = {
      ...verificationSummary,
      document_count: nextIds.length,
      selected_documents: nextIds.map((id) => selectedDocumentsById.get(id) ?? { id, name: id }),
    }
  }

  return {
    status: result.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    input_document_id: documentId,
    content: {
      id: contentRecord.id,
      name: contentRecord.name,
      content_type: contentRecord.content_type,
      description: contentRecord.description,
      folder_path: contentRecord.folder_path,
      tags: contentRecord.tags.slice(0, 12),
      body_preview: limitText(contentRecord.body, 240),
    },
    result,
    verification,
    notes: [
      'This write updated only the visible preset draft through advanced YOLO mode.',
      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
      'Saving the preset remains a separate website action.',
    ],
  }
}

async function attachEvalAssetToCurrentPreset(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page draft is mounted, so there is no page-owned draft to update.',
      page_context: pageContext,
    }
  }

  const requestedId = stringOrNull(args.instruction_id) ?? stringOrNull(args.criteria_id) ?? stringOrNull(args.content_id)
  const nameQuery = stringOrNull(args.name_query)
  let contentType = normalizeEvalAttachmentContentType(args.content_type)
    ?? normalizeEvalAttachmentContentType(args.kind)
    ?? normalizeEvalAttachmentContentType(args.slot)
    ?? inferEvalAttachmentContentTypeFromQuery(nameQuery)
  let contentId = requestedId
  let contentRecord: Awaited<ReturnType<typeof contentsApi.get>> | null = null

  if (!contentId && nameQuery && contentType) {
    const list = await contentsApi.list({
      content_type: contentType,
      search: nameQuery,
      page: 1,
      page_size: 20,
    })
    const query = nameQuery.toLowerCase()
    const match = list.items.find((item) => item.name.toLowerCase().includes(query)) ?? list.items[0]
    contentId = match?.id ?? null
  }

  if (!contentId) {
    return {
      status: 'not_found',
      message: 'No eval instruction/criteria content id or matching name/type was provided.',
      name_query: nameQuery,
      content_type: contentType,
      page_context: pageContext,
    }
  }

  try {
    contentRecord = await contentsApi.get(contentId)
  } catch (error) {
    return {
      status: 'not_found',
      eval_asset_id: contentId,
      message: error instanceof Error ? error.message : 'Eval instruction/criteria content record could not be loaded.',
      page_context: pageContext,
    }
  }

  const recordType = normalizeEvalAttachmentContentType(contentRecord.content_type)
  if (!recordType) {
    return {
      status: 'rejected',
      eval_asset_id: contentId,
      content_type: contentRecord.content_type,
      message: 'The selected content record is not a single-eval instruction, pairwise-eval instruction, or eval-criteria record.',
      page_context: pageContext,
    }
  }
  if (contentType && recordType !== contentType) {
    return {
      status: 'rejected',
      eval_asset_id: contentId,
      requested_content_type: contentType,
      content_type: contentRecord.content_type,
      message: 'The selected content record does not match the requested eval attachment slot.',
      page_context: pageContext,
    }
  }

  contentType = recordType
  const path = evalAttachmentDraftPath(contentType)
  const result = normalizePageBridgeMutationResult(
    await bridge.setDraftValue(path, contentId),
    'updated',
  )

  return {
    status: result.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    eval_asset_id: contentId,
    content_type: contentType,
    draft_path: path,
    content: {
      id: contentRecord.id,
      name: contentRecord.name,
      content_type: contentRecord.content_type,
      description: contentRecord.description,
      folder_path: contentRecord.folder_path,
      tags: contentRecord.tags.slice(0, 12),
      body_preview: limitText(contentRecord.body, 240),
    },
    result,
	    verification: buildCurrentPresetInstructions(pageContext),
	    notes: [
	      'This write updated only the visible preset draft through advanced YOLO mode.',
	      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
	      'Saving the preset remains a separate website action.',
	    ],
	  }
}

async function attachCombineInstructionsToCurrentPreset(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page draft is mounted, so there is no page-owned draft to update.',
      page_context: pageContext,
    }
  }

  const requestedId = stringOrNull(args.instruction_id) ?? stringOrNull(args.content_id)
  const nameQuery = stringOrNull(args.name_query)
  let instructionId = requestedId
  let contentRecord: Awaited<ReturnType<typeof contentsApi.get>> | null = null

  if (!instructionId && nameQuery) {
    const list = await contentsApi.list({
      content_type: 'combine_instructions',
      search: nameQuery,
      page: 1,
      page_size: 20,
    })
    const query = nameQuery.toLowerCase()
    const match = list.items.find((item) => item.name.toLowerCase().includes(query)) ?? list.items[0]
    instructionId = match?.id ?? null
  }

  if (!instructionId) {
    return {
      status: 'not_found',
      message: 'No combine-instructions content id or matching name was provided.',
      name_query: nameQuery,
      page_context: pageContext,
    }
  }

  try {
    contentRecord = await contentsApi.get(instructionId)
  } catch (error) {
    return {
      status: 'not_found',
      combine_instructions_id: instructionId,
      message: error instanceof Error ? error.message : 'Combine-instructions content record could not be loaded.',
      page_context: pageContext,
    }
  }

  if (contentRecord.content_type !== 'combine_instructions') {
    return {
      status: 'rejected',
      combine_instructions_id: instructionId,
      content_type: contentRecord.content_type,
      message: 'The selected content record is not a combine-instructions record.',
      page_context: pageContext,
    }
  }

  const result = normalizePageBridgeMutationResult(
    await bridge.setDraftValue('combine.combineInstructionsId', instructionId),
    'updated',
  )

  return {
    status: result.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    combine_instructions_id: instructionId,
    content: {
      id: contentRecord.id,
      name: contentRecord.name,
      content_type: contentRecord.content_type,
      description: contentRecord.description,
      folder_path: contentRecord.folder_path,
      tags: contentRecord.tags.slice(0, 12),
      body_preview: limitText(contentRecord.body, 240),
    },
    result,
	    verification: buildCurrentPresetInstructions(pageContext),
	    notes: [
	      'This write updated only the visible preset draft through advanced YOLO mode.',
	      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
	      'Saving the preset remains a separate website action.',
	    ],
	  }
}

async function setCurrentPresetEngineModels(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const bridge = window.acm2AssistantPresetBridge
  if (!bridge) {
    return {
      status: 'unavailable',
      message: 'No visible preset page draft is mounted, so there is no page-owned draft to update.',
      page_context: pageContext,
    }
  }

  const engine = normalizeModelEngine(args.engine)
  if (!engine) {
    return {
      status: 'rejected',
      message: 'A supported engine is required before model selections can be changed.',
      requested_engine: args.engine,
      supported_engines: ['fpf', 'gptr', 'dr', 'msagent', 'aiq', 'owl', 'translation_agent', 'marian', 'pdfmathtranslate', 'eval', 'combine'],
      page_context: pageContext,
    }
  }

  const models = uniqueStrings(Array.isArray(args.models) ? args.models : [])
  if (models.length > 12) {
    return {
      status: 'rejected',
      message: 'At most 12 models can be selected for one engine in a single assistant action.',
      requested_count: models.length,
      page_context: pageContext,
    }
  }

  const { selectedPath, enabledPath } = modelEngineDraftPaths(engine)
  const modelResult = normalizePageBridgeMutationResult(
    await bridge.setDraftValue(selectedPath, models),
    'updated',
  )
  if (modelResult.status !== 'updated') {
    return {
      status: modelResult.status,
      engine,
      selected_models: models,
      result: modelResult,
      page_context: pageContext,
    }
  }
  const enabledResult = normalizePageBridgeMutationResult(
    await bridge.setDraftValue(enabledPath, models.length > 0),
    'updated',
  )

  return {
    status: enabledResult.status,
    source: 'visible_preset_page',
    page_context: pageContext,
    engine,
    selected_models: models,
    enabled: models.length > 0,
    updated_paths: [selectedPath, enabledPath],
    result: {
      selected_models: modelResult,
      enabled: enabledResult,
    },
	    verification: buildCurrentPresetModels(pageContext),
	    notes: [
	      'This write updated only the visible preset draft through advanced YOLO mode.',
	      'The advanced assistant did not receive browser tokens, database keys, provider keys, or raw backend API authority.',
	      'Saving the preset remains a separate website action.',
	    ],
	  }
}

function getVisiblePresetDraft(pageContext: ReturnType<typeof sanitizePageContext>) {
  const draft = window.acm2AssistantPresetBridge?.getDraft?.()
  if (!draft || typeof draft !== 'object') {
    return {
      status: 'unavailable',
      message: 'No visible preset draft is available on the current website page.',
      page_context: pageContext,
    }
  }
  return draft as Record<string, unknown>
}

function normalizeModelBuckets(buckets: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(buckets).map(([key, value]) => [key, uniqueStrings(value).slice(0, 40)]),
  )
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
}

function runGeneratedDocumentCount(run: Record<string, unknown>) {
  const loadedCount = Array.isArray(run.generated_docs) ? run.generated_docs.length : 0
  const canonicalCount = typeof run.generated_document_count === 'number'
    ? run.generated_document_count
    : 0
  return loadedCount > 0 ? loadedCount : Math.max(0, canonicalCount)
}


async function buildRunStatusSummary(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const run = await loadRunForAdvancedTool(pageContext, args)
  if (!run) {
    return { status: 'unavailable', message: 'No current or recent run is available to inspect.', page_context: pageContext }
  }
  const generatedDocumentCount = runGeneratedDocumentCount(run)
  const state = typeof run.status === 'string' ? run.status : 'unknown'
  return {
    status: 'loaded',
    source: 'frontend_run_api',
    page_context: pageContext,
    run_id: stringOrNull(run.id),
    resolved_run: {
      requested_run_id: getRunIdFromArgs(args) ?? pageContext.current_run_id,
      source: pageContext.current_run_id ? 'page_context' : 'latest_run',
    },
    summary: {
      state,
      finished: ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(state),
      research_completed: state === 'completed' || state === 'completed_with_errors',
      outputs_available: generatedDocumentCount > 0,
      generated_document_count: generatedDocumentCount,
      started_at: stringOrNull(run.started_at),
      updated_at: stringOrNull(run.completed_at) ?? stringOrNull(run.started_at) ?? stringOrNull(run.created_at),
    },
    notes: ['This is a high-level run summary only.', 'Use failure and output tools for deeper diagnosis.'],
  }
}

async function buildRecentRunsForAssistant(args: Record<string, unknown>) {
  const limit = clampPositiveInt(args.limit, 10, 1, 50)
  const runs = await runsApi.list({ limit })
  return {
    status: 'loaded',
    source: 'frontend_run_api',
    count: runs.length,
    latest_run_id: runs.length > 0 ? stringOrNull((runs[0] as unknown as Record<string, unknown>).id) : null,
    runs: runs.map((run) => buildAdvancedRunListItem(run as unknown as Record<string, unknown>)),
    interpretation_notes: [
      'This list comes from the logged-in website run API client.',
      'It is safe for the assistant because the website owns auth and returns only data visible to the current logged-in user.',
    ],
  }
}

async function buildLatestRunContext(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const run = await loadRunForAdvancedTool(pageContext, args)
  if (!run) {
    return { status: 'unavailable', message: 'No current or recent run is available to inspect.', page_context: pageContext }
  }

  const runId = stringOrNull(run.id)
  const contextArgs = runId ? { ...args, run_id: runId } : args
  const includeFailureSignals = args.include_failure_signals !== false
  const includeOutputSummary = args.include_output_summary !== false

  return {
    status: 'loaded',
    source: 'frontend_run_api',
    page_context: pageContext,
    latest_run_id: runId,
    run: buildAdvancedRunListItem(run),
    status_summary: await buildRunStatusSummary(pageContext, contextArgs),
    failure_signals: includeFailureSignals ? await buildRunFailureSignals(pageContext, contextArgs) : undefined,
    output_summary: includeOutputSummary ? await buildRunOutputSummary(pageContext, contextArgs) : undefined,
    interpretation_notes: [
      'This is the preferred domain-wide answer source for questions about the latest or last run.',
      'If a run is selected on the current page, that selected run wins; otherwise the bridge uses remembered run context or the most recent run visible to the website.',
    ],
  }
}

async function loadRunForAssistant(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const run = await loadRunForAdvancedTool(pageContext, args)
  if (!run) {
    return { status: 'unavailable', message: 'No current or recent run is available to inspect.', page_context: pageContext }
  }
  return {
    status: 'loaded',
    source: 'frontend_run_api',
    page_context: pageContext,
    run_id: stringOrNull(run.id),
    run: buildAdvancedRunListItem(run),
    raw_run_omitted_from_assistant_payload: true,
    interpretation_notes: [
      'This is a bounded run detail summary for assistant use, not the raw backend run payload.',
      'Use run status, failure, output, or log tools for deeper evidence when needed.',
    ],
  }
}

async function buildRunFailureSignals(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const run = await loadRunForAdvancedTool(pageContext, args)
  if (!run) {
    return { status: 'unavailable', message: 'No current or recent run is available to inspect.', page_context: pageContext }
  }
  const classification = args.classification === 'all' ? 'all' : 'event'
  const logs = await loadRunLogsForAdvancedTool(stringOrNull(run.id) ?? '', classification)
  const evidence: Array<{ kind: string; message: string }> = []
  const errors: string[] = []
  const warnings: string[] = []
  const state = stringOrNull(run.status) ?? 'unknown'
  const errorMessage = stringOrNull(run.error_message)
  const generatedDocumentCount = runGeneratedDocumentCount(run)

  if (state === 'failed') {
    errors.push('The run finished in a failed state.')
    evidence.push({ kind: 'run_state', message: 'Run finished in failed state.' })
  }
  if (state === 'completed_with_errors') {
    warnings.push('The run completed with errors.')
    evidence.push({ kind: 'run_state', message: 'Run completed with errors.' })
  }
  if (errorMessage) {
    errors.push(redactLogText(errorMessage))
    evidence.push({ kind: 'run_error', message: redactLogText(errorMessage) })
  }
  if (generatedDocumentCount === 0 && ['failed', 'completed_with_errors'].includes(state)) {
    errors.push('No generated documents are visible for this terminal run.')
    evidence.push({ kind: 'outputs', message: 'No generated documents are visible for this terminal run.' })
  }
  for (const entry of logs.entries.slice(0, 200)) {
    const message = redactLogText(String(entry.message ?? entry.text ?? entry.event ?? ''))
    if (!message) continue
    const lower = message.toLowerCase()
    if (lower.includes('error') || lower.includes('failed') || lower.includes('exception')) {
      errors.push(message)
      evidence.push({ kind: 'log_event', message })
    } else if (lower.includes('warning') || lower.includes('retry')) {
      warnings.push(message)
    }
  }

  return {
    status: 'loaded',
    source: 'frontend_run_api',
    page_context: pageContext,
    run_id: stringOrNull(run.id),
    signals: {
      severity: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'none',
      top_errors: uniqueStrings(errors).slice(0, 5),
      warnings: uniqueStrings(warnings).slice(0, 5),
      evidence: uniqueEvidence(evidence).slice(0, 8),
    },
    next_steps: errors.length > 0
      ? ['Inspect the failing run logs and fix the first blocking error before retrying.']
      : ['No strong failure signal was visible in the bounded frontend run data.'],
    interpretation_notes: [
      'Failure signals are visible evidence from run state and event logs, not a complete backend root-cause proof.',
      'Sparse or missing logs should be explained as limited evidence.',
    ],
  }
}

async function buildRunOutputSummary(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const run = await loadRunForAdvancedTool(pageContext, args)
  if (!run) {
    return { status: 'unavailable', message: 'No current or recent run is available to inspect.', page_context: pageContext }
  }
  const generatedDocs = Array.isArray(run.generated_docs) ? run.generated_docs.slice(0, 20) : []
  const items = generatedDocs.map((doc) => {
    const record = asRecord(doc) ?? {}
    return {
      id: stringOrNull(record.id),
      title: stringOrNull(record.filename) ?? stringOrNull(record.title) ?? stringOrNull(record.id),
      model: stringOrNull(record.model),
      source_doc_id: stringOrNull(record.source_doc_id),
      generator: stringOrNull(record.generator),
      completion_status: stringOrNull(record.completion_status),
    }
  })
  return {
    status: 'loaded',
    source: 'frontend_run_api',
    page_context: pageContext,
    run_id: stringOrNull(run.id),
    outputs: {
      generated_document_count: runGeneratedDocumentCount(run),
      outputs_available: generatedDocs.length > 0,
      items,
    },
    interpretation_notes: [
      'Output availability means generated document metadata is visible; it does not load full document contents.',
    ],
  }
}

async function loadRunLogsForAssistant(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const run = await loadRunForAdvancedTool(pageContext, args)
  if (!run) {
    return { status: 'unavailable', message: 'No current or recent run is available to inspect.', page_context: pageContext }
  }
  const classification = args.classification === 'all' ? 'all' : 'event'
  const requestedLimit = clampPositiveInt(args.limit, classification === 'all' ? 300 : 200, 25, 500)
  const logs = await loadRunLogsForAdvancedTool(stringOrNull(run.id) ?? '', classification, requestedLimit)
  const entries = logs.entries
  const signals = extractRunLogSignals(entries)
  const artifactEvidence = extractRunArtifactEvidence(entries)
  return {
    status: 'loaded',
    source: 'frontend_run_api',
    page_context: pageContext,
    run_id: stringOrNull(run.id),
    classification,
    log_window: {
      requested_limit: requestedLimit,
      response_limit: logs.limit,
      response_offset: logs.offset,
      response_total: logs.total,
      returned_entries: entries.length,
      raw_entries_omitted_from_assistant_payload: true,
    },
    run_summary: {
      state: stringOrNull(run.status) ?? 'unknown',
      finished: ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(stringOrNull(run.status) ?? ''),
      generated_document_count: runGeneratedDocumentCount(run),
      started_at: stringOrNull(run.started_at),
      updated_at: stringOrNull(run.completed_at) ?? stringOrNull(run.started_at) ?? stringOrNull(run.created_at),
    },
    summary: {
      level_counts: countLogField(entries, 'level'),
      event_type_counts: countLogField(entries, 'event_type'),
      source_counts: countLogField(entries, 'source'),
    },
    concrete_failure_evidence: signals.errors.slice(0, 8),
    warnings: signals.warnings.slice(0, 8),
    notable_events: signals.notable.slice(0, 8),
    queue_or_worker_samples: extractQueueOrWorkerSamples(entries).slice(0, 8),
    artifact_evidence_from_logs: artifactEvidence.generated_save_event_count > 0 || artifactEvidence.generated_file_save_message_count > 0
      ? artifactEvidence
      : undefined,
    sampled_entries: buildRunLogSamples(entries, signals).slice(0, 12),
    interpretation_notes: [
      'This tool returns a compact evidence summary, not the raw log payload.',
      'Use concrete_failure_evidence and sampled_entries for citations; do not claim absence of errors unless the returned log window is adequate.',
      'If the user asks for queue, worker, task, or job evidence, prefer queue_or_worker_samples before generic sampled_entries.',
      'Volatile internal task, job, and worker identifiers are redacted because they are rarely needed for user diagnosis.',
    ],
  }
}

function buildAdvancedRunListItem(run: Record<string, unknown>) {
  const generatedDocs = Array.isArray(run.generated_docs) ? run.generated_docs : []
  const state = stringOrNull(run.status) ?? 'unknown'
  return {
    id: stringOrNull(run.id),
    name: stringOrNull(run.name) ?? stringOrNull(run.title) ?? stringOrNull(run.id),
    description: stringOrNull(run.description),
    status: state,
    finished: ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(state),
    outputs_available: generatedDocs.length > 0,
    generated_document_count: generatedDocs.length,
    created_at: stringOrNull(run.created_at),
    started_at: stringOrNull(run.started_at),
    completed_at: stringOrNull(run.completed_at),
    updated_at: stringOrNull(run.completed_at) ?? stringOrNull(run.started_at) ?? stringOrNull(run.created_at),
    error_message: stringOrNull(run.error_message) ? redactLogText(stringOrNull(run.error_message) ?? '') : null,
  }
}

async function loadRunForAdvancedTool(
  pageContext: ReturnType<typeof sanitizePageContext>,
  args: Record<string, unknown>,
) {
  const explicitRunId = getRunIdFromArgs(args)
  const runId = explicitRunId ?? pageContext.current_run_id ?? getRememberedRunId()
  if (runId) {
    return (await runsApi.getExecutionView(runId)) as unknown as Record<string, unknown>
  }
  const runs = await runsApi.list({ limit: 1 })
  return (runs[0] ?? null) as unknown as Record<string, unknown> | null
}

async function loadRunLogsForAdvancedTool(runId: string, classification: 'event' | 'all', limit = 200) {
  if (!runId) return { entries: [] as Array<Record<string, unknown>>, limit: null, offset: null, total: null }
  try {
    const logs = await apiClient.get<{
      entries?: Array<Record<string, unknown>>
      limit?: number | null
      offset?: number | null
      total?: number | null
    }>(`/runs/${runId}/logs`, {
      classification,
      limit,
    })
    return {
      entries: Array.isArray(logs.entries) ? logs.entries : [],
      limit: typeof logs.limit === 'number' ? logs.limit : null,
      offset: typeof logs.offset === 'number' ? logs.offset : null,
      total: typeof logs.total === 'number' ? logs.total : null,
    }
  } catch {
    return { entries: [] as Array<Record<string, unknown>>, limit: null, offset: null, total: null }
  }
}

function getRunIdFromArgs(args: Record<string, unknown>) {
  return stringOrNull(args.run_id) ?? stringOrNull(args.current_run_id) ?? stringOrNull(args.latest_run_id)
}

function getRememberedRunId() {
  try {
    return stringOrNull(window.sessionStorage.getItem('acm2CurrentRunId'))
  } catch {
    return null
  }
}

function redactLogText(value: string) {
  return value
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted-token]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .slice(0, 500)
}

function uniqueEvidence(items: Array<{ kind: string; message: string }>) {
  const seen = new Set<string>()
  const result: Array<{ kind: string; message: string }> = []
  for (const item of items) {
    const key = `${item.kind}:${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function extractRunLogSignals(entries: Array<Record<string, unknown>>) {
  const errors: Array<Record<string, unknown>> = []
  const warnings: Array<Record<string, unknown>> = []
  const notable: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    const message = stringOrNull(entry.message) ?? stringOrNull(entry.text) ?? stringOrNull(entry.event) ?? ''
    if (!message) continue
    const lower = message.toLowerCase()
    const level = (stringOrNull(entry.level) ?? '').toUpperCase()
    const eventType = (stringOrNull(entry.event_type) ?? '').toLowerCase()
    const evidence = buildRunLogEvidenceEntry(entry)
    if (
      level === 'ERROR' ||
      eventType.includes('failed') ||
      eventType.includes('error') ||
      lower.includes('exception') ||
      lower.includes('traceback') ||
      lower.includes('timed out') ||
      lower.includes('tool calling failed') ||
      lower.includes('generation failed') ||
      lower.includes('worker failed') ||
      lower.includes('job failed')
    ) {
      errors.push(evidence)
      continue
    }
    if (level === 'WARNING' || lower.includes('warning') || lower.includes('blocked') || lower.includes('retry')) {
      warnings.push(evidence)
      continue
    }
    if (
      eventType.includes('saved') ||
      eventType.includes('worker') ||
      lower.includes('doc_id=') ||
      lower.includes('queued') ||
      lower.includes('cancelled') ||
      lower.includes('completed')
    ) {
      notable.push(evidence)
    }
  }
  return {
    errors: uniqueLogEvidence(errors),
    warnings: uniqueLogEvidence(warnings),
    notable: uniqueLogEvidence(notable),
  }
}

function buildRunLogSamples(
  entries: Array<Record<string, unknown>>,
  signals: ReturnType<typeof extractRunLogSignals>,
) {
  const prioritized = [
    ...signals.errors,
    ...signals.warnings,
    ...signals.notable,
    ...entries.slice(0, 2).map(buildRunLogEvidenceEntry),
    ...entries.slice(Math.max(0, entries.length - 2)).map(buildRunLogEvidenceEntry),
  ]
  return uniqueLogEvidence(prioritized)
}

function extractQueueOrWorkerSamples(entries: Array<Record<string, unknown>>) {
  const matches: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    const message = stringOrNull(entry.message) ?? stringOrNull(entry.text) ?? stringOrNull(entry.event) ?? ''
    const lower = message.toLowerCase()
    const eventType = (stringOrNull(entry.event_type) ?? '').toLowerCase()
    const source = (stringOrNull(entry.source) ?? '').toLowerCase()
    if (
      eventType.includes('queue') ||
      eventType.includes('worker') ||
      source.includes('queue') ||
      source.includes('worker') ||
      lower.includes(' queue ') ||
      lower.includes('worker') ||
      lower.includes('task_id=') ||
      lower.includes('job=') ||
      lower.includes('live_workers=') ||
      lower.includes('stale_workers=')
    ) {
      matches.push(buildRunLogEvidenceEntry(entry))
    }
  }
  return uniqueLogEvidence(matches)
}

function buildRunLogEvidenceEntry(entry: Record<string, unknown>) {
  return {
    id: entry.id ?? null,
    timestamp: stringOrNull(entry.timestamp),
    level: stringOrNull(entry.level),
    event_type: stringOrNull(entry.event_type),
    source: stringOrNull(entry.source),
    message: limitText(redactLogText(stringOrNull(entry.message) ?? stringOrNull(entry.text) ?? stringOrNull(entry.event) ?? ''), 500),
    payload_preview: stringOrNull(entry.payload)
      ? limitText(redactLogText(stringOrNull(entry.payload) ?? ''), 350)
      : null,
  }
}

function uniqueLogEvidence<T extends Record<string, unknown>>(values: T[]) {
  const seen = new Set<string>()
  const result: T[] = []
  for (const value of values) {
    const key = `${value.id ?? ''}:${value.timestamp ?? ''}:${value.message ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function countLogField(entries: Array<Record<string, unknown>>, field: 'level' | 'event_type' | 'source') {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    const value = stringOrNull(entry[field]) ?? 'unknown'
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function extractRunArtifactEvidence(entries: Array<Record<string, unknown>>) {
  const generatedArtifacts: Array<Record<string, unknown>> = []
  let generatedSaveEventCount = 0
  let generatedFileSaveMessageCount = 0
  let evalSaveEventCount = 0
  for (const entry of entries) {
    const message = stringOrNull(entry.message) ?? ''
    if (!message) continue
    const eventType = (stringOrNull(entry.event_type) ?? '').toLowerCase()
    const lower = message.toLowerCase()
    const isGeneratedSaveEvent =
      eventType === 'gen_saved' ||
      /gen(?:eration)?\s*#?\d*.*doc_id=/i.test(message) ||
      lower.includes('saved generated content')
    const isGeneratedFileSaveMessage = lower.includes('saved generated content')
    const isEvalSaveEvent =
      eventType === 'eval_saved' ||
      /eval\s*#?\d+.*saved/i.test(message) ||
      lower.includes('eval saved')
    if (isGeneratedSaveEvent) {
      generatedSaveEventCount += 1
      if (generatedArtifacts.length < 8) {
        generatedArtifacts.push({
          timestamp: stringOrNull(entry.timestamp),
          doc_id: extractLogValue(message, 'doc_id'),
          model: extractLogValue(message, 'model'),
          source: 'log_event',
          message: limitText(redactLogText(message), 260),
        })
      }
    }
    if (isGeneratedFileSaveMessage) generatedFileSaveMessageCount += 1
    if (isEvalSaveEvent) evalSaveEventCount += 1
  }
  return {
    generated_save_event_count: generatedSaveEventCount,
    generated_file_save_message_count: generatedFileSaveMessageCount,
    eval_save_event_count: evalSaveEventCount,
    generated_artifacts: generatedArtifacts,
    notes: [
      'This evidence is extracted from user-visible run logs.',
      'It does not prove output documents are retrievable through the output API.',
      'Do not infer exact backend schema or storage internals from these messages.',
    ],
  }
}

function extractLogValue(message: string, key: string) {
  const match = message.match(new RegExp(`${key}=([^,\\s]+)`, 'i'))
  return match?.[1] ?? null
}


function getDraftGenerationModelCount(config: Record<string, unknown>) {
  const generationSections = [
    'fpf',
    'gptr',
    'dr',
    'msagent',
    'aiq',
    'owl',
    'translationAgent',
    'marian',
    'pdfMathTranslate',
  ]
  return generationSections.reduce((count, sectionKey) => {
    const section = asRecord(config[sectionKey])
    return count + arrayOfStrings(section?.selectedModels).length
  }, 0)
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}


function getEnabledDraftEngines(config: Record<string, unknown> | null) {
  if (!config) return []
  const engines = [
    ['fpf', 'fpf'],
    ['gptr', 'gptr'],
    ['dr', 'dr'],
    ['msagent', 'msagent'],
    ['aiq', 'aiq'],
    ['owl', 'owl'],
    ['translationAgent', 'translation_agent'],
    ['marian', 'marian'],
    ['pdfMathTranslate', 'pdfmathtranslate'],
    ['combine', 'combine'],
  ] as const
  return engines
    .filter(([key]) => Boolean(asRecord(config[key])?.enabled))
    .map(([, label]) => label)
}

function getSelectedDraftModels(config: Record<string, unknown> | null) {
  if (!config) return []
  const models = new Set<string>()
  for (const value of Object.values(config)) {
    const section = asRecord(value)
    if (!section) continue
    const selectedModels = section.selectedModels
    if (Array.isArray(selectedModels)) {
      for (const model of selectedModels) {
        if (typeof model === 'string' && model.trim()) models.add(model.trim())
      }
    }
    const selectedModel = section.selectedModel
    if (typeof selectedModel === 'string' && selectedModel.trim()) models.add(selectedModel.trim())
  }
  return [...models].slice(0, 40)
}

function getDraftReportModes(config: Record<string, unknown> | null, enabledEngines: string[]) {
  if (!config) return []
  const modes = new Set<string>()
  if (enabledEngines.length) modes.add(`engines:${enabledEngines.join('+')}`)
  for (const key of ['gptr', 'aiq', 'msagent']) {
    const section = asRecord(config[key])
    const reportType = stringOrNull(section?.reportType) ?? stringOrNull(section?.report_type)
    if (reportType) modes.add(reportType)
  }
  return [...modes].slice(0, 12)
}

function getDraftSearchProvider(config: Record<string, unknown> | null) {
  if (!config) return null
  for (const key of ['gptr', 'dr', 'msagent', 'aiq']) {
    const section = asRecord(config[key])
    const provider =
      stringOrNull(section?.runSearchProvider) ??
      stringOrNull(section?.searchProvider) ??
      stringOrNull(section?.run_search_provider) ??
      stringOrNull(section?.search_provider) ??
      stringOrNull(section?.retriever)
    if (provider) return provider
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asStringRecord(value: unknown): Record<string, string | null> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const result: Record<string, string | null> = {}
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    if (!key.trim()) return
    if (item === null || typeof item === 'string') {
      result[key] = item
    }
  })
  return Object.keys(result).length > 0 ? result : null
}

function limitText(value: unknown, limit: number) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 80)).trimEnd()}\n\n[truncated to ${limit} characters from ${text.length}]`
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

function normalizeContentType(value: unknown): ContentType | null {
  const normalized = stringOrNull(value)?.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_')
  if (!normalized) return null
  const aliases: Record<string, ContentType> = {
    generation_instruction: 'generation_instructions',
    generation_instructions: 'generation_instructions',
    instruction: 'generation_instructions',
    instructions: 'generation_instructions',
    prompt: 'generation_instructions',
    prompts: 'generation_instructions',
    input: 'input_document',
    input_document: 'input_document',
    input_documents: 'input_document',
    document: 'input_document',
    documents: 'input_document',
    topic: 'input_document',
    topic_file: 'input_document',
    topic_files: 'input_document',
    topic_document: 'input_document',
    source: 'input_document',
    source_material: 'input_document',
    single_eval: 'single_eval_instructions',
    single_eval_instruction: 'single_eval_instructions',
    pairwise_eval: 'pairwise_eval_instructions',
    pairwise_eval_instruction: 'pairwise_eval_instructions',
    evaluation_criteria: 'eval_criteria',
    combine_instruction: 'combine_instructions',
    template_fragments: 'template_fragment',
    output: 'output_document',
    output_documents: 'output_document',
    log: 'logs',
  }
  if (aliases[normalized]) return aliases[normalized]
  const allowed: ContentType[] = [
    'generation_instructions',
    'input_document',
    'single_eval_instructions',
    'pairwise_eval_instructions',
    'eval_criteria',
    'combine_instructions',
    'template_fragment',
    'output_document',
    'logs',
  ]
  return allowed.includes(normalized as ContentType) ? (normalized as ContentType) : null
}

type EvalAttachmentContentType = 'single_eval_instructions' | 'pairwise_eval_instructions' | 'eval_criteria'

function normalizeEvalAttachmentContentType(value: unknown): EvalAttachmentContentType | null {
  const normalized = stringOrNull(value)?.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_')
  if (!normalized) return null
  if (['single_eval', 'single_eval_instruction', 'single_eval_instructions'].includes(normalized)) {
    return 'single_eval_instructions'
  }
  if (['pairwise_eval', 'pairwise_eval_instruction', 'pairwise_eval_instructions'].includes(normalized)) {
    return 'pairwise_eval_instructions'
  }
  if (['eval_criteria', 'evaluation_criteria', 'criteria', 'rubric'].includes(normalized)) {
    return 'eval_criteria'
  }
  return null
}

function inferEvalAttachmentContentTypeFromQuery(value: unknown): EvalAttachmentContentType | null {
  const text = stringOrNull(value)?.toLowerCase()
  if (!text) return null
  if (text.includes('pairwise')) return 'pairwise_eval_instructions'
  if (text.includes('single')) return 'single_eval_instructions'
  if (text.includes('criteria') || text.includes('criterion') || text.includes('rubric')) return 'eval_criteria'
  if (text.includes('eval') || text.includes('evaluation') || text.includes('judge')) return 'single_eval_instructions'
  return null
}

function evalAttachmentDraftPath(contentType: EvalAttachmentContentType) {
  if (contentType === 'single_eval_instructions') return 'eval.singleEvalInstructionsId'
  if (contentType === 'pairwise_eval_instructions') return 'eval.pairwiseEvalInstructionsId'
  return 'eval.evalCriteriaId'
}

type ModelEngine =
  | 'fpf'
  | 'gptr'
  | 'dr'
  | 'msagent'
  | 'aiq'
  | 'owl'
  | 'translation_agent'
  | 'marian'
  | 'pdfmathtranslate'
  | 'eval'
  | 'combine'

function normalizeModelEngine(value: unknown): ModelEngine | null {
  const normalized = stringOrNull(value)?.toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_')
  if (!normalized) return null
  const aliases: Record<string, ModelEngine> = {
    fpf: 'fpf',
    filepromptforge: 'fpf',
    file_prompt_forge: 'fpf',
    gptr: 'gptr',
    gpt_researcher: 'gptr',
    dr: 'dr',
    deep_research: 'dr',
    msagent: 'msagent',
    ms_agent: 'msagent',
    aiq: 'aiq',
    owl: 'owl',
    translation_agent: 'translation_agent',
    translationagent: 'translation_agent',
    marian: 'marian',
    pdfmathtranslate: 'pdfmathtranslate',
    pdf_math_translate: 'pdfmathtranslate',
    eval: 'eval',
    evaluation: 'eval',
    judge: 'eval',
    combine: 'combine',
    gold_standard: 'combine',
  }
  return aliases[normalized] ?? null
}

function modelEngineDraftPaths(engine: ModelEngine) {
  const selectedPathByEngine: Record<ModelEngine, string> = {
    fpf: 'fpf.selectedModels',
    gptr: 'gptr.selectedModels',
    dr: 'dr.selectedModels',
    msagent: 'msagent.selectedModels',
    aiq: 'aiq.selectedModels',
    owl: 'owl.selectedModels',
    translation_agent: 'translationAgent.selectedModels',
    marian: 'marian.selectedModels',
    pdfmathtranslate: 'pdfMathTranslate.selectedModels',
    eval: 'eval.judgeModels',
    combine: 'combine.selectedModels',
  }
  const enabledPathByEngine: Record<ModelEngine, string> = {
    fpf: 'fpf.enabled',
    gptr: 'gptr.enabled',
    dr: 'dr.enabled',
    msagent: 'msagent.enabled',
    aiq: 'aiq.enabled',
    owl: 'owl.enabled',
    translation_agent: 'translationAgent.enabled',
    marian: 'marian.enabled',
    pdfmathtranslate: 'pdfMathTranslate.enabled',
    eval: 'eval.enabled',
    combine: 'combine.enabled',
  }
  return {
    selectedPath: selectedPathByEngine[engine],
    enabledPath: enabledPathByEngine[engine],
  }
}


export function AdvancedWebsiteToolBridge({
  enabled,
  getPageContext,
}: {
  enabled: boolean
  getPageContext: () => PageContext
}) {
  useEffect(() => {
    if (!enabled) {
      delete window.acm2AdvancedWebsiteTools
      return
    }

    const sharedUserActions = createSharedUserActionInvoker({ trustedConfirmation: true })
    const invoke = async (name: string, _args: Record<string, unknown> = {}) => {
      if (ALLIE_OWL_SHARED_ACTION_NAMES.includes(name as typeof ALLIE_OWL_SHARED_ACTION_NAMES[number])) {
        return sharedUserActions.invoke(name, _args)
      }
      const pageContext = sanitizePageContext(getPageContext())
      if (name === 'get_current_route_context') {
        return pageContext
      }
      if (name === 'get_available_assistant_actions') {
        return buildAvailableAssistantActions(pageContext)
      }
      if (name === 'get_visible_page_state') {
        return {
          page_context: pageContext,
          preset_draft_available: Boolean(window.acm2AssistantPresetBridge),
	          advanced_tool_bridge: {
	            status: 'ready',
              read_only_tools: [...ADVANCED_READONLY_TOOLS, ...ADVANCED_SHARED_READONLY_TOOLS],
              yolo_write_tools: [...ADVANCED_CONFIRMATION_TOOLS, ...ADVANCED_SHARED_CONFIRMATION_TOOLS],
	            exposed_tools: [...ADVANCED_WEBSITE_TOOLS],
	            note: 'Website tool bridge. Auth and data access are owned by the logged-in website; advanced YOLO write tools run without confirmation cards.',
	          },
	        }
	      }
      if (name === 'get_loaded_preset_list') {
        return buildLoadedPresetList()
      }
      if (name === 'load_preset_for_assistant') {
        return loadPresetForAssistant(_args)
      }
      if (name === 'get_content_library_summary') {
        return buildContentLibrarySummary(_args)
      }
      if (name === 'search_content_library_for_assistant') {
        return searchContentLibraryForAssistant(_args)
      }
	      if (name === 'load_content_for_assistant') {
	        return loadContentForAssistant(_args)
	      }
	      if (name === 'create_content_for_assistant') {
	        return createContentForAssistant(_args)
	      }
	      if (name === 'update_content_for_assistant') {
	        return updateContentForAssistant(_args)
	      }
	      if (name === 'get_current_preset_content_assets') {
	        return buildCurrentPresetContentAssets(pageContext)
	      }
	      if (name === 'start_new_preset_draft') {
	        return startNewPresetDraft(pageContext)
	      }
	      if (name === 'configure_fpf_preset_draft') {
	        return configureFpfPresetDraft(pageContext, _args)
	      }
      if (name === 'get_current_preset_summary') {
        return buildCurrentPresetSummary(pageContext)
      }
      if (name === 'get_current_preset_runnability') {
        return buildCurrentPresetRunnability(pageContext)
      }
      if (name === 'get_current_preset_models') {
        return buildCurrentPresetModels(pageContext)
      }
      if (name === 'get_current_preset_documents') {
        return buildCurrentPresetDocuments(pageContext)
      }
      if (name === 'get_current_preset_instructions') {
        return buildCurrentPresetInstructions(pageContext)
      }
      if (name === 'get_recent_runs_for_assistant') {
        return buildRecentRunsForAssistant(_args)
      }
      if (name === 'get_latest_run_context') {
        return buildLatestRunContext(pageContext, _args)
      }
      if (name === 'load_run_for_assistant') {
        return loadRunForAssistant(pageContext, _args)
      }
      if (name === 'get_run_status_summary') {
        return buildRunStatusSummary(pageContext, _args)
      }
      if (name === 'get_run_failure_signals') {
        return buildRunFailureSignals(pageContext, _args)
      }
      if (name === 'get_run_output_summary') {
        return buildRunOutputSummary(pageContext, _args)
      }
      if (name === 'load_run_logs_for_assistant') {
        return loadRunLogsForAssistant(pageContext, _args)
      }
      if (name === 'save_current_preset_draft') {
        return saveCurrentPresetDraft(pageContext)
      }
      if (name === 'execute_current_preset') {
        return executeCurrentPreset(pageContext)
      }
      if (name === 'attach_generation_instructions_to_current_preset') {
        return attachGenerationInstructionsToCurrentPreset(pageContext, _args)
      }
      if (name === 'attach_input_document_to_current_preset') {
        return attachInputDocumentToCurrentPreset(pageContext, _args)
      }
      if (name === 'attach_eval_asset_to_current_preset') {
        return attachEvalAssetToCurrentPreset(pageContext, _args)
      }
      if (name === 'attach_combine_instructions_to_current_preset') {
        return attachCombineInstructionsToCurrentPreset(pageContext, _args)
      }
      if (name === 'set_current_preset_engine_models') {
        return setCurrentPresetEngineModels(pageContext, _args)
      }
      return {
        status: 'not_allowed',
        requested_tool: name,
        allowed_tools: [...ADVANCED_WEBSITE_TOOLS],
      }
    }

    window.acm2AdvancedWebsiteTools = {
      listTools: () => [...ADVANCED_WEBSITE_TOOLS],
      invoke,
    }

    return () => {
      if (window.acm2AdvancedWebsiteTools?.invoke === invoke) {
        delete window.acm2AdvancedWebsiteTools
      }
    }
  }, [enabled, getPageContext])

  return null
}

function normalizePageBridgeMutationResult(result: unknown, successStatus: 'saved' | 'started' | 'updated') {
  const record = asRecord(result)
  if (!record) return { status: successStatus, result }
  const status = stringOrNull(record.status) ?? successStatus
  return { status, ...record }
}
