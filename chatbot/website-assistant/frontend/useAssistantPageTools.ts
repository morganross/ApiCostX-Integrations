import { sharedActionParameters } from './sharedActionSchema'
import { createSharedUserActionInvoker } from './sharedUserActionInvoker'
import { resourceId } from '@/api/resourceId'
import { useEffect, useMemo, useRef } from 'react'
import { useFrontendTool } from '@copilotkit/react-core/v2/headless'
import { z } from 'zod'
import { apiClient } from '@/api/client'
import {
  createAssistantDevTraceId,
  logAssistantDevEvent,
  normalizeAssistantDevError,
  type AssistantDevTraceContext,
} from '@/api/assistantDevLogger'
import { contentsApi, type ContentDetail, type ContentSummary, type ContentType, type ContentUpdate } from '@/api/contents'
import { githubApi } from '@/api/github'
import { getPreset, listPresets, type PresetResponse, type PresetSummary } from '@/api/presets'
import { runsApi, type Run, type RunLiveSummary } from '@/api/runs'
import { getPromptSourceValidationMessage, type ConfigStore, type GitHubInputConfig } from '@/pages/presets/presetShellHelpers'
import {
  getAssistantKnowledgeManifest,
  getAssistantKnowledgeStatus,
  readAssistantKnowledgeTopic,
} from './assistantKnowledge'
import { ALLIE_OWL_SHARED_ACTION_NAMES, ALLIE_OWL_SHARED_ACTIONS } from './allieOwlActionContract'

type PageContext = {
  route: string
  page: string
  active_preset_id: string | null
  current_run_id: string | null
}

type AssistantCache = {
  presetList?: PresetSummary[]
  presetsById: Record<string, PresetResponse>
  runList?: Run[]
  runListLoadedLimit?: number
  latestRunId?: string
  appPreload?: {
    status: 'idle' | 'loading' | 'loaded' | 'error'
    startedAt?: string
    completedAt?: string
    error?: string
  }
  runsById: Record<string, Run>
  logsByRunId: Record<string, AssistantLogResponse>
  outputsByRunId: Record<string, AssistantOutputCacheEntry>
  contentSummariesById: Record<string, ContentSummary>
}

type AssistantOutputCacheEntry = {
  maxDocuments: number
  outputs: unknown[]
}

type AssistantLogEntry = {
  id?: number
  timestamp?: string
  classification?: string
  source?: string
  level?: string
  event_type?: string | null
  message?: string
  payload?: string | null
}

type AssistantLogResponse = {
  run_id?: string
  total?: number
  offset?: number
  limit?: number
  save_run_logs?: boolean
  entries: AssistantLogEntry[]
}

type AssistantFrontendToolMetadata = {
  name: string
  category: 'orientation' | 'knowledge_read' | 'navigation' | 'content_read' | 'content_mutation' | 'preset_read' | 'preset_mutation' | 'run_read' | 'model_read' | 'usage_read' | 'credits_read' | 'refresh'
  mutatesPage: boolean
}

const ASSISTANT_CONTENT_TYPES = [
  'generation_instructions',
  'input_document',
  'single_eval_instructions',
  'pairwise_eval_instructions',
  'eval_criteria',
  'combine_instructions',
  'template_fragment',
  'output_document',
  'logs',
] as const satisfies readonly ContentType[]

const ASSISTANT_CREATABLE_CONTENT_TYPES = [
  'generation_instructions',
  'input_document',
  'single_eval_instructions',
  'pairwise_eval_instructions',
  'eval_criteria',
  'combine_instructions',
  'template_fragment',
] as const satisfies readonly ContentType[]

const assistantContentTypeSchema = z.enum(ASSISTANT_CONTENT_TYPES)
const assistantCreatableContentTypeSchema = z.enum(ASSISTANT_CREATABLE_CONTENT_TYPES)

type RunArtifactEvidence = {
  generated_save_event_count: number
  generated_file_save_message_count: number
  eval_save_event_count: number
  generated_artifacts: Array<{
    timestamp: string | null
    doc_id: string | null
    model: string | null
    source: 'log_event'
    message: string
  }>
  notes: string[]
}

const ASSISTANT_FRONTEND_TOOLS: AssistantFrontendToolMetadata[] = [
  { name: 'get_assistant_knowledge_manifest', category: 'orientation', mutatesPage: false },
  { name: 'read_knowledge_topic', category: 'knowledge_read', mutatesPage: false },
  { name: 'get_available_assistant_actions', category: 'orientation', mutatesPage: false },
  { name: 'get_visible_page_state', category: 'orientation', mutatesPage: false },
  { name: 'get_current_route_context', category: 'orientation', mutatesPage: false },
  { name: 'navigate_to_app_route', category: 'navigation', mutatesPage: true },
  { name: 'get_content_library_summary', category: 'content_read', mutatesPage: false },
  { name: 'search_content_library_for_assistant', category: 'content_read', mutatesPage: false },
  { name: 'load_content_for_assistant', category: 'content_read', mutatesPage: false },
  { name: 'create_content_for_assistant', category: 'content_mutation', mutatesPage: true },
  { name: 'update_content_for_assistant', category: 'content_mutation', mutatesPage: true },
  { name: 'duplicate_content_for_assistant', category: 'content_mutation', mutatesPage: true },
  { name: 'delete_content_for_assistant', category: 'content_mutation', mutatesPage: true },
  { name: 'list_github_connections_for_assistant', category: 'content_read', mutatesPage: false },
  { name: 'browse_github_connection_for_assistant', category: 'content_read', mutatesPage: false },
  { name: 'import_github_file_to_content_library', category: 'content_mutation', mutatesPage: true },
  { name: 'get_loaded_preset_list', category: 'preset_read', mutatesPage: false },
  { name: 'load_preset_for_assistant', category: 'preset_read', mutatesPage: false },
  { name: 'select_preset_and_wait_until_hydrated', category: 'navigation', mutatesPage: true },
  { name: 'get_current_preset_summary', category: 'preset_read', mutatesPage: false },
  { name: 'get_current_preset_runnability', category: 'preset_read', mutatesPage: false },
  { name: 'get_current_preset_requirements', category: 'preset_read', mutatesPage: false },
  { name: 'get_current_preset_models', category: 'preset_read', mutatesPage: false },
  { name: 'get_current_preset_documents', category: 'preset_read', mutatesPage: false },
  { name: 'get_current_preset_instructions', category: 'preset_read', mutatesPage: false },
  { name: 'attach_generation_instructions_to_current_preset', category: 'preset_mutation', mutatesPage: true },
  { name: 'attach_eval_instructions_to_current_preset', category: 'preset_mutation', mutatesPage: true },
  { name: 'attach_combine_instructions_to_current_preset', category: 'preset_mutation', mutatesPage: true },
  { name: 'set_current_preset_engine', category: 'preset_mutation', mutatesPage: true },
  { name: 'set_current_preset_iterations', category: 'preset_mutation', mutatesPage: true },
  { name: 'set_current_preset_search_provider', category: 'preset_mutation', mutatesPage: true },
  { name: 'set_current_preset_engine_models', category: 'preset_mutation', mutatesPage: true },
  { name: 'get_current_preset_draft', category: 'preset_read', mutatesPage: false },
  { name: 'create_new_preset', category: 'preset_mutation', mutatesPage: true },
  { name: 'set_current_preset_name', category: 'preset_mutation', mutatesPage: true },
  { name: 'list_available_generation_models', category: 'preset_read', mutatesPage: false },
  { name: 'select_current_preset_input_documents', category: 'preset_mutation', mutatesPage: true },
  { name: 'save_current_preset', category: 'preset_mutation', mutatesPage: true },
  { name: 'execute_current_preset', category: 'preset_mutation', mutatesPage: true },
  { name: 'get_loaded_history_rows', category: 'run_read', mutatesPage: false },
  { name: 'get_recent_runs_for_assistant', category: 'run_read', mutatesPage: false },
  { name: 'get_latest_run_context', category: 'run_read', mutatesPage: false },
  { name: 'load_run_for_assistant', category: 'run_read', mutatesPage: false },
  { name: 'get_run_status_summary', category: 'run_read', mutatesPage: false },
  { name: 'get_run_cost_summary', category: 'run_read', mutatesPage: false },
  { name: 'get_run_failure_signals', category: 'run_read', mutatesPage: false },
  { name: 'get_run_output_summary', category: 'run_read', mutatesPage: false },
  { name: 'load_run_logs_for_assistant', category: 'run_read', mutatesPage: false },
  { name: 'watch_run_logs_for_assistant', category: 'run_read', mutatesPage: false },
  { name: 'load_run_outputs_for_assistant', category: 'run_read', mutatesPage: false },
    { name: 'refresh_current_page_data', category: 'refresh', mutatesPage: false },
    ...ALLIE_OWL_SHARED_ACTIONS.map((action) => ({
      name: action.name,
      category: `${action.category}_${action.mutatesPage ? 'mutation' : 'read'}` as AssistantFrontendToolMetadata['category'],
      mutatesPage: action.mutatesPage,
    })),
  ]

const ASSISTANT_FRONTEND_TOOL_NAMES = ASSISTANT_FRONTEND_TOOLS.map((tool) => tool.name)
const ASSISTANT_RECENT_RUN_PRELOAD_LIMIT = 20
const ASSISTANT_PRELOAD_OUTPUT_DOCUMENT_LIMIT = 5
const ASSISTANT_NAVIGABLE_ROUTES = [
  '/presets',
  '/content',
  '/execute',
  '/history',
  '/flow-lab',
  '/quality',
  '/automations',
  '/settings',
  '/colors',
  '/simple',
] as const

export function useAssistantPageTools({ getPageContext, enabled = true }: { getPageContext: () => PageContext; enabled?: boolean }) {
  const cacheRef = useRef<AssistantCache>({
    appPreload: { status: 'idle' },
    presetsById: {},
    runsById: {},
    logsByRunId: {},
    outputsByRunId: {},
    contentSummariesById: {},
  })
  const appPreloadPromiseRef = useRef<Promise<void> | null>(null)

  const getCacheSummary = () => ({
    app_preload_status: cacheRef.current.appPreload?.status ?? 'idle',
    app_preload_error: cacheRef.current.appPreload?.error ?? null,
    loaded_presets: cacheRef.current.presetList?.length ?? 0,
    cached_preset_ids: Object.keys(cacheRef.current.presetsById),
    loaded_history_rows: cacheRef.current.runList?.length ?? 0,
    run_list_loaded_limit: cacheRef.current.runListLoadedLimit ?? 0,
    latest_run_id: cacheRef.current.latestRunId ?? null,
    cached_run_ids: Object.keys(cacheRef.current.runsById),
    cached_log_run_ids: Object.keys(cacheRef.current.logsByRunId),
    cached_output_run_ids: Object.keys(cacheRef.current.outputsByRunId),
  })

  const buildToolTraceContext = (assistantTraceId: string, args?: unknown): AssistantDevTraceContext => {
    const pageContext = sanitizePageContext(getPageContext())
    return {
      assistant_trace_id: assistantTraceId,
      acm_run_id: getRunIdFromToolArgs(args) ?? pageContext.current_run_id ?? cacheRef.current.latestRunId ?? null,
      route: pageContext.route,
      page: pageContext.page,
    }
  }

  const traceToolHandler = (name: string, handler: (args?: any) => Promise<any>) => async (args?: any) => {
    const invocationId = createAssistantDevTraceId(`tool-${name}`)
    const traceContext = buildToolTraceContext(invocationId, args)
    logAssistantDevEvent({
      event: 'assistant_frontend_tool',
      phase: 'start',
      trace_context: traceContext,
      payload: {
        tool_name: name,
        invocation_id: invocationId,
        args: args ?? {},
        page_context: sanitizePageContext(getPageContext()),
        cache: getCacheSummary(),
      },
    })

    try {
      const result = await handler(args)
      logAssistantDevEvent({
        event: 'assistant_frontend_tool',
        phase: 'success',
        trace_context: traceContext,
        payload: {
          tool_name: name,
          invocation_id: invocationId,
          args: args ?? {},
          result,
          page_context: sanitizePageContext(getPageContext()),
          cache: getCacheSummary(),
        },
      })
      return result
    } catch (error) {
      logAssistantDevEvent({
        event: 'assistant_frontend_tool',
        phase: 'error',
        trace_context: traceContext,
        payload: {
          tool_name: name,
          invocation_id: invocationId,
          args: args ?? {},
          page_context: sanitizePageContext(getPageContext()),
          cache: getCacheSummary(),
        },
        error: normalizeAssistantDevError(error),
      })
      throw error
    }
  }

  const ensureRecentRuns = async (limit = ASSISTANT_RECENT_RUN_PRELOAD_LIMIT) => {
    const traceId = createAssistantDevTraceId('assistant-ensure-recent-runs')
    const traceContext = buildToolTraceContext(traceId)
    if (cacheRef.current.runList && (cacheRef.current.runListLoadedLimit ?? 0) >= limit) {
      cacheRef.current.latestRunId = cacheRef.current.latestRunId ?? cacheRef.current.runList[0]?.id
      logAssistantDevEvent({
        event: 'assistant_recent_runs_load',
        phase: 'cache_hit',
        trace_context: traceContext,
        payload: { limit, runs: cacheRef.current.runList, cache: getCacheSummary() },
      })
      return cacheRef.current.runList
    }

    logAssistantDevEvent({
      event: 'assistant_recent_runs_load',
      phase: 'request',
      trace_context: traceContext,
      payload: { limit, cache: getCacheSummary() },
    })
    try {
      const runs = await runsApi.list({ limit })
      cacheRef.current.runList = runs
      cacheRef.current.runListLoadedLimit = limit
      cacheRef.current.latestRunId = runs[0]?.id ?? cacheRef.current.latestRunId
      for (const run of runs) {
        cacheRef.current.runsById[run.id] = cacheRef.current.runsById[run.id] ?? run
      }
      logAssistantDevEvent({
        event: 'assistant_recent_runs_load',
        phase: 'success',
        trace_context: { ...traceContext, acm_run_id: cacheRef.current.latestRunId ?? traceContext.acm_run_id ?? null },
        payload: { limit, runs, cache: getCacheSummary() },
      })
      return runs
    } catch (error) {
      logAssistantDevEvent({
        event: 'assistant_recent_runs_load',
        phase: 'error',
        trace_context: traceContext,
        payload: { limit, cache: getCacheSummary() },
        error: normalizeAssistantDevError(error),
      })
      throw error
    }
  }

  const resolveRunIdForAssistant = async (requestedRunId?: string | null) => {
    if (requestedRunId?.trim()) return { runId: requestedRunId.trim(), source: 'explicit_run_id' as const }

    const context = getPageContext()
    if (context.current_run_id) return { runId: context.current_run_id, source: 'visible_route' as const }

    const latestCachedRunId = cacheRef.current.latestRunId ?? cacheRef.current.runList?.[0]?.id ?? getNewestCachedRunId(cacheRef.current)
    if (latestCachedRunId) return { runId: latestCachedRunId, source: 'cached_latest_run' as const }

    const runs = await ensureRecentRuns(ASSISTANT_RECENT_RUN_PRELOAD_LIMIT)
    const latestRunId = runs[0]?.id
    if (latestRunId) return { runId: latestRunId, source: 'fetched_latest_run' as const }

    return { runId: null, source: 'none_available' as const }
  }

  const loadRunForAssistant = async (requestedRunId?: string | null) => {
    const traceId = createAssistantDevTraceId('assistant-load-run')
    const resolved = await resolveRunIdForAssistant(requestedRunId)
    const traceContext = buildToolTraceContext(traceId, { run_id: resolved.runId ?? requestedRunId })
    if (!resolved.runId) {
      logAssistantDevEvent({
        event: 'assistant_run_load',
        phase: 'unavailable',
        trace_context: traceContext,
        payload: { requested_run_id: requestedRunId ?? null, resolved, cache: getCacheSummary() },
      })
      return { run: null, resolved }
    }

    const existingRun = cacheRef.current.runsById[resolved.runId]
    logAssistantDevEvent({
      event: 'assistant_run_load',
      phase: existingRun ? 'request_refresh' : 'request',
      trace_context: traceContext,
      payload: { requested_run_id: requestedRunId ?? null, resolved, cached_run: existingRun ?? null, cache: getCacheSummary() },
    })
    try {
      const liveSummary = await runsApi.getLiveSummary(resolved.runId)
      const detail = isTerminalRunStatus(liveSummary.status)
        ? await runsApi.getSnapshot(resolved.runId)
        : await runsApi.getExecutionView(resolved.runId)
      const run = mergeAssistantRunLiveSummary(detail, liveSummary)
      cacheRef.current.runsById[run.id] = run
      if (!cacheRef.current.latestRunId && resolved.source !== 'explicit_run_id') {
        cacheRef.current.latestRunId = run.id
      }
      logAssistantDevEvent({
        event: 'assistant_run_load',
        phase: 'success',
        trace_context: { ...traceContext, acm_run_id: run.id },
        payload: { requested_run_id: requestedRunId ?? null, resolved: { ...resolved, runId: run.id }, run, cache: getCacheSummary() },
      })
      return { run, resolved: { ...resolved, runId: run.id } }
    } catch (error) {
      logAssistantDevEvent({
        event: 'assistant_run_load',
        phase: 'error',
        trace_context: traceContext,
        payload: { requested_run_id: requestedRunId ?? null, resolved, cache: getCacheSummary() },
        error: normalizeAssistantDevError(error),
      })
      throw error
    }
  }

  const ensurePresetList = async ({ force = false }: { force?: boolean } = {}) => {
    const visiblePresetOptions = window.acm2AssistantPresetBridge?.getPresetOptions?.()
    if (Array.isArray(visiblePresetOptions) && visiblePresetOptions.length > 0) {
      cacheRef.current.presetList = visiblePresetOptions
      return {
        loaded: true,
        source: 'visible_preset_page' as const,
        items: visiblePresetOptions,
        total: visiblePresetOptions.length,
      }
    }

    if (!force && cacheRef.current.presetList) {
      return {
        loaded: true,
        source: 'assistant_cache' as const,
        items: cacheRef.current.presetList,
        total: cacheRef.current.presetList.length,
      }
    }

    const list = await listPresets(1, 100)
    cacheRef.current.presetList = list.items
    return {
      loaded: true,
      source: 'frontend_api' as const,
      items: list.items,
      total: list.total,
      page: list.page,
      page_size: list.page_size,
      pages: list.pages,
    }
  }

  const preloadAppWideAssistantContext = async () => {
    if (appPreloadPromiseRef.current) return appPreloadPromiseRef.current

    appPreloadPromiseRef.current = (async () => {
      cacheRef.current.appPreload = { status: 'loading', startedAt: new Date().toISOString() }
      const traceId = createAssistantDevTraceId('assistant-app-preload')
      logAssistantDevEvent({
        event: 'assistant_app_preload',
        phase: 'start',
        trace_context: buildToolTraceContext(traceId),
        payload: { page_context: sanitizePageContext(getPageContext()), cache: getCacheSummary() },
      })
      try {
        await ensurePresetList().catch(() => null)
        await ensureRecentRuns(ASSISTANT_RECENT_RUN_PRELOAD_LIMIT)
        const { run } = await loadRunForAssistant()
        if (run) {
          try {
            const logs = await loadAssistantRunLogs(run.id, 'event')
            cacheRef.current.logsByRunId[`${run.id}:event`] = logs
            logAssistantDevEvent({
              event: 'assistant_app_preload_run_logs',
              phase: 'success',
              trace_context: { ...buildToolTraceContext(traceId), acm_run_id: run.id },
              payload: { run, logs, cache: getCacheSummary() },
            })
          } catch (error) {
            cacheRef.current.logsByRunId[`${run.id}:event`] = { run_id: run.id, entries: [] }
            logAssistantDevEvent({
              event: 'assistant_app_preload_run_logs',
              phase: 'error',
              trace_context: { ...buildToolTraceContext(traceId), acm_run_id: run.id },
              payload: { run, cache: getCacheSummary() },
              error: normalizeAssistantDevError(error),
            })
          }
          const outputs = await preloadRunOutputs(cacheRef.current, run, ASSISTANT_PRELOAD_OUTPUT_DOCUMENT_LIMIT)
          logAssistantDevEvent({
            event: 'assistant_app_preload_run_outputs',
            phase: 'success',
            trace_context: { ...buildToolTraceContext(traceId), acm_run_id: run.id },
            payload: { run, outputs, cache: getCacheSummary() },
          })
        }
        cacheRef.current.appPreload = { status: 'loaded', completedAt: new Date().toISOString() }
        logAssistantDevEvent({
          event: 'assistant_app_preload',
          phase: 'success',
          trace_context: buildToolTraceContext(traceId),
          payload: { cache: cacheRef.current },
        })
      } catch (error) {
        cacheRef.current.appPreload = {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Assistant app-wide preload failed.',
        }
        logAssistantDevEvent({
          event: 'assistant_app_preload',
          phase: 'error',
          trace_context: buildToolTraceContext(traceId),
          payload: { cache: cacheRef.current },
          error: normalizeAssistantDevError(error),
        })
      } finally {
        appPreloadPromiseRef.current = null
      }
    })()

    return appPreloadPromiseRef.current
  }

  useEffect(() => {
    if (!enabled) return
    void preloadAppWideAssistantContext()
  }, [enabled])

  const debugToolHandlersRef = useRef<Record<string, (args?: Record<string, unknown>) => Promise<unknown>>>({})

  const registerDebugTool = (
    name: string,
    handler: (args?: Record<string, unknown>) => Promise<unknown>,
  ) => {
    debugToolHandlersRef.current[name] = handler
  }

  useEffect(() => {
    const debugEnabled = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
    if (!debugEnabled) return

    ;(window as typeof window & {
      __acm2AssistantToolTestApi?: {
        listTools: () => string[]
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>
      }
    }).__acm2AssistantToolTestApi = {
      listTools: () => Object.keys(debugToolHandlersRef.current).sort(),
      invoke: async (name, args = {}) => {
        const handler = debugToolHandlersRef.current[name]
        if (!handler) {
          throw new Error(`Unknown assistant tool: ${name}`)
        }
        return handler(args)
      },
    }

    return () => {
      delete (window as typeof window & { __acm2AssistantToolTestApi?: unknown }).__acm2AssistantToolTestApi
    }
  }, [])

  const getAssistantKnowledgeManifestHandler = async () => ({
    ...getAssistantKnowledgeManifest({ declaredFrontendTools: ASSISTANT_FRONTEND_TOOL_NAMES }),
    declared_frontend_tool_metadata: ASSISTANT_FRONTEND_TOOLS,
    tool_manifest_note: 'This is frontend-declared tool metadata. The CopilotKit runtime owns the final per-run tool registry.',
  })
  registerDebugTool('get_assistant_knowledge_manifest', getAssistantKnowledgeManifestHandler)
  useFrontendTool({
    name: 'get_assistant_knowledge_manifest',
    description: 'Return the ACM assistant knowledge-pack manifest, source document list, injection channels, and declared frontend tool metadata.',
    parameters: z.object({}),
    handler: traceToolHandler('get_assistant_knowledge_manifest', getAssistantKnowledgeManifestHandler),
  }, [])

  const readKnowledgeTopicHandler = async (args?: Record<string, unknown>) => {
    const topic = typeof args?.topic === 'string' ? args.topic : ''
    const maxChars = typeof args?.max_chars === 'number' ? args.max_chars : undefined
    return readAssistantKnowledgeTopic(topic, maxChars)
  }
  registerDebugTool('read_knowledge_topic', readKnowledgeTopicHandler)
  useFrontendTool({
    name: 'read_knowledge_topic',
    description: 'Read one allowlisted detailed APICostX knowledge topic when the user asks for feature-specific guidance. The topic is bounded and does not read arbitrary paths or URLs.',
    parameters: z.object({
      topic: z.string().min(1).max(64).describe('Allowlisted topic id from the ACM knowledge manifest.'),
      max_chars: z.number().int().min(1000).max(24000).optional().describe('Optional maximum characters for this topic read.'),
    }),
    handler: traceToolHandler('read_knowledge_topic', readKnowledgeTopicHandler),
  }, [])

  const searchContentLibraryHandler = async ({
    content_type,
    search,
    tag,
    folder_path,
    limit = 20,
  }: {
    content_type?: ContentType
    search?: string
    tag?: string
    folder_path?: string
    limit?: number
  }) => {
    const [list, counts, folders] = await Promise.all([
      contentsApi.list({
        content_type,
        search: search?.trim() || undefined,
        tag: tag?.trim() || undefined,
        folder_path: folder_path?.trim() || undefined,
        page: 1,
        page_size: limit,
      }),
      contentsApi.counts({ folder_path: folder_path?.trim() || undefined }).catch(() => null),
      contentsApi.folders({ content_type }).catch(() => null),
    ])
    for (const item of list.items) cacheRef.current.contentSummariesById[item.id] = item
    return {
      status: 'loaded',
      source: 'frontend_content_api',
      filter: {
        content_type: content_type ?? null,
        search: search?.trim() || null,
        tag: tag?.trim() || null,
        folder_path: folder_path?.trim() || null,
        limit,
      },
      total: list.total,
      page: list.page,
      pages: list.pages,
      counts,
      folders: folders?.items.slice(0, 50) ?? [],
      items: list.items.slice(0, limit).map(buildAssistantContentSummary),
      notes: [
        'This is bounded user-scoped Content Library data loaded by the logged-in website frontend.',
        'Body previews are not full content; use load_content_for_assistant for a bounded body excerpt.',
      ],
    }
  }
  registerDebugTool('search_content_library_for_assistant', searchContentLibraryHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'search_content_library_for_assistant',
    description: 'Search the logged-in user Content Library by type, text, tag, or folder and return bounded metadata previews.',
    parameters: z.object({
      content_type: assistantContentTypeSchema.optional(),
      search: z.string().trim().max(500).optional(),
      tag: z.string().trim().max(100).optional(),
      folder_path: z.string().trim().max(500).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    handler: traceToolHandler('search_content_library_for_assistant', searchContentLibraryHandler),
  }, [])

  const getContentLibrarySummaryHandler = async ({ content_type, search, limit = 20 }: { content_type?: ContentType; search?: string; limit?: number }) => (
    searchContentLibraryHandler({ content_type, search, limit })
  )
  registerDebugTool('get_content_library_summary', getContentLibrarySummaryHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_content_library_summary',
    description: 'List bounded Content Library metadata and previews through the logged-in website frontend.',
    parameters: z.object({
      content_type: assistantContentTypeSchema.optional(),
      search: z.string().trim().max(500).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    handler: traceToolHandler('get_content_library_summary', getContentLibrarySummaryHandler),
  }, [])

  const loadContentHandler = async ({
    content_id,
    name_query,
    content_type,
    max_chars = 4000,
  }: {
    content_id?: string
    name_query?: string
    content_type?: ContentType
    max_chars?: number
  }) => {
    let resolvedId = content_id?.trim() || null
    if (!resolvedId && name_query?.trim()) {
      const matches = await contentsApi.list({
        content_type,
        search: name_query.trim(),
        page: 1,
        page_size: 20,
      })
      const query = name_query.trim().toLowerCase()
      resolvedId = matches.items.find((item) => item.name.toLowerCase() === query)?.id
        ?? matches.items.find((item) => item.name.toLowerCase().includes(query))?.id
        ?? matches.items[0]?.id
        ?? null
    }
    if (!resolvedId) {
      return { status: 'not_found', message: 'No matching Content Library record was found.' }
    }
    const detail = await contentsApi.get(resolvedId)
    cacheRef.current.contentSummariesById[detail.id] = contentDetailToSummary(detail)
    return {
      status: 'loaded',
      source: 'frontend_content_api',
      content: buildAssistantContentDetail(detail, max_chars),
    }
  }
  registerDebugTool('load_content_for_assistant', loadContentHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'load_content_for_assistant',
    description: 'Load one user-scoped Content Library record by id or name with a bounded body excerpt.',
    parameters: z.object({
      content_id: z.string().trim().min(1).optional(),
      name_query: z.string().trim().min(1).max(500).optional(),
      content_type: assistantContentTypeSchema.optional(),
      max_chars: z.number().int().min(200).max(12000).default(4000),
    }),
    handler: traceToolHandler('load_content_for_assistant', loadContentHandler),
  }, [])

  const createContentHandler = async ({
    name,
    content_type,
    body,
    description,
    folder_path,
    tags = [],
    variables,
  }: {
    name: string
    content_type: typeof ASSISTANT_CREATABLE_CONTENT_TYPES[number]
    body: string
    description?: string
    folder_path?: string
    tags?: string[]
    variables?: Record<string, string | null>
  }) => {
    const created = await contentsApi.create({
      name: name.trim(),
      content_type,
      body,
      variables,
      description: description?.trim() || undefined,
      folder_path: folder_path?.trim() || undefined,
      tags: uniqueStrings(tags).slice(0, 24),
    })
    const verified = await contentsApi.get(created.id)
    cacheRef.current.contentSummariesById[verified.id] = contentDetailToSummary(verified)
    return {
      status: 'created',
      source: 'frontend_content_api',
      content: buildAssistantContentDetail(verified, 1200),
      verification: { reloaded_by_id: true },
    }
  }
  registerDebugTool('create_content_for_assistant', createContentHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'create_content_for_assistant',
    description: 'Create a Content Library record with the logged-in user authority through the normal website frontend API, then reload it for verification. For eval_criteria, body must be YAML with a top-level criteria list; every item must contain a non-empty name and description (for example: criteria:\n  - name: factuality\n    description: Checks factual accuracy).',
    parameters: z.object({
      name: z.string().trim().min(1).max(200),
      content_type: assistantCreatableContentTypeSchema,
      body: z.string().min(1).max(200000),
      description: z.string().trim().max(2000).optional(),
      folder_path: z.string().trim().max(500).optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(24).default([]),
    }),
    handler: traceToolHandler('create_content_for_assistant', createContentHandler),
  }, [])

  const updateContentHandler = async ({
    content_id,
    name,
    body,
    variables,
    description,
    folder_path,
    tags,
  }: {
    content_id: string
    name?: string
    body?: string
    variables?: Record<string, string | null>
    description?: string
    folder_path?: string
    tags?: string[]
  }) => {
    const existing = await contentsApi.get(content_id)
    if (existing.content_type === 'logs') {
      return { status: 'rejected', message: 'Run logs are read-only Content Library records.' }
    }
    const update: ContentUpdate = {}
    if (name !== undefined) update.name = name.trim()
    if (body !== undefined) update.body = body
    if (variables !== undefined) update.variables = variables
    if (description !== undefined) update.description = description
    if (folder_path !== undefined) update.folder_path = folder_path
    if (tags !== undefined) update.tags = uniqueStrings(tags).slice(0, 24)
    if (Object.keys(update).length === 0) {
      return { status: 'rejected', message: 'No Content Library fields were provided to update.' }
    }
    await contentsApi.update(content_id, update)
    const verified = await contentsApi.get(content_id)
    cacheRef.current.contentSummariesById[verified.id] = contentDetailToSummary(verified)
    return {
      status: 'updated',
      source: 'frontend_content_api',
      content: buildAssistantContentDetail(verified, 1200),
      verification: { reloaded_by_id: true },
    }
  }
  registerDebugTool('update_content_for_assistant', updateContentHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'update_content_for_assistant',
    description: 'Update an existing non-log Content Library record through the logged-in website frontend and reload it for verification. When updating an eval_criteria body, preserve the required YAML contract: a top-level criteria list whose items each contain a non-empty name and description.',
    parameters: z.object({
      content_id: z.string().trim().min(1),
      name: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(200000).optional(),
      description: z.string().max(2000).optional(),
      folder_path: z.string().max(500).optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(24).optional(),
    }),
    handler: traceToolHandler('update_content_for_assistant', updateContentHandler),
  }, [])

  const duplicateContentHandler = async ({ content_id, name }: { content_id: string; name?: string }) => {
    const existing = await contentsApi.get(content_id)
    if (existing.content_type === 'logs') {
      return { status: 'rejected', message: 'Run logs cannot be duplicated.' }
    }
    const duplicated = await contentsApi.duplicate(content_id, name?.trim() || undefined)
    const verified = await contentsApi.get(duplicated.id)
    cacheRef.current.contentSummariesById[verified.id] = contentDetailToSummary(verified)
    return {
      status: 'duplicated',
      source: 'frontend_content_api',
      source_content_id: content_id,
      content: buildAssistantContentDetail(verified, 1200),
      verification: { reloaded_by_id: true },
    }
  }
  registerDebugTool('duplicate_content_for_assistant', duplicateContentHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'duplicate_content_for_assistant',
    description: 'Duplicate an existing non-log Content Library record through the logged-in website frontend.',
    parameters: z.object({
      content_id: z.string().trim().min(1),
      name: z.string().trim().min(1).max(200).optional(),
    }),
    handler: traceToolHandler('duplicate_content_for_assistant', duplicateContentHandler),
  }, [])

  const deleteContentHandler = async ({ content_id, confirm_name }: { content_id: string; confirm_name: string }) => {
    const existing = await contentsApi.get(content_id)
    if (existing.content_type === 'logs') {
      return { status: 'rejected', message: 'Run logs cannot be deleted through the Content Library tool.' }
    }
    if (existing.name !== confirm_name) {
      return {
        status: 'rejected',
        message: 'Deletion requires confirm_name to exactly match the current Content Library record name.',
        current_name: existing.name,
      }
    }
    await contentsApi.delete(content_id)
    delete cacheRef.current.contentSummariesById[content_id]
    return {
      status: 'deleted',
      source: 'frontend_content_api',
      content_id,
      name: existing.name,
      note: 'The normal website Content Library delete operation completed.',
    }
  }
  registerDebugTool('delete_content_for_assistant', deleteContentHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'delete_content_for_assistant',
    description: 'Delete a non-log Content Library record only after the user explicitly requested deletion; confirm_name must exactly match the current record name.',
    parameters: z.object({
      content_id: z.string().trim().min(1),
      confirm_name: z.string().min(1).max(200),
    }),
    handler: traceToolHandler('delete_content_for_assistant', deleteContentHandler),
  }, [])

  const listGitHubConnectionsHandler = async () => {
    const connections = await githubApi.list()
    return {
      status: 'loaded',
      source: 'frontend_github_api',
      total: connections.total,
      connections: connections.items.slice(0, 100).map((connection) => ({
        id: connection.id,
        name: connection.name,
        repo: connection.repo,
        branch: connection.branch,
        is_valid: connection.is_valid,
        last_tested_at: connection.last_tested_at,
      })),
      sensitive_credentials_included: false,
    }
  }
  registerDebugTool('list_github_connections_for_assistant', listGitHubConnectionsHandler)
  useFrontendTool({
    name: 'list_github_connections_for_assistant',
    description: 'List the logged-in user\'s saved GitHub connections through the normal website frontend without returning access tokens.',
    parameters: z.object({}),
    handler: traceToolHandler('list_github_connections_for_assistant', listGitHubConnectionsHandler),
  }, [])

  const browseGitHubConnectionHandler = async ({
    connection_id,
    path = '/',
    max_items = 100,
  }: {
    connection_id: string
    path?: string
    max_items?: number
  }) => {
    const result = await githubApi.browse(connection_id, path.trim() || '/')
    return {
      status: 'loaded',
      source: 'frontend_github_api',
      connection_id: result.connection_id,
      repo: result.repo,
      branch: result.branch,
      path: result.path,
      total_returned: Math.min(result.contents.length, max_items),
      truncated: result.contents.length > max_items,
      contents: result.contents.slice(0, max_items).map((item) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
      })),
    }
  }
  registerDebugTool('browse_github_connection_for_assistant', browseGitHubConnectionHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'browse_github_connection_for_assistant',
    description: 'Browse files and directories in one saved GitHub connection through the logged-in website frontend. Use a returned file path with import_github_file_to_content_library.',
    parameters: z.object({
      connection_id: z.string().trim().min(1),
      path: z.string().trim().max(1000).default('/'),
      max_items: z.number().int().min(1).max(200).default(100),
    }),
    handler: traceToolHandler('browse_github_connection_for_assistant', browseGitHubConnectionHandler),
  }, [])

  const importGitHubFileHandler = async ({
    connection_id,
    path,
    content_type,
    name,
    description,
    folder_path,
    tags = [],
  }: {
    connection_id: string
    path: string
    content_type: typeof ASSISTANT_CREATABLE_CONTENT_TYPES[number]
    name?: string
    description?: string
    folder_path?: string
    tags?: string[]
  }) => {
    const imported = await githubApi.importFile(connection_id, {
      path: path.trim(),
      content_type,
      name: name?.trim() || undefined,
      description: description?.trim() || undefined,
      folder_path: folder_path?.trim() || undefined,
      tags: uniqueStrings(tags).slice(0, 24),
    })
    const verified = await contentsApi.get(imported.id)
    cacheRef.current.contentSummariesById[verified.id] = contentDetailToSummary(verified)
    return {
      status: 'imported',
      source: 'frontend_github_api',
      connection_id,
      github_path: path.trim(),
      content: buildAssistantContentDetail(verified, 1200),
      verification: { reloaded_by_id: true },
    }
  }
  registerDebugTool('import_github_file_to_content_library', importGitHubFileHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'import_github_file_to_content_library',
    description: 'Import one verified file path from a saved GitHub connection into the logged-in user\'s Content Library through the same frontend API used by the website, then reload it by ID. For eval_criteria imports, the file must satisfy the strict criteria YAML contract.',
    parameters: z.object({
      connection_id: z.string().trim().min(1),
      path: z.string().trim().min(1).max(1000),
      content_type: assistantCreatableContentTypeSchema,
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(2000).optional(),
      folder_path: z.string().trim().max(500).optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(24).default([]),
    }),
    handler: traceToolHandler('import_github_file_to_content_library', importGitHubFileHandler),
  }, [])

  const getAvailableAssistantActionsHandler = async () => {
    await ensurePresetList().catch(() => null)
    await ensureRecentRuns(ASSISTANT_RECENT_RUN_PRELOAD_LIMIT).catch(() => [])
    const pageContext = sanitizePageContext(getPageContext())
    const cache = getCacheSummary()
    const presetDraftAvailable = Boolean(window.acm2AssistantPresetBridge)
    return {
      page_context: pageContext,
      preset_draft_available: presetDraftAvailable,
      knowledge_status: getAssistantKnowledgeStatus(),
      cache,
      actions: getAvailableAssistantActions({
        pageContext,
        cache,
        presetDraftAvailable,
      }),
      suggested_next_steps: getSuggestedNextSteps({
        pageContext,
        cache,
        presetDraftAvailable,
      }),
    }
  }
  registerDebugTool('get_available_assistant_actions', getAvailableAssistantActionsHandler)
  useFrontendTool({
    name: 'get_available_assistant_actions',
    description: 'Return a compact, deterministic summary of what the ACM assistant can do right now from current frontend/app state and why some actions are unavailable.',
    parameters: z.object({}),
    handler: traceToolHandler('get_available_assistant_actions', getAvailableAssistantActionsHandler),
  }, [])

  useFrontendTool({
    name: 'get_visible_page_state',
    description: 'Return only the ACM page state that is currently visible or already cached by browser assistant tools.',
    parameters: z.object({}),
    handler: traceToolHandler('get_visible_page_state', async () => ({
      page_context: sanitizePageContext(getPageContext()),
      cache: getCacheSummary(),
      preset_draft_available: Boolean(window.acm2AssistantPresetBridge),
    })),
  }, [])

  useFrontendTool({
    name: 'get_current_route_context',
    description: 'Return the current ACM route, page, selected preset id, and current run id from the browser.',
    parameters: z.object({}),
    handler: traceToolHandler('get_current_route_context', async () => sanitizePageContext(getPageContext())),
  }, [])

  useFrontendTool({
    name: 'navigate_to_app_route',
    description: 'Change the visible ACM React app route through the browser hash router. Use for route changes like opening flow-lab, execute, history, content, settings, or a specific preset/run route.',
    parameters: z.object({
      route: z.string().describe('Target app route, for example /flow-lab, flow-lab, /execute, /execute/{runId}, /presets, or /presets/{presetId}.'),
      replace: z.boolean().default(false).describe('Replace the current history entry instead of pushing a new browser history entry.'),
    }),
    handler: traceToolHandler('navigate_to_app_route', async ({ route, replace }) => {
      const targetRoute = normalizeAssistantNavigationRoute(route)
      if (!targetRoute) {
        return {
          status: 'not_allowed',
          requested_route: route,
          allowed_routes: ASSISTANT_NAVIGABLE_ROUTES,
          message: 'The requested route is not a known ACM app route exposed to the assistant.',
        }
      }

      const previous = sanitizePageContext(getPageContext())
      const previousHash = window.location.hash.replace(/^#/, '') || '/'
      if (previousHash === targetRoute) {
        return {
          status: 'already_there',
          route: targetRoute,
          previous_page_context: previous,
          page_context: sanitizePageContext(getPageContext()),
        }
      }

      if (replace) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${targetRoute}`)
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      } else {
        window.location.hash = targetRoute
      }

      await waitForAssistantRoute(targetRoute)
      return {
        status: 'navigated',
        route: targetRoute,
        previous_page_context: previous,
        page_context: sanitizePageContext(getPageContext()),
        notes: [
          'Navigation changes the visible React route only.',
          'App-wide read tools can still inspect runs and presets without changing routes.',
          'Unsaved visible draft state may be lost when leaving a route that owns page-local draft state.',
        ],
      }
    }),
  }, [])

  useFrontendTool({
    name: 'get_loaded_preset_list',
    description: 'Return the currently available preset list, using the visible preset page bridge when mounted and otherwise fetching through the browser frontend API client.',
    parameters: z.object({}),
    handler: traceToolHandler('get_loaded_preset_list', async () => ensurePresetList()),
  }, [])

  useFrontendTool({
    name: 'load_preset_for_assistant',
    description: 'Read and cache one requested canonical preset without navigating or selecting it in the visible page. Use select_preset_and_wait_until_hydrated when later tools need the visible draft.',
    parameters: z.object({
      preset_id: z.string().optional(),
      name_query: z.string().optional(),
    }),
    handler: traceToolHandler('load_preset_for_assistant', async ({ preset_id, name_query }) => {
      let presetId = preset_id
      if (name_query) {
        const list = await ensurePresetList()
        const query = name_query.toLowerCase()
        const match = list.items.find((preset) => preset.name.toLowerCase().includes(query))
        if (match) {
          presetId = match.id
        } else if (!presetId) {
          return {
            status: 'not_found',
            requested_preset_id: preset_id ?? null,
            name_query,
            message: 'No matching preset id or name was found.',
            next_steps: [
              'Call get_loaded_preset_list to list valid preset names and ids.',
              'Try a shorter name_query substring.',
              'Create or save a new preset if this should exist.',
            ],
          }
        }
      }
      if (!presetId) {
        return { status: 'not_found', message: 'No matching preset id or name was found.' }
      }
      try {
        const preset = await getPreset(presetId)
        cacheRef.current.presetsById[preset.id] = preset
        return { status: 'loaded', preset }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Preset could not be loaded.'
        if (message.toLowerCase().includes('not found')) {
          return {
            status: 'not_found',
            requested_preset_id: preset_id ?? presetId,
            name_query: name_query ?? null,
            message: 'The requested preset could not be found.',
            next_steps: [
              'Call get_loaded_preset_list to list valid preset names and ids.',
              'Try a shorter name_query substring.',
              'Create or save a new preset if this should exist.',
            ],
          }
        }
        return {
          status: 'error',
          requested_preset_id: preset_id ?? presetId,
          name_query: name_query ?? null,
          message: 'Preset could not be loaded.',
          error_message: message,
        }
      }
    }),
  }, [])

  useFrontendTool({
    name: 'select_preset_and_wait_until_hydrated',
    description: 'Select a saved preset in the visible preset page and return only after the page bridge reports the matching hydrated draft.',
    parameters: z.object({
      preset_id: z.string().trim().min(1),
    }),
    handler: traceToolHandler('select_preset_and_wait_until_hydrated', async ({ preset_id }) => {
      const list = await ensurePresetList()
      const match = list.items.find((preset) => preset.id === preset_id)
      if (!match) {
        return {
          status: 'not_found',
          preset_id,
          message: 'The requested preset is not present in the current user preset list.',
        }
      }

      const targetRoute = `/presets/${preset_id}`
      const previousRoute = window.location.hash.replace(/^#/, '') || '/'
      if (previousRoute !== targetRoute) {
        window.location.hash = targetRoute
      }
      await waitForAssistantRoute(targetRoute)
      const draft = await waitForAssistantPresetHydration(preset_id)
      if (!draft) {
        return {
          status: 'timeout',
          preset_id,
          route: window.location.hash.replace(/^#/, '') || '/',
          message: 'The route changed, but the visible preset draft did not finish hydrating in time.',
        }
      }

      return {
        status: 'selected',
        preset_id,
        preset_name: draft.presetName ?? match.name,
        route: targetRoute,
        hydration: {
          config_loaded: Boolean(draft.config),
          selected_document_count: draft.selectedInputDocIds?.length ?? 0,
          generation_instructions_attached: Boolean(draft.selectedInstructionId),
        },
      }
    }),
  }, [])

  const getCurrentPresetSummaryHandler = async ({ preset_id }: { preset_id?: string }) => {
    const context = getPageContext()
    const targetPresetId = preset_id ?? context.active_preset_id
    if (!targetPresetId) {
      return { status: 'unavailable', message: 'No active preset is selected on the current page, and no preset_id was provided.' }
    }

    try {
      const preset = cacheRef.current.presetsById[targetPresetId] ?? await getPreset(targetPresetId)
      cacheRef.current.presetsById[preset.id] = preset
      return buildPresetSummaryResult(preset)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preset summary could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested preset could not be found.' }
      }
      return { status: 'error', message: 'Preset summary could not be loaded.' }
    }
  }
  registerDebugTool('get_current_preset_summary', getCurrentPresetSummaryHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_current_preset_summary',
    description: 'Return a compact summary of the current or requested preset so the assistant can explain its major configuration at a glance.',
    parameters: z.object({
      preset_id: z.string().optional(),
    }),
    handler: traceToolHandler('get_current_preset_summary', getCurrentPresetSummaryHandler),
  }, [])

  const getCurrentPresetRunnabilityHandler = async ({ preset_id, use_visible_draft_if_available }: { preset_id?: string; use_visible_draft_if_available: boolean }) => {
    const context = getPageContext()
    const targetPresetId = preset_id ?? context.active_preset_id
    const visibleDraft = window.acm2AssistantPresetBridge?.getDraft()

    if (use_visible_draft_if_available && visibleDraft) {
      return evaluateVisiblePresetDraftRunnability(visibleDraft, targetPresetId)
    }

    if (!targetPresetId) {
      return { status: 'unavailable', message: 'No active preset is selected on the current page, and no preset_id was provided.' }
    }

    try {
      const preset = cacheRef.current.presetsById[targetPresetId] ?? await getPreset(targetPresetId)
      cacheRef.current.presetsById[preset.id] = preset
      return evaluateSavedPresetRunnability(preset)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preset runnability could not be evaluated.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested preset could not be found.' }
      }
      return { status: 'error', message: 'Preset runnability could not be evaluated.' }
    }
  }
  registerDebugTool('get_current_preset_runnability', getCurrentPresetRunnabilityHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_current_preset_runnability',
    description: 'Return a structured summary of whether the current or requested preset can be run right now and what is blocking it.',
    parameters: z.object({
      preset_id: z.string().optional(),
      use_visible_draft_if_available: z.boolean().default(true),
    }),
    handler: traceToolHandler('get_current_preset_runnability', getCurrentPresetRunnabilityHandler),
  }, [])

  const getCurrentPresetRequirementsHandler = async ({ preset_id, use_visible_draft_if_available }: { preset_id?: string; use_visible_draft_if_available: boolean }) => {
    const context = getPageContext()
    const targetPresetId = preset_id ?? context.active_preset_id
    const visibleDraft = window.acm2AssistantPresetBridge?.getDraft()

    if (use_visible_draft_if_available && visibleDraft) {
      return buildVisiblePresetRequirementsResult(visibleDraft, targetPresetId)
    }

    if (!targetPresetId) {
      return { status: 'unavailable', message: 'No active preset is selected on the current page, and no preset_id was provided.' }
    }

    try {
      const preset = cacheRef.current.presetsById[targetPresetId] ?? await getPreset(targetPresetId)
      cacheRef.current.presetsById[preset.id] = preset
      return buildSavedPresetRequirementsResult(preset)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preset requirements could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested preset could not be found.' }
      }
      return { status: 'error', message: 'Preset requirements could not be loaded.' }
    }
  }
  registerDebugTool('get_current_preset_requirements', getCurrentPresetRequirementsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_current_preset_requirements',
    description: 'Return the explicit requirement checklist for the current or requested preset so the assistant can explain what setup categories are present or missing.',
    parameters: z.object({
      preset_id: z.string().optional(),
      use_visible_draft_if_available: z.boolean().default(true),
    }),
    handler: traceToolHandler('get_current_preset_requirements', getCurrentPresetRequirementsHandler),
  }, [])

  const getCurrentPresetModelsHandler = async ({ preset_id, use_visible_draft_if_available }: { preset_id?: string; use_visible_draft_if_available: boolean }) => {
    const context = getPageContext()
    const targetPresetId = preset_id ?? context.active_preset_id
    const visibleDraft = window.acm2AssistantPresetBridge?.getDraft()

    if (use_visible_draft_if_available && visibleDraft) {
      return buildVisiblePresetModelsResult(visibleDraft, targetPresetId)
    }

    if (!targetPresetId) {
      return { status: 'unavailable', message: 'No active preset is selected on the current page, and no preset_id was provided.' }
    }

    try {
      const preset = cacheRef.current.presetsById[targetPresetId] ?? await getPreset(targetPresetId)
      cacheRef.current.presetsById[preset.id] = preset
      return buildSavedPresetModelsResult(preset)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preset model selections could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested preset could not be found.' }
      }
      return { status: 'error', message: 'Preset model selections could not be loaded.' }
    }
  }
  registerDebugTool('get_current_preset_models', getCurrentPresetModelsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_current_preset_models',
    description: 'Return the model selections attached to the current or requested preset, grouped by engine or evaluation section.',
    parameters: z.object({
      preset_id: z.string().optional(),
      use_visible_draft_if_available: z.boolean().default(true),
    }),
    handler: traceToolHandler('get_current_preset_models', getCurrentPresetModelsHandler),
  }, [])

  const getCurrentPresetDocumentsHandler = async ({ preset_id, use_visible_draft_if_available, include_document_names }: { preset_id?: string; use_visible_draft_if_available: boolean; include_document_names: boolean }) => {
    const context = getPageContext()
    const targetPresetId = preset_id ?? context.active_preset_id
    const visibleDraft = window.acm2AssistantPresetBridge?.getDraft()

    if (use_visible_draft_if_available && visibleDraft) {
      return buildVisiblePresetDocumentsResult(visibleDraft, targetPresetId, include_document_names)
    }

    if (!targetPresetId) {
      return { status: 'unavailable', message: 'No active preset is selected on the current page, and no preset_id was provided.' }
    }

    try {
      const preset = cacheRef.current.presetsById[targetPresetId] ?? await getPreset(targetPresetId)
      cacheRef.current.presetsById[preset.id] = preset
      const contentItems = include_document_names
        ? await loadContentSummariesByIds(cacheRef.current, preset.documents ?? [])
        : []
      return buildSavedPresetDocumentsResult(preset, contentItems, include_document_names)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preset document attachments could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested preset could not be found.' }
      }
      return { status: 'error', message: 'Preset document attachments could not be loaded.' }
    }
  }
  registerDebugTool('get_current_preset_documents', getCurrentPresetDocumentsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_current_preset_documents',
    description: 'Return a lightweight summary of the document attachments for the current or requested preset.',
    parameters: z.object({
      preset_id: z.string().optional(),
      use_visible_draft_if_available: z.boolean().default(true),
      include_document_names: z.boolean().default(true),
    }),
    handler: traceToolHandler('get_current_preset_documents', getCurrentPresetDocumentsHandler),
  }, [])

  const getCurrentPresetInstructionsHandler = async ({ preset_id, use_visible_draft_if_available, include_titles }: { preset_id?: string; use_visible_draft_if_available: boolean; include_titles: boolean }) => {
    const context = getPageContext()
    const targetPresetId = preset_id ?? context.active_preset_id
    const visibleDraft = window.acm2AssistantPresetBridge?.getDraft()

    if (use_visible_draft_if_available && visibleDraft) {
      const instructionIds = getVisibleDraftInstructionIds(visibleDraft)
      const contentItems = include_titles
        ? await loadContentSummariesByIds(cacheRef.current, Object.values(instructionIds).filter((value): value is string => Boolean(value)))
        : []
      return buildVisiblePresetInstructionsResult(visibleDraft, targetPresetId, contentItems, include_titles)
    }

    if (!targetPresetId) {
      return { status: 'unavailable', message: 'No active preset is selected on the current page, and no preset_id was provided.' }
    }

    try {
      const preset = cacheRef.current.presetsById[targetPresetId] ?? await getPreset(targetPresetId)
      cacheRef.current.presetsById[preset.id] = preset
      const instructionIds = getSavedPresetInstructionIds(preset)
      const contentItems = include_titles
        ? await loadContentSummariesByIds(cacheRef.current, Object.values(instructionIds).filter((value): value is string => Boolean(value)))
        : []
      return buildSavedPresetInstructionsResult(preset, contentItems, include_titles)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preset instruction attachments could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested preset could not be found.' }
      }
      return { status: 'error', message: 'Preset instruction attachments could not be loaded.' }
    }
  }
  registerDebugTool('get_current_preset_instructions', getCurrentPresetInstructionsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_current_preset_instructions',
    description: 'Return a lightweight summary of the instruction assets attached to the current or requested preset.',
    parameters: z.object({
      preset_id: z.string().optional(),
      use_visible_draft_if_available: z.boolean().default(true),
      include_titles: z.boolean().default(true),
    }),
    handler: traceToolHandler('get_current_preset_instructions', getCurrentPresetInstructionsHandler),
  }, [])

  const attachGenerationInstructionsHandler = async ({ instruction_id }: { instruction_id: string }) => {
    if (!window.acm2AssistantPresetBridge) {
      return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    }

    const result = await window.acm2AssistantPresetBridge.setDraftValue('selectedInstructionId', instruction_id)
    if (result.status !== 'updated') {
      return result
    }

    return {
      status: 'updated',
      generation_instructions_id: instruction_id,
    }
  }
  registerDebugTool('attach_generation_instructions_to_current_preset', attachGenerationInstructionsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'attach_generation_instructions_to_current_preset',
    description: 'Attach a generation-instructions asset to the visible preset draft through the mounted preset page bridge.',
    parameters: z.object({
      instruction_id: z.string(),
    }),
    handler: traceToolHandler('attach_generation_instructions_to_current_preset', attachGenerationInstructionsHandler),
  }, [])

  const attachEvalInstructionsHandler = async ({ kind, instruction_id }: { kind: 'single_eval' | 'pairwise_eval' | 'eval_criteria'; instruction_id: string }) => {
    if (!window.acm2AssistantPresetBridge) {
      return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    }

    const path = kind === 'single_eval'
      ? 'eval.singleEvalInstructionsId'
      : kind === 'pairwise_eval'
        ? 'eval.pairwiseEvalInstructionsId'
        : 'eval.evalCriteriaId'
    const result = await window.acm2AssistantPresetBridge.setDraftValue(path, instruction_id)
    if (result.status !== 'updated') {
      return result
    }

    return {
      status: 'updated',
      kind,
      instruction_id,
    }
  }
  registerDebugTool('attach_eval_instructions_to_current_preset', attachEvalInstructionsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'attach_eval_instructions_to_current_preset',
    description: 'Attach single-eval instructions, pairwise-eval instructions, or evaluation criteria to the visible preset draft through the mounted preset page bridge.',
    parameters: z.object({
      kind: z.enum(['single_eval', 'pairwise_eval', 'eval_criteria']),
      instruction_id: z.string(),
    }),
    handler: traceToolHandler('attach_eval_instructions_to_current_preset', attachEvalInstructionsHandler),
  }, [])

  const attachCombineInstructionsHandler = async ({ instruction_id }: { instruction_id: string }) => {
    const bridge = window.acm2AssistantPresetBridge
    if (!bridge) return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    const result = await bridge.setDraftValue('combine.combineInstructionsId', instruction_id)
    if (result.status !== 'updated') return result
    return { status: 'updated', combine_instructions_id: instruction_id }
  }
  registerDebugTool('attach_combine_instructions_to_current_preset', attachCombineInstructionsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'attach_combine_instructions_to_current_preset',
    description: 'Attach a combine-instructions Content Library record to the visible preset draft.',
    parameters: z.object({ instruction_id: z.string().trim().min(1) }),
    handler: traceToolHandler('attach_combine_instructions_to_current_preset', attachCombineInstructionsHandler),
  }, [])

  const setCurrentPresetEngineHandler = async ({ engine, enabled }: { engine: 'fpf' | 'gptr' | 'dr' | 'msagent' | 'aiq' | 'owl' | 'translation_agent' | 'marian' | 'pdfmathtranslate'; enabled: boolean }) => {
    if (!window.acm2AssistantPresetBridge) {
      return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    }

    const sectionPath = getPresetEngineDraftSectionPath(engine)
    const enabledResult = await window.acm2AssistantPresetBridge.setDraftValue(`${sectionPath}.enabled`, enabled)
    if (enabledResult.status !== 'updated') {
      return enabledResult
    }

    if (!enabled) {
      const clearModelsResult = await window.acm2AssistantPresetBridge.setDraftValue(`${sectionPath}.selectedModels`, [])
      if (clearModelsResult.status !== 'updated') {
        return clearModelsResult
      }
    }

    return {
      status: 'updated',
      engine,
      enabled,
    }
  }
  registerDebugTool('set_current_preset_engine', setCurrentPresetEngineHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'set_current_preset_engine',
    description: 'Enable or disable a specific engine in the visible preset draft through the mounted preset page bridge.',
    parameters: z.object({
      engine: z.enum(['fpf', 'gptr', 'dr', 'msagent', 'aiq', 'owl', 'translation_agent', 'marian', 'pdfmathtranslate']),
      enabled: z.boolean(),
    }),
    handler: traceToolHandler('set_current_preset_engine', setCurrentPresetEngineHandler),
  }, [])

  const setCurrentPresetIterationsHandler = async ({ iterations }: { iterations: number }) => {
    if (!window.acm2AssistantPresetBridge) {
      return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    }

    const result = await window.acm2AssistantPresetBridge.setDraftValue('general.iterations', iterations)
    if (result.status !== 'updated') {
      return result
    }

    return {
      status: 'updated',
      iterations,
    }
  }
  registerDebugTool('set_current_preset_iterations', setCurrentPresetIterationsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'set_current_preset_iterations',
    description: 'Set the visible preset draft iteration count through the mounted preset page bridge.',
    parameters: z.object({
      iterations: z.number().int().min(1).max(3),
    }),
    handler: traceToolHandler('set_current_preset_iterations', setCurrentPresetIterationsHandler),
  }, [])

  const setCurrentPresetSearchProviderHandler = async ({ provider }: { provider: string }) => {
    if (!window.acm2AssistantPresetBridge) {
      return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    }

    const updates = [
      ['gptr.retriever', provider],
      ['dr.searchProvider', provider],
      ['aiq.searchProvider', provider],
      ['aiq.runSearchProvider', provider],
      ['msagent.retriever', provider],
    ] as const

    for (const [path, value] of updates) {
      const result = await window.acm2AssistantPresetBridge.setDraftValue(path, value)
      if (result.status !== 'updated') {
        return result
      }
    }

    return {
      status: 'updated',
      provider,
    }
  }
  registerDebugTool('set_current_preset_search_provider', setCurrentPresetSearchProviderHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'set_current_preset_search_provider',
    description: 'Set the visible preset draft search or retrieval provider through the mounted preset page bridge.',
    parameters: z.object({
      provider: z.string().min(1),
    }),
    handler: traceToolHandler('set_current_preset_search_provider', setCurrentPresetSearchProviderHandler),
  }, [])

  const setCurrentPresetEngineModelsHandler = async ({ engine, models }: { engine: PresetModelSection; models: string[] }) => {
    if (!window.acm2AssistantPresetBridge) {
      return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    }

    const visibleDraft = window.acm2AssistantPresetBridge.getDraft() as VisiblePresetDraft
    const eligible = visibleDraft.eligibleModelSections ?? {}
    const selectedModels = uniqueStrings(models)
    const incompatible = selectedModels.filter((model) => !(eligible[model] ?? []).includes(engine))
    if (incompatible.length > 0) {
      return { status: 'error', message: `Models are not compatible with ${engine}: ${incompatible.join(', ')}` }
    }
    const sectionPathByEngine: Record<PresetModelSection, string> = {
      fpf: 'fpf',
      gptr: 'gptr',
      dr: 'dr',
      msagent: 'msagent',
      aiq: 'aiq',
      owl: 'owl',
      translation_agent: 'translationAgent',
      marian: 'marian',
      pdfmathtranslate: 'pdfMathTranslate',
      eval: 'eval',
      combine: 'combine',
    }
    const sectionPath = sectionPathByEngine[engine]
    const modelPath = engine === 'eval' ? 'eval.judgeModels' : `${sectionPath}.selectedModels`
    const modelResult = await window.acm2AssistantPresetBridge.setDraftValue(modelPath, selectedModels)
    if (modelResult.status !== 'updated') return modelResult
    const enabledResult = await window.acm2AssistantPresetBridge.setDraftValue(`${sectionPath}.enabled`, selectedModels.length > 0)
    if (enabledResult.status !== 'updated') return enabledResult

    return {
      status: 'updated',
      engine,
      selected_models: selectedModels,
    }
  }
  registerDebugTool('set_current_preset_engine_models', setCurrentPresetEngineModelsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'set_current_preset_engine_models',
    description: 'Replace model selections for exactly one generation, Eval, or Combine section after validating page-owned compatibility.',
    parameters: z.object({
      engine: z.enum(['fpf', 'gptr', 'dr', 'msagent', 'aiq', 'owl', 'translation_agent', 'marian', 'pdfmathtranslate', 'eval', 'combine']),
      models: z.array(z.string().trim().min(1)).max(20),
    }),
    handler: traceToolHandler('set_current_preset_engine_models', setCurrentPresetEngineModelsHandler),
  }, [])

  useFrontendTool({
    name: 'get_current_preset_draft',
    description: 'Return the visible preset-page draft when the preset page is mounted.',
    parameters: z.object({}),
    handler: traceToolHandler('get_current_preset_draft', async () => {
      if (window.acm2AssistantPresetBridge) {
        return { status: 'loaded', source: 'visible_preset_page', draft: window.acm2AssistantPresetBridge.getDraft() }
      }
      return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    }),
  }, [])

  const createNewPresetHandler = async ({ name, description }: { name: string; description?: string }) => {
    const bridge = window.acm2AssistantPresetBridge
    if (!bridge) return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    const started = await bridge.startNewPresetDraft()
    if (started.status !== 'started_new_draft') return started
    const named = await bridge.setDraftValue('presetName', name)
    if (named.status !== 'updated') return named
    if (description) {
      const described = await bridge.setDraftValue('runDescription', description)
      if (described.status !== 'updated') return described
    }
    return { status: 'created_draft', name, description: description ?? '' }
  }
  registerDebugTool('create_new_preset', createNewPresetHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'create_new_preset',
    description: 'Start a clean new preset draft and set its name using typed string fields. Never edits the previously loaded preset.',
    parameters: z.object({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).optional(),
    }),
    handler: traceToolHandler('create_new_preset', createNewPresetHandler),
  }, [])

  const setCurrentPresetNameHandler = async ({ name }: { name: string }) => {
    const bridge = window.acm2AssistantPresetBridge
    if (!bridge) return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    return bridge.setDraftValue('presetName', name)
  }
  registerDebugTool('set_current_preset_name', setCurrentPresetNameHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'set_current_preset_name',
    description: 'Set the visible preset draft name using a validated string.',
    parameters: z.object({ name: z.string().trim().min(1).max(200) }),
    handler: traceToolHandler('set_current_preset_name', setCurrentPresetNameHandler),
  }, [])

  const listAvailableGenerationModelsHandler = async () => {
    const bridge = window.acm2AssistantPresetBridge
    if (!bridge) return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    const draft = bridge.getDraft() as VisiblePresetDraft
    const eligible = draft.eligibleModelSections ?? {}
    return {
      status: 'loaded',
      models: Object.entries(eligible).map(([id, engines]) => ({ id, eligible_engines: engines })),
    }
  }
  registerDebugTool('list_available_generation_models', listAvailableGenerationModelsHandler)
  useFrontendTool({
    name: 'list_available_generation_models',
    description: 'List model ids currently available in the preset page and the generation, Eval, or Combine sections each model supports.',
    parameters: z.object({}),
    handler: traceToolHandler('list_available_generation_models', listAvailableGenerationModelsHandler),
  }, [])

  const selectCurrentPresetInputDocumentsHandler = async ({ document_ids }: { document_ids: string[] }) => {
    const bridge = window.acm2AssistantPresetBridge
    if (!bridge) return { status: 'unavailable', message: 'No visible preset page draft is mounted.' }
    return bridge.setDraftValue('selectedInputDocIds', document_ids)
  }
  registerDebugTool('select_current_preset_input_documents', selectCurrentPresetInputDocumentsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'select_current_preset_input_documents',
    description: 'Replace the visible preset draft input-document selection using validated document ids.',
    parameters: z.object({ document_ids: z.array(z.string().trim().min(1)).max(50) }),
    handler: traceToolHandler('select_current_preset_input_documents', selectCurrentPresetInputDocumentsHandler),
  }, [])

  useFrontendTool({
    name: 'save_current_preset',
    description: 'Save the current visible preset page draft through the page save handler.',
    parameters: z.object({
      reason: z.string().optional(),
    }),
    handler: traceToolHandler('save_current_preset', async () => {
      if (window.acm2AssistantPresetBridge) {
        return normalizePageBridgeMutationResult(await window.acm2AssistantPresetBridge.saveCurrentPreset(), 'saved')
      }
      return { status: 'unavailable', message: 'No visible preset page is mounted, so there is no page-owned draft to save.' }
    }),
  }, [])

  useFrontendTool({
    name: 'execute_current_preset',
    description: 'Execute the visible/current preset through the browser page workflow.',
    parameters: z.object({
      reason: z.string().optional(),
    }),
    handler: traceToolHandler('execute_current_preset', async () => {
      if (window.acm2AssistantPresetBridge) {
        return normalizePageBridgeMutationResult(await window.acm2AssistantPresetBridge.executeCurrentPreset(), 'started')
      }
      return { status: 'unavailable', message: 'No visible preset page is mounted, so there is no page-owned preset execution workflow to use.' }
    }),
  }, [])

  useFrontendTool({
    name: 'get_loaded_history_rows',
    description: 'Return run history rows already loaded by this assistant session; does not fetch new history.',
    parameters: z.object({}),
    handler: traceToolHandler('get_loaded_history_rows', async () => ({
      loaded: Boolean(cacheRef.current.runList),
      items: cacheRef.current.runList ?? [],
    })),
  }, [])

  useFrontendTool({
    name: 'get_recent_runs_for_assistant',
    description: 'Load recent runs through the browser frontend API client without navigating, so run questions are app-wide rather than limited to the current route.',
    parameters: z.object({
      limit: z.number().int().min(1).max(100).default(ASSISTANT_RECENT_RUN_PRELOAD_LIMIT),
    }),
    handler: traceToolHandler('get_recent_runs_for_assistant', async ({ limit }) => {
      const runs = await ensureRecentRuns(limit)
      return {
        status: 'loaded',
        latest_run_id: cacheRef.current.latestRunId ?? runs[0]?.id ?? null,
        count: runs.length,
        runs: runs.map(buildRunListItem),
        interpretation_notes: [
          'These runs were loaded app-wide through the frontend API; they do not depend on the visible route.',
          'The first item is treated as the latest run because the existing Execute page also resolves latest with /runs?limit=1.',
        ],
      }
    }),
  }, [])

  const getLatestRunContextHandler = async ({ include_failure_signals, include_output_summary }: { include_failure_signals: boolean; include_output_summary: boolean }) => {
    await preloadAppWideAssistantContext()
    const { run, resolved } = await loadRunForAssistant()
    if (!run) {
      return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
    }

    const result: Record<string, unknown> = {
      status: 'loaded',
      resolved_run: resolved,
      latest_run_id: run.id,
      run: buildRunListItem(run),
      status_summary: buildRunStatusSummaryResult(run),
      cache: getCacheSummary(),
      interpretation_notes: [
        'This context is app-wide frontend state, not merely visible route state.',
        'Use this when the user says "the run" and no specific run id is visible or provided.',
      ],
    }

    let eventLogs: AssistantLogResponse | null = null

    if (include_failure_signals) {
      const logCacheKey = `${run.id}:event`
      eventLogs = cacheRef.current.logsByRunId[logCacheKey] ?? null
      if (!eventLogs) {
        eventLogs = await loadAssistantRunLogs(run.id, 'event')
        cacheRef.current.logsByRunId[logCacheKey] = eventLogs
      }
      result.failure_signals = buildRunFailureSignalsResult(run, eventLogs)
    }

    if (include_output_summary) {
      if (!eventLogs && (run.generated_docs?.length ?? 0) === 0 && isTerminalRunStatus(run.status)) {
        const logCacheKey = `${run.id}:event`
        eventLogs = cacheRef.current.logsByRunId[logCacheKey] ?? null
        if (!eventLogs) {
          eventLogs = await loadAssistantRunLogs(run.id, 'event')
          cacheRef.current.logsByRunId[logCacheKey] = eventLogs
        }
      }
      result.output_summary = buildRunOutputSummaryResult(
        run,
        true,
        eventLogs ? extractRunArtifactEvidence(eventLogs.entries) : undefined,
      )
    }

    return result
  }
  registerDebugTool('get_latest_run_context', getLatestRunContextHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_latest_run_context',
    description: 'Return preloaded app-wide context for the latest run, including status and optional failure/output summaries.',
    parameters: z.object({
      include_failure_signals: z.boolean().default(true),
      include_output_summary: z.boolean().default(true),
    }),
    handler: traceToolHandler('get_latest_run_context', getLatestRunContextHandler),
  }, [])

  useFrontendTool({
    name: 'load_run_for_assistant',
    description: 'Lazily load one requested run through the browser frontend API client without navigating; if no run_id is provided, resolve the latest app-wide run.',
    parameters: z.object({
      run_id: z.string().optional(),
    }),
    handler: traceToolHandler('load_run_for_assistant', async ({ run_id }) => {
      try {
        const { run, resolved } = await loadRunForAssistant(run_id)
        if (!run) {
          return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
        }
        return { status: 'loaded', resolved_run: resolved, run }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Run could not be loaded.'
        if (message.toLowerCase().includes('not found')) {
          return {
            status: 'not_found',
            requested_run_id: run_id ?? null,
            message: 'The requested run could not be found.',
            next_steps: [
              'Check the run id for typos.',
              'Call get_recent_runs_for_assistant to list valid recent run ids.',
              'Omit run_id to load the latest app-wide run.',
            ],
          }
        }
        return {
          status: 'error',
          requested_run_id: run_id ?? null,
          message: 'Run could not be loaded.',
          error_message: message,
        }
      }
    }),
  }, [])

  const getRunStatusSummaryHandler = async ({ run_id }: { run_id?: string }) => {
    try {
      const { run, resolved } = await loadRunForAssistant(run_id)
      if (!run) {
        return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
      }
      return { ...buildRunStatusSummaryResult(run), resolved_run: resolved }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Run status summary could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested run could not be found.' }
      }
      return { status: 'error', message: 'Run status summary could not be loaded.' }
    }
  }
  registerDebugTool('get_run_status_summary', getRunStatusSummaryHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_run_status_summary',
    description: 'Return a compact summary of the current or requested run state so the assistant can explain what happened at a glance.',
    parameters: z.object({
      run_id: z.string().optional(),
    }),
    handler: traceToolHandler('get_run_status_summary', getRunStatusSummaryHandler),
  }, [])

  const getRunCostSummaryHandler = async ({ run_id }: { run_id?: string }) => {
    try {
      const { run, resolved } = await loadRunForAssistant(run_id)
      if (!run) {
        return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
      }
      return { ...buildRunCostSummaryResult(run), resolved_run: resolved }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Run cost summary could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested run could not be found.' }
      }
      return { status: 'error', message: 'Run cost summary could not be loaded.' }
    }
  }
  registerDebugTool('get_run_cost_summary', getRunCostSummaryHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_run_cost_summary',
    description: 'Return a compact, current cost and pricing-completeness summary for the requested or latest run.',
    parameters: z.object({
      run_id: z.string().optional(),
    }),
    handler: traceToolHandler('get_run_cost_summary', getRunCostSummaryHandler),
  }, [])

  const getRunFailureSignalsHandler = async ({ run_id, classification }: { run_id?: string; classification: 'event' | 'all' }) => {
    try {
      const { run, resolved } = await loadRunForAssistant(run_id)
      if (!run) {
        return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
      }
      const logCacheKey = `${run.id}:${classification}`
      let logs = cacheRef.current.logsByRunId[logCacheKey]
      if (!logs) {
        try {
          logs = await loadAssistantRunLogs(run.id, classification)
          cacheRef.current.logsByRunId[logCacheKey] = logs
        } catch {
          logs = { run_id: run.id, entries: [] }
        }
      }
      cacheRef.current.logsByRunId[logCacheKey] = logs
      return { ...buildRunFailureSignalsResult(run, logs), resolved_run: resolved }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Run failure signals could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested run could not be found.' }
      }
      return { status: 'error', message: 'Run failure signals could not be loaded.' }
    }
  }
  registerDebugTool('get_run_failure_signals', getRunFailureSignalsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_run_failure_signals',
    description: 'Return the strongest visible failure clues for the current or requested run using frontend-accessible run data and logs.',
    parameters: z.object({
      run_id: z.string().optional(),
      classification: z.enum(['event', 'all']).default('event'),
    }),
    handler: traceToolHandler('get_run_failure_signals', getRunFailureSignalsHandler),
  }, [])

  const getRunOutputSummaryHandler = async ({ run_id, include_document_titles }: { run_id?: string; include_document_titles: boolean }) => {
    try {
      const { run, resolved } = await loadRunForAssistant(run_id)
      if (!run) {
        return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
      }
      let artifactEvidence: RunArtifactEvidence | undefined
      if ((run.generated_docs?.length ?? 0) === 0 && isTerminalRunStatus(run.status)) {
        const logCacheKey = `${run.id}:event`
        let logs = cacheRef.current.logsByRunId[logCacheKey]
        if (!logs) {
          logs = await loadAssistantRunLogs(run.id, 'event')
          cacheRef.current.logsByRunId[logCacheKey] = logs
        }
        artifactEvidence = extractRunArtifactEvidence(logs.entries)
      }
      return { ...buildRunOutputSummaryResult(run, include_document_titles, artifactEvidence), resolved_run: resolved }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Run output summary could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return { status: 'not_found', message: 'The requested run could not be found.' }
      }
      return { status: 'error', message: 'Run output summary could not be loaded.' }
    }
  }
  registerDebugTool('get_run_output_summary', getRunOutputSummaryHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'get_run_output_summary',
    description: 'Return a compact summary of the outputs produced by the current or requested run.',
    parameters: z.object({
      run_id: z.string().optional(),
      include_document_titles: z.boolean().default(true),
    }),
    handler: traceToolHandler('get_run_output_summary', getRunOutputSummaryHandler),
  }, [])

  useFrontendTool({
    name: 'load_run_logs_for_assistant',
    description: 'Lazily load user-visible logs for one requested or latest run through the browser frontend API client.',
    parameters: z.object({
      run_id: z.string().optional(),
      classification: z.enum(['event', 'all']).default('event'),
      limit: z.number().int().min(1).max(500).default(200),
    }),
    handler: traceToolHandler('load_run_logs_for_assistant', async ({ run_id, classification, limit }) => {
      const { run, resolved } = await loadRunForAssistant(run_id)
      if (!run) {
        return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
      }
      const logs = await apiClient.get<AssistantLogResponse>(`/runs/${run.id}/logs`, { classification, limit })
      const normalizedLogs = normalizeAssistantLogs(logs)
      cacheRef.current.logsByRunId[`${run.id}:${classification}`] = normalizedLogs
      return buildRunLogLoadResult(run, resolved, classification, limit, normalizedLogs)
    }),
  }, [])

  const watchRunLogsHandler = async ({
    run_id,
    after_offset = 0,
    wait_seconds = 10,
    max_entries = 20,
  }: {
    run_id?: string
    after_offset?: number
    wait_seconds?: number
    max_entries?: number
  }) => {
    let loadedRun: Awaited<ReturnType<typeof loadRunForAssistant>>
    try {
      loadedRun = await loadRunForAssistant(run_id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Run could not be loaded.'
      if (message.toLowerCase().includes('not found')) {
        return {
          status: 'not_found',
          run_id: run_id ?? null,
          returned_entries: 0,
          entries: [],
          message: 'The requested run was not found through this logged-in user website session.',
        }
      }
      return {
        status: 'error',
        run_id: run_id ?? null,
        returned_entries: 0,
        entries: [],
        message: 'Verbose run logs could not be loaded through the website session.',
      }
    }
    const { run, resolved } = loadedRun
    if (!run) {
      return { status: 'unavailable', message: 'No recent runs are available to watch.' }
    }

    const requestedOffset = Math.max(0, Math.trunc(after_offset || 0))
    const effectiveWaitSeconds = Math.max(0, Math.min(30, Math.trunc(wait_seconds || 0)))
    const effectiveMaxEntries = Math.max(1, Math.min(50, Math.trunc(max_entries || 20)))
    const pollStartedAt = Date.now()
    let countResponse = await apiClient.get<{ run_id: string; total: number; save_run_logs?: boolean }>(
      `/runs/${run.id}/logs/count`,
      { classification: 'all' },
    )

    while (
      countResponse.total <= requestedOffset &&
      Date.now() - pollStartedAt < effectiveWaitSeconds * 1000
    ) {
      const live = await runsApi.getLiveSummary(run.id)
      if (isTerminalRunStatus(live.status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 2000))
      countResponse = await apiClient.get<{ run_id: string; total: number; save_run_logs?: boolean }>(
        `/runs/${run.id}/logs/count`,
        { classification: 'all' },
      )
    }

    const effectiveOffset = Math.min(requestedOffset, countResponse.total)
    const response = await apiClient.get<AssistantLogResponse>(`/runs/${run.id}/logs`, {
      classification: 'all',
      offset: effectiveOffset,
      limit: effectiveMaxEntries,
    })
    const normalized = normalizeAssistantLogs(response)
    const live = await runsApi.getLiveSummary(run.id)
    const responseCharBudget = 8_000
    const entries: Array<{
      id: number | null
      timestamp: string | null
      classification: string | null
      source: string | null
      level: string | null
      event_type: string | null
      message: string
      message_truncated: boolean
      payload: string | null
      payload_truncated: boolean
    }> = []
    let responseChars = 0
    for (const entry of normalized.entries) {
      const candidate = {
        id: entry.id ?? null,
        timestamp: entry.timestamp ?? null,
        classification: (entry as AssistantLogEntry & { classification?: string }).classification ?? null,
        source: entry.source ?? null,
        level: entry.level ?? null,
        event_type: entry.event_type ?? null,
        message: truncateForAssistant(typeof entry.message === 'string' ? entry.message : '', 2000),
        message_truncated: typeof entry.message === 'string' && entry.message.length > 2000,
        payload: typeof entry.payload === 'string' ? truncateForAssistant(entry.payload, 4000) : entry.payload ?? null,
        payload_truncated: typeof entry.payload === 'string' && entry.payload.length > 4000,
      }
      const candidateChars = JSON.stringify(candidate).length
      if (entries.length > 0 && responseChars + candidateChars > responseCharBudget) break
      entries.push(candidate)
      responseChars += candidateChars
    }
    const nextOffset = effectiveOffset + entries.length
    const total = normalized.total ?? countResponse.total
    const waitedMs = Date.now() - pollStartedAt

    return {
      status: entries.length > 0 ? 'delta' : 'no_delta',
      source: 'frontend_run_logs_api',
      run_id: run.id,
      resolved_run: resolved,
      run_status: live.status,
      terminal: isTerminalRunStatus(live.status),
      classification: 'all',
      verbose_detail_included: true,
      requested_after_offset: requestedOffset,
      effective_offset: effectiveOffset,
      next_offset: nextOffset,
      total_entries: total,
      remaining_entries: Math.max(0, total - nextOffset),
      has_more: nextOffset < total,
      returned_entries: entries.length,
      requested_max_entries: effectiveMaxEntries,
      response_char_budget: responseCharBudget,
      approximate_response_chars: responseChars,
      stopped_for_char_budget: entries.length < normalized.entries.length,
      waited_ms: waitedMs,
      timed_out_without_delta: entries.length === 0 && waitedMs >= effectiveWaitSeconds * 1000,
      save_run_logs: normalized.save_run_logs ?? countResponse.save_run_logs ?? null,
      earliest_returned_timestamp: entries[0]?.timestamp ?? null,
      latest_returned_timestamp: entries[entries.length - 1]?.timestamp ?? null,
      entries,
      next_call: {
        run_id: run.id,
        after_offset: nextOffset,
        wait_seconds: effectiveWaitSeconds,
        max_entries: effectiveMaxEntries,
      },
      notes: [
        'Call this tool again with next_call to consume every verbose log entry in order as the website appends it.',
        'This is bounded long-polling over the logged-in website API, not a model-visible WebSocket or unrestricted backend stream.',
        'Every entry remains reachable through next_offset, while each call is capped near 8,000 serialized characters to protect the assistant context.',
        'Messages longer than 2,000 characters and payloads longer than 4,000 characters are marked truncated.',
      ],
    }
  }
  registerDebugTool('watch_run_logs_for_assistant', watchRunLogsHandler as (args?: Record<string, unknown>) => Promise<unknown>)
  useFrontendTool({
    name: 'watch_run_logs_for_assistant',
    description: 'Long-poll the same user-scoped verbose run-log API used by the Execute page and return the next ordered EVENT+DETAIL chunk. Start with after_offset 0, then repeat with the returned next_call until has_more is false; when a run is active, wait_seconds can hold the call for up to 30 seconds for newly appended logs.',
    parameters: z.object({
      run_id: z.string().optional(),
      after_offset: z.number().int().min(0).default(0),
      wait_seconds: z.number().int().min(0).max(30).default(10),
      max_entries: z.number().int().min(1).max(50).default(20),
    }),
    handler: traceToolHandler('watch_run_logs_for_assistant', watchRunLogsHandler),
  }, [])

  useFrontendTool({
    name: 'load_run_outputs_for_assistant',
    description: 'Lazily load generated outputs for one requested or latest run through the browser frontend API client. max_documents is capped at 10; never suggest or call a larger value.',
    parameters: z.object({
      run_id: z.string().optional().describe('Run id to inspect. Omit to resolve the latest app-wide run.'),
      max_documents: z.number().int().min(1).max(10).default(5).describe('Maximum generated output documents to load. Must be 1 through 10; use 10 for the largest allowed request.'),
    }),
    handler: traceToolHandler('load_run_outputs_for_assistant', async ({ run_id, max_documents }) => {
      const { run, resolved } = await loadRunForAssistant(run_id)
      if (!run) {
        return { status: 'unavailable', message: 'No recent runs are available to inspect.' }
      }
      const requestedMaxDocuments = Number.isFinite(max_documents) ? Math.trunc(max_documents) : 5
      const effectiveMaxDocuments = clampAssistantOutputDocumentLimit(requestedMaxDocuments)
      const bounded = requestedMaxDocuments !== effectiveMaxDocuments
      const outputs = await preloadRunOutputs(cacheRef.current, run, effectiveMaxDocuments)
      return {
        status: bounded ? 'bounded' : 'loaded',
        run_id: run.id,
        resolved_run: resolved,
        requested_max_documents: requestedMaxDocuments,
        effective_max_documents: effectiveMaxDocuments,
        max_documents_limit: 10,
        boundary_message: bounded
          ? `Requested max_documents=${requestedMaxDocuments}; using ${effectiveMaxDocuments} because assistant output loading is limited to 1 through 10 documents per call.`
          : undefined,
        outputs,
      }
    }),
  }, [])

  useFrontendTool({
    name: 'refresh_current_page_data',
    description: 'Refresh assistant-local data for the current ACM page without bulk preloading unrelated data.',
    parameters: z.object({}),
    handler: traceToolHandler('refresh_current_page_data', async () => {
      const context = getPageContext()
      await ensurePresetList({ force: true }).catch(() => null)
      if (context.active_preset_id) {
        const preset = await getPreset(context.active_preset_id)
        cacheRef.current.presetsById[preset.id] = preset
      }
      if (context.current_run_id) {
        const { run } = await loadRunForAssistant(context.current_run_id)
        if (run) cacheRef.current.runsById[run.id] = run
      }
      await ensureRecentRuns(ASSISTANT_RECENT_RUN_PRELOAD_LIMIT).catch(() => [])
      return { status: 'refreshed', page_context: sanitizePageContext(context), cache: getCacheSummary() }
    }),
  }, [])

  useEffect(() => {
    if (!enabled) {
      delete window.acm2SharedUserActionBridge
      return
    }
    const bridge = {
      listTools: () => ALLIE_OWL_SHARED_ACTION_NAMES,
      invoke: async (name: string, args: Record<string, unknown> = {}) => {
        if (!ALLIE_OWL_SHARED_ACTION_NAMES.includes(name as typeof ALLIE_OWL_SHARED_ACTION_NAMES[number])) {
          return { status: 'not_allowed', requested_tool: name, allowed_tools: ALLIE_OWL_SHARED_ACTION_NAMES }
        }
        return createSharedUserActionInvoker().invoke(name, args)
      },
    }
    window.acm2SharedUserActionBridge = bridge
    return () => {
      if (window.acm2SharedUserActionBridge === bridge) delete window.acm2SharedUserActionBridge
    }
  }, [enabled])

  const sharedUserActions = createSharedUserActionInvoker()
  const sharedListContentHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_list_content', args)
  const sharedGetContentHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_get_content', args)
  const sharedCreateContentHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_create_content', args)
  const sharedUpdateContentHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_update_content', args)
  const sharedDeleteContentHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_delete_content', args)
  const sharedListPresetsHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_list_presets', args)
  const sharedGetPresetHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_get_preset', args)
  const sharedValidatePresetHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_validate_preset', args)
  const sharedCreatePresetHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_create_preset', args)
  const sharedUpdatePresetHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_update_preset', args)
  const sharedDeletePresetHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_delete_preset', args)
  const sharedExecutePresetHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_execute_preset', args)
  const sharedListRunsHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_list_runs', args)
  const sharedGetRunHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_get_run', args)
  const sharedGetRunLogsHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_get_run_logs', args)
  const sharedGetOutputHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_get_generated_output', args)
  const sharedPauseRunHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_pause_run', args)
  const sharedResumeRunHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_resume_run', args)
  const sharedCancelRunHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_cancel_run', args)
  const sharedListModelsHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_list_models', args)
  const sharedUsageHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_get_usage', args)
  const sharedCreditsHandler = (args: Record<string, unknown> = {}) => sharedUserActions.invoke('apicostx_get_credits', args)

  registerDebugTool('apicostx_list_content', sharedListContentHandler)
  useFrontendTool({ name: 'apicostx_list_content', description: 'List the logged-in user Content Library through the authenticated website API.', parameters: sharedActionParameters('apicostx_list_content'), handler: traceToolHandler('apicostx_list_content', sharedListContentHandler) }, [])
  registerDebugTool('apicostx_get_content', sharedGetContentHandler)
  useFrontendTool({ name: 'apicostx_get_content', description: 'Read one logged-in user Content Library item through the authenticated website API.', parameters: sharedActionParameters('apicostx_get_content'), handler: traceToolHandler('apicostx_get_content', sharedGetContentHandler) }, [])
  registerDebugTool('apicostx_create_content', sharedCreateContentHandler)
  useFrontendTool({ name: 'apicostx_create_content', description: 'Create user-owned APICostX content through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_create_content'), handler: traceToolHandler('apicostx_create_content', sharedCreateContentHandler) }, [])
  registerDebugTool('apicostx_update_content', sharedUpdateContentHandler)
  useFrontendTool({ name: 'apicostx_update_content', description: 'Update user-owned APICostX content through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_update_content'), handler: traceToolHandler('apicostx_update_content', sharedUpdateContentHandler) }, [])
  registerDebugTool('apicostx_delete_content', sharedDeleteContentHandler)
  useFrontendTool({ name: 'apicostx_delete_content', description: 'Delete user-owned APICostX content through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_delete_content'), handler: traceToolHandler('apicostx_delete_content', sharedDeleteContentHandler) }, [])
  registerDebugTool('apicostx_list_presets', sharedListPresetsHandler)
  useFrontendTool({ name: 'apicostx_list_presets', description: 'List saved APICostX presets through the authenticated website API.', parameters: sharedActionParameters('apicostx_list_presets'), handler: traceToolHandler('apicostx_list_presets', sharedListPresetsHandler) }, [])
  registerDebugTool('apicostx_get_preset', sharedGetPresetHandler)
  useFrontendTool({ name: 'apicostx_get_preset', description: 'Read one saved APICostX preset through the authenticated website API.', parameters: sharedActionParameters('apicostx_get_preset'), handler: traceToolHandler('apicostx_get_preset', sharedGetPresetHandler) }, [])
  registerDebugTool('apicostx_validate_preset', sharedValidatePresetHandler)
  useFrontendTool({ name: 'apicostx_validate_preset', description: 'Validate one saved APICostX preset through the authenticated website API.', parameters: sharedActionParameters('apicostx_validate_preset'), handler: traceToolHandler('apicostx_validate_preset', sharedValidatePresetHandler) }, [])
  registerDebugTool('apicostx_create_preset', sharedCreatePresetHandler)
  useFrontendTool({ name: 'apicostx_create_preset', description: 'Create a user-owned APICostX preset through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_create_preset'), handler: traceToolHandler('apicostx_create_preset', sharedCreatePresetHandler) }, [])
  registerDebugTool('apicostx_update_preset', sharedUpdatePresetHandler)
  useFrontendTool({ name: 'apicostx_update_preset', description: 'Update a user-owned APICostX preset through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_update_preset'), handler: traceToolHandler('apicostx_update_preset', sharedUpdatePresetHandler) }, [])
  registerDebugTool('apicostx_delete_preset', sharedDeletePresetHandler)
  useFrontendTool({ name: 'apicostx_delete_preset', description: 'Delete a user-owned APICostX preset through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_delete_preset'), handler: traceToolHandler('apicostx_delete_preset', sharedDeletePresetHandler) }, [])
  registerDebugTool('apicostx_execute_preset', sharedExecutePresetHandler)
  useFrontendTool({ name: 'apicostx_execute_preset', description: 'Execute a saved APICostX preset through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_execute_preset'), handler: traceToolHandler('apicostx_execute_preset', sharedExecutePresetHandler) }, [])
  registerDebugTool('apicostx_list_runs', sharedListRunsHandler)
  useFrontendTool({ name: 'apicostx_list_runs', description: 'List the logged-in user APICostX runs through the authenticated website API.', parameters: sharedActionParameters('apicostx_list_runs'), handler: traceToolHandler('apicostx_list_runs', sharedListRunsHandler) }, [])
  registerDebugTool('apicostx_get_run', sharedGetRunHandler)
  useFrontendTool({ name: 'apicostx_get_run', description: 'Read one APICostX run through the authenticated website API.', parameters: sharedActionParameters('apicostx_get_run'), handler: traceToolHandler('apicostx_get_run', sharedGetRunHandler) }, [])
  registerDebugTool('apicostx_get_run_logs', sharedGetRunLogsHandler)
  useFrontendTool({ name: 'apicostx_get_run_logs', description: 'Read bounded APICostX run logs through the authenticated website API.', parameters: sharedActionParameters('apicostx_get_run_logs'), handler: traceToolHandler('apicostx_get_run_logs', sharedGetRunLogsHandler) }, [])
  registerDebugTool('apicostx_get_generated_output', sharedGetOutputHandler)
  useFrontendTool({ name: 'apicostx_get_generated_output', description: 'Read one generated APICostX output through the authenticated website API.', parameters: sharedActionParameters('apicostx_get_generated_output'), handler: traceToolHandler('apicostx_get_generated_output', sharedGetOutputHandler) }, [])
  registerDebugTool('apicostx_pause_run', sharedPauseRunHandler)
  useFrontendTool({ name: 'apicostx_pause_run', description: 'Pause a user-owned APICostX run through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_pause_run'), handler: traceToolHandler('apicostx_pause_run', sharedPauseRunHandler) }, [])
  registerDebugTool('apicostx_resume_run', sharedResumeRunHandler)
  useFrontendTool({ name: 'apicostx_resume_run', description: 'Resume a user-owned APICostX run through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_resume_run'), handler: traceToolHandler('apicostx_resume_run', sharedResumeRunHandler) }, [])
  registerDebugTool('apicostx_cancel_run', sharedCancelRunHandler)
  useFrontendTool({ name: 'apicostx_cancel_run', description: 'Cancel a user-owned APICostX run through the authenticated website API after explicit confirmation.', parameters: sharedActionParameters('apicostx_cancel_run'), handler: traceToolHandler('apicostx_cancel_run', sharedCancelRunHandler) }, [])
  registerDebugTool('apicostx_list_models', sharedListModelsHandler)
  useFrontendTool({ name: 'apicostx_list_models', description: 'List APICostX models through the authenticated website API.', parameters: sharedActionParameters('apicostx_list_models'), handler: traceToolHandler('apicostx_list_models', sharedListModelsHandler) }, [])
  registerDebugTool('apicostx_get_usage', sharedUsageHandler)
  useFrontendTool({ name: 'apicostx_get_usage', description: 'Read APICostX usage through the authenticated website API.', parameters: sharedActionParameters('apicostx_get_usage'), handler: traceToolHandler('apicostx_get_usage', sharedUsageHandler) }, [])
  registerDebugTool('apicostx_get_credits', sharedCreditsHandler)
  useFrontendTool({ name: 'apicostx_get_credits', description: 'Read the logged-in user APICostX credit balance through the authenticated website API.', parameters: sharedActionParameters('apicostx_get_credits'), handler: traceToolHandler('apicostx_get_credits', sharedCreditsHandler) }, [])

  useFrontendTool({ name: 'apicostx_duplicate_content', description: "Duplicate an existing content item.", parameters: sharedActionParameters('apicostx_duplicate_content'), handler: (args) => sharedUserActions.invoke('apicostx_duplicate_content', args as Record<string, unknown>) }, [])
  useFrontendTool({ name: 'apicostx_resolve_content', description: "Preview content with runtime variables substituted.", parameters: sharedActionParameters('apicostx_resolve_content'), handler: (args) => sharedUserActions.invoke('apicostx_resolve_content', args as Record<string, unknown>) }, [])
  useFrontendTool({ name: 'apicostx_duplicate_preset', description: "Duplicate a saved preset.", parameters: sharedActionParameters('apicostx_duplicate_preset'), handler: (args) => sharedUserActions.invoke('apicostx_duplicate_preset', args as Record<string, unknown>) }, [])
  useFrontendTool({ name: 'apicostx_get_resume_info', description: "Read run recovery eligibility and checkpoint summary.", parameters: sharedActionParameters('apicostx_get_resume_info'), handler: (args) => sharedUserActions.invoke('apicostx_get_resume_info', args as Record<string, unknown>) }, [])
  useFrontendTool({ name: 'apicostx_get_checkpoint', description: "Read run task checkpoint counts.", parameters: sharedActionParameters('apicostx_get_checkpoint'), handler: (args) => sharedUserActions.invoke('apicostx_get_checkpoint', args as Record<string, unknown>) }, [])
  useFrontendTool({ name: 'apicostx_delete_run', description: "Delete one user-owned run.", parameters: sharedActionParameters('apicostx_delete_run'), handler: (args) => sharedUserActions.invoke('apicostx_delete_run', args as Record<string, unknown>) }, [])

  return useMemo(() => null, [])
}

function sanitizePageContext(context: PageContext) {
  return {
    route: context.route,
    page: context.page,
    active_preset_id: context.active_preset_id,
    current_run_id: context.current_run_id,
    logged_in: Boolean(window.acm2Config?.currentUser),
  }
}

function normalizePageBridgeMutationResult(result: unknown, successStatus: 'saved' | 'started') {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const value = result as Record<string, unknown>
    if (typeof value.status === 'string') {
      return value
    }
  }
  return { status: successStatus, result }
}

function normalizeAssistantNavigationRoute(input: string | undefined) {
  if (!input || typeof input !== 'string') return null
  let route = input.trim()
  if (!route) return null

  if (route.startsWith(window.location.origin)) {
    const url = new URL(route)
    route = url.hash.replace(/^#/, '') || url.pathname
  }
  route = route.replace(/^#/, '')
  if (!route.startsWith('/')) route = `/${route}`
  route = route.replace(/\/+$/, '') || '/'

  const aliasMap: Record<string, string> = {
    '/': '/presets',
    '/configure': '/presets',
    '/preset': '/presets',
    '/presets14': '/presets',
    '/runs': '/execute',
    '/run': '/execute',
    '/executions': '/execute',
    '/execution': '/execute',
    '/execute/latest': '/execute',
    '/flow': '/flow-lab',
    '/flows': '/flow-lab',
    '/flowlab': '/flow-lab',
    '/flow-lab/': '/flow-lab',
    '/library': '/content',
    '/contents': '/content',
  }
  route = aliasMap[route.toLowerCase()] ?? route

  if ((ASSISTANT_NAVIGABLE_ROUTES as readonly string[]).includes(route)) return route
  if (/^\/presets\/[^/?#]+$/.test(route)) return route
  if (/^\/execute\/[^/?#]+$/.test(route)) return route
  return null
}

function waitForAssistantRoute(targetRoute: string) {
  return new Promise<void>((resolve) => {
    const startedAt = Date.now()
    const timeoutMs = 1500
    const check = () => {
      const currentRoute = window.location.hash.replace(/^#/, '') || '/'
      if (currentRoute === targetRoute || Date.now() - startedAt > timeoutMs) {
        resolve()
        return
      }
      window.setTimeout(check, 50)
    }
    check()
  })
}

function waitForAssistantPresetHydration(presetId: string) {
  return new Promise<VisiblePresetDraft | null>((resolve) => {
    const startedAt = Date.now()
    const timeoutMs = 10_000
    const check = () => {
      const draft = window.acm2AssistantPresetBridge?.getDraft?.() as VisiblePresetDraft | undefined
      const presetName = typeof draft?.presetName === 'string' ? draft.presetName.trim() : ''
      if (draft?.selectedPresetId === presetId && presetName && draft.config) {
        resolve(draft)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(null)
        return
      }
      window.setTimeout(check, 75)
    }
    check()
  })
}

function getRunIdFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const value = record.run_id ?? record.acm_run_id ?? record.current_run_id ?? record.latest_run_id
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

type SanitizedPageContext = ReturnType<typeof sanitizePageContext>
type CacheSummary = ReturnType<typeof getEmptyCacheSummary>
type AssistantActionState = { available: boolean; reason?: string }

function getEmptyCacheSummary() {
  return {
    app_preload_status: 'idle',
    app_preload_error: null as string | null,
    loaded_presets: 0,
    cached_preset_ids: [] as string[],
    loaded_history_rows: 0,
    run_list_loaded_limit: 0,
    latest_run_id: null as string | null,
    cached_run_ids: [] as string[],
    cached_log_run_ids: [] as string[],
    cached_output_run_ids: [] as string[],
  }
}

function getAvailableAssistantActions({
  pageContext,
  cache,
  presetDraftAvailable,
}: {
  pageContext: SanitizedPageContext
  cache: CacheSummary
  presetDraftAvailable: boolean
}) {
  const hasActivePreset = Boolean(pageContext.active_preset_id)
  const hasCurrentRun = Boolean(pageContext.current_run_id)
  const hasLatestRun = Boolean(cache.latest_run_id)
  const hasAnyCachedRun = cache.cached_run_ids.length > 0
  const hasAnyCachedPreset = cache.cached_preset_ids.length > 0

  return {
    read_page_state: { available: true },
    get_route_context: { available: true },
    navigate_to_app_route: {
      available: true,
      reason: 'The assistant can change the visible React hash route for known ACM app routes such as /flow-lab, /execute, /history, /content, /settings, /presets/{id}, and /execute/{runId}.',
    },
    read_content_library: {
      available: true,
      reason: 'The assistant can list, search, and load the logged-in user Content Library through the normal frontend API client from any route.',
    },
    write_content_library: {
      available: true,
      reason: 'The assistant can create, update, and duplicate user-scoped Content Library records; deletion requires explicit intent and an exact name match.',
    },
    import_github_content: {
      available: true,
      reason: 'The assistant can list saved GitHub connections, browse them, and import one selected file through the same frontend workflow as the Content Library page.',
    },
    get_loaded_preset_list: {
      available: true,
      reason: cache.loaded_presets > 0
        ? `Preset list cache already holds ${cache.loaded_presets} item(s).`
        : 'This tool can load preset options from the visible preset page bridge or the browser frontend API.',
    },
    load_preset: hasActivePreset
      ? { available: true, reason: `The current page already identifies preset ${pageContext.active_preset_id}.` }
      : hasAnyCachedPreset
        ? { available: true, reason: 'The assistant already has cached preset ids it can inspect further.' }
        : { available: true, reason: 'This tool can still load a preset if you provide a preset id or name query.' },
    read_visible_preset_draft: presetDraftAvailable
      ? { available: true, reason: 'The visible preset page bridge is mounted.' }
      : unavailable('No visible preset page draft is mounted.'),
    edit_visible_preset_draft: presetDraftAvailable
      ? { available: true, reason: 'The visible preset page bridge is mounted.' }
      : unavailable('Draft editing requires the visible preset page bridge.'),
    save_visible_preset: presetDraftAvailable
      ? { available: true, reason: 'The visible preset page owns a save handler right now.' }
      : unavailable('Saving is only available through the visible preset page workflow.'),
    execute_visible_preset: presetDraftAvailable
      ? { available: true, reason: 'The visible preset page owns an execute handler right now.' }
      : unavailable('Execution is only available through the visible preset page workflow.'),
    get_loaded_history_rows: {
      available: true,
      reason: cache.loaded_history_rows > 0 ? `History cache already holds ${cache.loaded_history_rows} row(s).` : 'This tool can report the current assistant-local history cache, which is empty right now.',
    },
    get_recent_runs: {
      available: true,
      reason: cache.loaded_history_rows > 0
        ? `Recent runs are already loaded app-wide; latest run is ${cache.latest_run_id ?? 'unknown'}.`
        : 'Recent runs can be loaded silently through the frontend API without changing pages.',
    },
    get_latest_run_context: hasLatestRun
      ? { available: true, reason: `Latest run ${cache.latest_run_id} is known from app-wide assistant context.` }
      : { available: true, reason: 'The assistant can silently resolve the latest run through /runs?limit=1 even when no run page is visible.' },
    load_run: hasCurrentRun
      ? { available: true, reason: `The current page already identifies run ${pageContext.current_run_id}.` }
      : hasLatestRun || hasAnyCachedRun
        ? { available: true, reason: `No run is visible, but the assistant can inspect cached/latest run ${cache.latest_run_id ?? cache.cached_run_ids[0]}.` }
        : { available: true, reason: 'No run is visible, but the assistant can silently load the latest or recent runs through the frontend API.' },
    load_run_logs: hasCurrentRun
      ? { available: true, reason: `Logs can be loaded for the current run ${pageContext.current_run_id}.` }
      : hasLatestRun || hasAnyCachedRun
        ? { available: true, reason: `Logs can be loaded for cached/latest run ${cache.latest_run_id ?? cache.cached_run_ids[0]}.` }
        : { available: true, reason: 'Logs can be loaded after silently resolving the latest run through the frontend API.' },
    watch_verbose_run_logs: hasCurrentRun
      ? { available: true, reason: `Verbose EVENT and DETAIL logs can be consumed incrementally for current run ${pageContext.current_run_id}.` }
      : hasLatestRun || hasAnyCachedRun
        ? { available: true, reason: `Verbose logs can be consumed incrementally for cached/latest run ${cache.latest_run_id ?? cache.cached_run_ids[0]}.` }
        : { available: true, reason: 'The assistant can resolve a recent run, then consume its verbose logs in ordered cursor chunks.' },
    load_run_outputs: hasCurrentRun
      ? { available: true, reason: `Outputs can be loaded for the current run ${pageContext.current_run_id}.` }
      : hasLatestRun || hasAnyCachedRun
        ? { available: true, reason: `Outputs can be loaded for cached/latest run ${cache.latest_run_id ?? cache.cached_run_ids[0]}.` }
        : { available: true, reason: 'Outputs can be loaded after silently resolving the latest run through the frontend API.' },
    refresh_current_page_data: hasActivePreset || hasCurrentRun
      ? { available: true, reason: 'The current page identifies assistant-relevant ACM data that can be refreshed.' }
      : { available: true, reason: 'No route-specific object is visible, but assistant app-wide recent-run context can still be refreshed.' },
  }
}

function getSuggestedNextSteps({
  pageContext,
  cache,
  presetDraftAvailable,
}: {
  pageContext: SanitizedPageContext
  cache: CacheSummary
  presetDraftAvailable: boolean
}) {
  const nextSteps: string[] = []

  if (presetDraftAvailable) {
    nextSteps.push('You are on a visible preset page, so draft inspection, editing, saving, and execution are available.')
  } else if (pageContext.active_preset_id) {
    nextSteps.push('A preset is selected, but the visible preset draft bridge is not mounted, so preset mutations are unavailable from here.')
  } else {
    nextSteps.push('Open a preset page if you want the assistant to inspect or edit a visible preset draft.')
  }

  if (pageContext.current_run_id) {
    nextSteps.push('A run is already selected, so run summary, log, and output inspection can start from the current page.')
  } else if (cache.latest_run_id) {
    nextSteps.push(`No run page is visible, but the assistant already knows latest run ${cache.latest_run_id} and can inspect it without navigation.`)
  } else if (cache.cached_run_ids.length > 0) {
    nextSteps.push('The assistant already has cached run ids, so we can inspect one of those without changing pages.')
  } else {
    nextSteps.push('No run page is visible, but the assistant can silently load recent/latest runs before answering execution questions.')
  }

  return nextSteps
}

function unavailable(reason: string): AssistantActionState {
  return { available: false, reason }
}

function getNewestCachedRunId(cache: AssistantCache) {
  return Object.values(cache.runsById)
    .sort((a, b) => getRunSortTime(b) - getRunSortTime(a))[0]?.id
}

function getRunSortTime(run: Run) {
  return Date.parse(run.completed_at ?? run.started_at ?? run.created_at ?? '') || 0
}

function runGeneratedDocumentCount(run: Run) {
  const loadedCount = run.generated_docs?.length ?? 0
  return loadedCount > 0 ? loadedCount : Math.max(0, run.generated_document_count ?? 0)
}

function buildRunListItem(run: Run) {
  return {
    id: run.id,
    title: run.title,
    name: run.name ?? null,
    status: run.status,
    preset_id: run.preset_id ?? null,
    created_at: run.created_at,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    generated_document_count: runGeneratedDocumentCount(run),
    progress: run.progress,
  }
}

function clampAssistantOutputDocumentLimit(value: number) {
  if (!Number.isFinite(value)) return 5
  return Math.min(10, Math.max(1, Math.trunc(value)))
}

async function preloadRunOutputs(cache: AssistantCache, run: Run, maxDocuments: number) {
  const effectiveMaxDocuments = clampAssistantOutputDocumentLimit(maxDocuments)
  const cached = cache.outputsByRunId[run.id]
  if (cached && cached.maxDocuments >= effectiveMaxDocuments) {
    return cached.outputs.slice(0, effectiveMaxDocuments)
  }

  const docs = (run.generated_docs ?? []).slice(0, effectiveMaxDocuments)
  const outputs: unknown[] = []
  for (const doc of docs) {
    outputs.push(await runsApi.getGeneratedDocumentContent(run.id, doc.id))
  }
  cache.outputsByRunId[run.id] = { maxDocuments: effectiveMaxDocuments, outputs }
  return outputs
}

function buildPresetSummaryResult(preset: PresetResponse) {
  const enabledEngines = getPresetEnabledEngines(preset)
  const reportModes = getPresetReportModes(preset, enabledEngines)
  const selectedModels = getPresetSelectedModels(preset)
  const searchProvider = getPresetSearchProvider(preset)

  return {
    status: 'loaded',
    preset_id: preset.id,
    name: preset.name,
    description: preset.description ?? '',
    summary: {
      report_modes: reportModes,
      enabled_engines: enabledEngines,
      selected_models: selectedModels,
      document_count: Array.isArray(preset.documents) ? preset.documents.length : 0,
      generation_instructions_attached: Boolean(preset.generation_instructions_id),
      eval_instructions_attached: Boolean(preset.single_eval_instructions_id || preset.pairwise_eval_instructions_id),
      combine_instructions_attached: Boolean(preset.combine_instructions_id),
      active_search_provider: searchProvider,
    },
    notes: [
      'This is a high-level summary only.',
      'Use deeper tools to inspect runnability, blockers, or detailed configuration.',
    ],
    interpretation_notes: [
      'Instruction attachment booleans mean an asset id appears selected; they do not prove instruction quality.',
      'Selected models and enabled engines describe configuration shape; they do not prove the preset can run.',
    ],
  }
}

function buildVisiblePresetRequirementsResult(draft: unknown, fallbackPresetId?: string | null) {
  const visibleDraft = draft as VisiblePresetDraft
  const config = visibleDraft.config
  if (!config) {
    return {
      status: 'indeterminate',
      message: 'Preset requirements could not be determined from the currently available frontend data.',
      missing_checks: ['config'],
    }
  }

  const generationModelCount = getDraftGenerationModelCount(config)
  const hasModels = generationModelCount > 0
  const githubInputPaths = visibleDraft.githubInputPaths ?? []
  const hasDocuments =
    (visibleDraft.selectedInputDocIds?.length ?? 0) > 0 ||
    (visibleDraft.inputSourceType === 'github' && githubInputPaths.some((path) => path.trim().length > 0))
  const generationInstructionsRequired = getDraftGenerationInstructionsRequired(visibleDraft)
  const singleEvalInstructionsRequired = (config.eval.judgeModels?.length ?? 0) > 0
  const pairwiseEvalInstructionsRequired = Boolean(config.eval.enablePairwise && generationModelCount >= 2)
  const evalInstructionsRequired = singleEvalInstructionsRequired || pairwiseEvalInstructionsRequired
  const evalInstructionsPresent =
    (!singleEvalInstructionsRequired || Boolean(config.eval.singleEvalInstructionsId)) &&
    (!pairwiseEvalInstructionsRequired || Boolean(config.eval.pairwiseEvalInstructionsId))

  return buildPresetRequirementsResult({
    presetId: visibleDraft.selectedPresetId ?? fallbackPresetId ?? null,
    source: 'visible_preset_draft',
    requirements: {
      models_required: true,
      models_present: hasModels,
      documents_required: true,
      documents_present: hasDocuments,
      generation_instructions_required: generationInstructionsRequired,
      generation_instructions_present: Boolean(visibleDraft.selectedInstructionId),
      eval_instructions_required: evalInstructionsRequired,
      eval_instructions_present: evalInstructionsPresent,
    },
    detail: {
      single_eval_instructions_required: singleEvalInstructionsRequired,
      single_eval_instructions_present: Boolean(config.eval.singleEvalInstructionsId),
      pairwise_eval_instructions_required: pairwiseEvalInstructionsRequired,
      pairwise_eval_instructions_present: Boolean(config.eval.pairwiseEvalInstructionsId),
      source_prompt_mode_enabled: Boolean(visibleDraft.sourcePromptModeEnabled),
      input_source_type: visibleDraft.inputSourceType === 'github' ? 'github' : 'database',
    },
  })
}

function buildSavedPresetRequirementsResult(preset: PresetResponse) {
  const generationModelCount = getPresetGenerationModelCount(preset)
  const hasModels = generationModelCount > 0
  const hasDocuments =
    (preset.documents?.length ?? 0) > 0 ||
    (preset.input_source_type === 'github' && (preset.github_input_paths ?? []).some((path) => path.trim().length > 0))
  const generationInstructionsRequired = getSavedPresetGenerationInstructionsRequired(preset)
  const singleEvalInstructionsRequired = (preset.eval_config?.judge_models?.length ?? 0) > 0
  const pairwiseEvalInstructionsRequired = Boolean(preset.pairwise_config?.enabled && generationModelCount >= 2)
  const evalInstructionsRequired = singleEvalInstructionsRequired || pairwiseEvalInstructionsRequired
  const evalInstructionsPresent =
    (!singleEvalInstructionsRequired || Boolean(preset.single_eval_instructions_id)) &&
    (!pairwiseEvalInstructionsRequired || Boolean(preset.pairwise_eval_instructions_id))

  return buildPresetRequirementsResult({
    presetId: preset.id,
    source: 'saved_preset',
    requirements: {
      models_required: true,
      models_present: hasModels,
      documents_required: true,
      documents_present: hasDocuments,
      generation_instructions_required: generationInstructionsRequired,
      generation_instructions_present: Boolean(preset.generation_instructions_id),
      eval_instructions_required: evalInstructionsRequired,
      eval_instructions_present: evalInstructionsPresent,
    },
    detail: {
      single_eval_instructions_required: singleEvalInstructionsRequired,
      single_eval_instructions_present: Boolean(preset.single_eval_instructions_id),
      pairwise_eval_instructions_required: pairwiseEvalInstructionsRequired,
      pairwise_eval_instructions_present: Boolean(preset.pairwise_eval_instructions_id),
      source_prompt_mode_enabled: Boolean(preset.source_prompt_mode_enabled),
      input_source_type: preset.input_source_type === 'github' ? 'github' : 'database',
    },
  })
}

function buildPresetRequirementsResult({
  presetId,
  source,
  requirements,
  detail,
}: {
  presetId: string | null
  source: 'visible_preset_draft' | 'saved_preset'
  requirements: {
    models_required: boolean
    models_present: boolean
    documents_required: boolean
    documents_present: boolean
    generation_instructions_required: boolean
    generation_instructions_present: boolean
    eval_instructions_required: boolean
    eval_instructions_present: boolean
  }
  detail: {
    single_eval_instructions_required: boolean
    single_eval_instructions_present: boolean
    pairwise_eval_instructions_required: boolean
    pairwise_eval_instructions_present: boolean
    source_prompt_mode_enabled: boolean
    input_source_type: 'database' | 'github'
  }
}) {
  const missingRequirementCategories = [
    requirements.models_required && !requirements.models_present ? 'models' : null,
    requirements.documents_required && !requirements.documents_present ? 'documents' : null,
    requirements.generation_instructions_required && !requirements.generation_instructions_present ? 'generation_instructions' : null,
    requirements.eval_instructions_required && !requirements.eval_instructions_present ? 'eval_instructions' : null,
  ].filter((value): value is string => typeof value === 'string')

  return {
    status: 'loaded',
    preset_id: presetId,
    source,
    requirements,
    missing_requirement_categories: missingRequirementCategories,
    detail,
    interpretation_notes: [
      'Missing requirement categories identify absent pieces, not semantic quality problems.',
      'Use runnability results to decide whether missing pieces currently block execution.',
    ],
  }
}

function buildVisiblePresetModelsResult(draft: unknown, fallbackPresetId?: string | null) {
  const visibleDraft = draft as VisiblePresetDraft
  const config = visibleDraft.config
  if (!config) {
    return {
      status: 'indeterminate',
      message: 'Preset model selections could not be determined from the currently available frontend data.',
      missing_checks: ['config'],
    }
  }

  const byEngine = normalizeModelBucketRecord({
    fpf: config.fpf.selectedModels,
    gptr: config.gptr.selectedModels,
    dr: config.dr.selectedModels,
    msagent: config.msagent.selectedModels,
    aiq: config.aiq.selectedModels,
    owl: config.owl.selectedModels,
    translation_agent: config.translationAgent.selectedModels,
    marian: config.marian.selectedModels,
    pdfmathtranslate: config.pdfMathTranslate.selectedModels,
    eval: config.eval.judgeModels,
    combine: config.combine.selectedModels,
  })

  return buildPresetModelsResult({
    presetId: visibleDraft.selectedPresetId ?? fallbackPresetId ?? null,
    source: 'visible_preset_draft',
    byEngine,
  })
}

function buildSavedPresetModelsResult(preset: PresetResponse) {
  const byEngine = normalizeModelBucketRecord({
    fpf: preset.fpf_config?.selected_models,
    gptr: preset.gptr_config?.selected_models,
    dr: preset.dr_config?.selected_models,
    msagent: preset.msagent_config?.selected_models,
    aiq: preset.aiq_config?.selected_models,
    owl: preset.owl_config?.selected_models,
    translation_agent: preset.translation_agent_config?.selected_models,
    marian: preset.marian_config?.selected_models,
    pdfmathtranslate: preset.pdfmathtranslate_config?.selected_models,
    eval: preset.eval_config?.judge_models,
    combine: preset.combine_config?.selected_models,
  })

  return buildPresetModelsResult({
    presetId: preset.id,
    source: 'saved_preset',
    byEngine,
  })
}

function buildPresetModelsResult({
  presetId,
  source,
  byEngine,
}: {
  presetId: string | null
  source: 'visible_preset_draft' | 'saved_preset'
  byEngine: Record<string, string[]>
}) {
  const selectedModels = uniqueStrings(Object.values(byEngine).flat())
  return {
    status: 'loaded',
    preset_id: presetId,
    source,
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

function buildVisiblePresetDocumentsResult(
  draft: unknown,
  fallbackPresetId: string | null | undefined,
  includeDocumentNames: boolean,
) {
  const visibleDraft = draft as VisiblePresetDraft
  const selectedInputDocIds = visibleDraft.selectedInputDocIds ?? []
  const selectedInputDocuments = visibleDraft.selectedInputDocuments ?? []
  const documentNameById = new Map(
    selectedInputDocuments.map((document) => [document.id, document.name?.trim() || document.id] as const),
  )

  const items = selectedInputDocIds.map((id) => ({
    id,
    name: includeDocumentNames ? (documentNameById.get(id) ?? id) : id,
  }))

  return {
    status: 'loaded',
    preset_id: visibleDraft.selectedPresetId ?? fallbackPresetId ?? null,
    source: 'visible_preset_draft',
    documents: {
      document_count: items.length,
      items,
    },
    interpretation_notes: [
      'Document attachment means source material appears selected; it does not prove the document content is relevant or sufficient.',
    ],
  }
}

function buildSavedPresetDocumentsResult(
  preset: PresetResponse,
  contentItems: ContentSummary[],
  includeDocumentNames: boolean,
) {
  const documentNameById = new Map(contentItems.map((document) => [document.id, document.name] as const))
  const documentIds = Array.isArray(preset.documents) ? preset.documents : []
  const items = documentIds.map((id) => ({
    id,
    name: includeDocumentNames ? (documentNameById.get(id) ?? id) : id,
  }))

  return {
    status: 'loaded',
    preset_id: preset.id,
    source: 'saved_preset',
    documents: {
      document_count: items.length,
      items,
    },
    interpretation_notes: [
      'Document attachment means source material appears selected; it does not prove the document content is relevant or sufficient.',
    ],
  }
}

function buildVisiblePresetInstructionsResult(
  draft: unknown,
  fallbackPresetId: string | null | undefined,
  contentItems: ContentSummary[],
  includeTitles: boolean,
) {
  const visibleDraft = draft as VisiblePresetDraft
  const instructionIds = getVisibleDraftInstructionIds(visibleDraft)
  return buildPresetInstructionsResult({
    presetId: visibleDraft.selectedPresetId ?? fallbackPresetId ?? null,
    source: 'visible_preset_draft',
    instructionIds,
    contentItems,
    includeTitles,
  })
}

function buildSavedPresetInstructionsResult(
  preset: PresetResponse,
  contentItems: ContentSummary[],
  includeTitles: boolean,
) {
  return buildPresetInstructionsResult({
    presetId: preset.id,
    source: 'saved_preset',
    instructionIds: getSavedPresetInstructionIds(preset),
    contentItems,
    includeTitles,
  })
}

function buildPresetInstructionsResult({
  presetId,
  source,
  instructionIds,
  contentItems,
  includeTitles,
}: {
  presetId: string | null
  source: 'visible_preset_draft' | 'saved_preset'
  instructionIds: {
    generation: string | null
    single_eval: string | null
    pairwise_eval: string | null
    combine: string | null
  }
  contentItems: ContentSummary[]
  includeTitles: boolean
}) {
  const titleById = new Map(contentItems.map((item) => [item.id, item.name] as const))

  const buildInstructionAttachment = (id: string | null) => (
    id
      ? {
          attached: true,
          id,
          ...(includeTitles ? { title: titleById.get(id) ?? id } : {}),
        }
      : { attached: false }
  )

  return {
    status: 'loaded',
    preset_id: presetId,
    source,
    instructions: {
      generation: buildInstructionAttachment(instructionIds.generation),
      single_eval: buildInstructionAttachment(instructionIds.single_eval),
      pairwise_eval: buildInstructionAttachment(instructionIds.pairwise_eval),
      combine: buildInstructionAttachment(instructionIds.combine),
    },
    interpretation_notes: [
      'Instruction attachment means an instruction asset appears selected; it does not prove the prompt content is correct or complete.',
    ],
  }
}

function getPresetEnabledEngines(preset: PresetResponse): string[] {
  const engineConfigs: Array<[string, { enabled?: boolean; selected_models?: string[] } | undefined]> = [
    ['fpf', preset.fpf_config],
    ['gptr', preset.gptr_config],
    ['dr', preset.dr_config],
    ['msagent', preset.msagent_config],
    ['aiq', preset.aiq_config],
    ['owl', preset.owl_config],
    ['translation_agent', preset.translation_agent_config],
    ['marian', preset.marian_config],
    ['pdfmathtranslate', preset.pdfmathtranslate_config],
  ]

  return engineConfigs
    .filter(([, config]) => Boolean(config?.enabled) || Boolean(config?.selected_models?.length))
    .map(([engine]) => engine)
}

function getPresetReportModes(preset: PresetResponse, enabledEngines: string[]) {
  const reportModes = new Set<string>()

  if (preset.gptr_config?.report_type) reportModes.add(`gptr:${preset.gptr_config.report_type}`)
  if (preset.input_source_type) reportModes.add(`input:${preset.input_source_type}`)
  enabledEngines.forEach((engine) => reportModes.add(engine))

  return Array.from(reportModes)
}

function getPresetSelectedModels(preset: PresetResponse): string[] {
  return uniqueStrings(Object.values(getPresetModelBuckets(preset)).flat())
}

function getPresetSearchProvider(preset: PresetResponse) {
  const msagentConfig = preset.msagent_config as { retriever?: string } | undefined
  return (
    preset.aiq_config?.search_provider ??
    preset.aiq_config?.run_search_provider ??
    preset.dr_config?.search_provider ??
    preset.dr_config?.run_search_provider ??
    preset.gptr_config?.search_provider ??
    msagentConfig?.retriever ??
    null
  )
}

function getPresetModelBuckets(preset: PresetResponse) {
  return normalizeModelBucketRecord({
    fpf: preset.fpf_config?.selected_models,
    gptr: preset.gptr_config?.selected_models,
    dr: preset.dr_config?.selected_models,
    msagent: preset.msagent_config?.selected_models,
    aiq: preset.aiq_config?.selected_models,
    owl: preset.owl_config?.selected_models,
    translation_agent: preset.translation_agent_config?.selected_models,
    marian: preset.marian_config?.selected_models,
    pdfmathtranslate: preset.pdfmathtranslate_config?.selected_models,
    eval: preset.eval_config?.judge_models,
    combine: preset.combine_config?.selected_models,
  })
}

function normalizeModelBucketRecord(record: Record<string, string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, values]) => [key, uniqueStrings(values ?? [])] as const)
      .filter(([, values]) => values.length > 0),
  )
}

async function loadContentSummariesByIds(cache: AssistantCache, ids: string[]) {
  const uniqueIds = uniqueStrings(ids)
  const missingIds = uniqueIds.filter((id) => !cache.contentSummariesById[id])

  if (missingIds.length > 0) {
    const loadedItems = await Promise.all(missingIds.map((id) => contentsApi.get(id)))
    for (const item of loadedItems) {
      cache.contentSummariesById[item.id] = {
        id: item.id,
        name: item.name,
        content_type: item.content_type,
        description: item.description,
        folder_path: item.folder_path,
        tags: item.tags,
        body_preview: '',
        created_at: item.created_at,
        updated_at: item.updated_at,
      }
    }
  }

  return uniqueIds
    .map((id) => cache.contentSummariesById[id])
    .filter((item): item is ContentSummary => Boolean(item))
}

function getVisibleDraftInstructionIds(draft: unknown) {
  const visibleDraft = draft as VisiblePresetDraft
  const config = visibleDraft.config

  return {
    generation: visibleDraft.selectedInstructionId ?? null,
    single_eval: config?.eval.singleEvalInstructionsId ?? null,
    pairwise_eval: config?.eval.pairwiseEvalInstructionsId ?? null,
    combine: config?.combine.combineInstructionsId ?? null,
  }
}

function getSavedPresetInstructionIds(preset: PresetResponse) {
  return {
    generation: preset.generation_instructions_id ?? null,
    single_eval: preset.single_eval_instructions_id ?? null,
    pairwise_eval: preset.pairwise_eval_instructions_id ?? null,
    combine: preset.combine_instructions_id ?? null,
  }
}

function getPresetEngineDraftSectionPath(engine: 'fpf' | 'gptr' | 'dr' | 'msagent' | 'aiq' | 'owl' | 'translation_agent' | 'marian' | 'pdfmathtranslate') {
  switch (engine) {
    case 'translation_agent':
      return 'translationAgent'
    case 'pdfmathtranslate':
      return 'pdfMathTranslate'
    default:
      return engine
  }
}

type PresetModelSection =
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

function buildRequestedGenerationModelsBySection(draft: VisiblePresetDraft, requestedModels: string[]) {
  const supportedSections: PresetModelSection[] = [
    'fpf',
    'gptr',
    'dr',
    'msagent',
    'aiq',
    'owl',
    'translation_agent',
    'marian',
    'pdfmathtranslate',
    'eval',
    'combine',
  ]
  const result = Object.fromEntries(
    supportedSections.map((section) => [section, [] as string[]]),
  ) as Record<PresetModelSection, string[]>
  const eligibleModelSections = draft.eligibleModelSections ?? {}

  for (const model of uniqueStrings(requestedModels)) {
    const sections = eligibleModelSections[model] ?? []
    for (const section of sections) {
      if (!supportedSections.includes(section as PresetModelSection)) continue
      result[section as PresetModelSection].push(model)
    }
  }

  return result
}

function getDraftGenerationInstructionsRequired(draft: VisiblePresetDraft) {
  const config = draft.config
  if (!config) return false

  const hasInstructionRequiredGenerator =
    config.fpf.selectedModels.length > 0 ||
    config.gptr.selectedModels.length > 0 ||
    config.dr.selectedModels.length > 0 ||
    config.msagent.selectedModels.length > 0 ||
    config.aiq.selectedModels.length > 0 ||
    config.owl.selectedModels.length > 0

  return hasInstructionRequiredGenerator && !draft.sourcePromptModeEnabled
}

function getSavedPresetGenerationInstructionsRequired(preset: PresetResponse) {
  const hasInstructionRequiredGenerator =
    (preset.fpf_config?.selected_models?.length ?? 0) > 0 ||
    (preset.gptr_config?.selected_models?.length ?? 0) > 0 ||
    (preset.dr_config?.selected_models?.length ?? 0) > 0 ||
    (preset.msagent_config?.selected_models?.length ?? 0) > 0 ||
    (preset.aiq_config?.selected_models?.length ?? 0) > 0 ||
    (preset.owl_config?.selected_models?.length ?? 0) > 0

  return hasInstructionRequiredGenerator && !preset.source_prompt_mode_enabled
}

type VisiblePresetDraft = {
  selectedPresetId?: string | null
  presetName?: string
  eligibleModelSections?: Record<string, string[]>
  selectedInputDocIds?: string[]
  selectedInputDocuments?: Array<{ id: string; name?: string | null }>
  selectedInstructionId?: string | null
  inputSourceType?: 'database' | 'github'
  githubConnectionId?: string | null
  githubInputPaths?: string[]
  sourcePromptModeEnabled?: boolean
  config?: ConfigStore
}

function evaluateVisiblePresetDraftRunnability(draft: unknown, fallbackPresetId?: string | null) {
  const visibleDraft = draft as VisiblePresetDraft
  const config = visibleDraft.config
  if (!config) {
    return {
      status: 'indeterminate',
      message: 'Preset runnability could not be determined from the currently available frontend data.',
      missing_checks: ['config'],
    }
  }

  const generationModelCount = getDraftGenerationModelCount(config)
  const hasGenerationModels = generationModelCount > 0
  const hasDocuments = Array.isArray(visibleDraft.selectedInputDocIds) && visibleDraft.selectedInputDocIds.length > 0
  const githubConfig: GitHubInputConfig = {
    inputSourceType: visibleDraft.inputSourceType === 'github' ? 'github' : 'database',
    githubConnectionId: visibleDraft.githubConnectionId ?? null,
    githubInputPaths: visibleDraft.githubInputPaths ?? [],
    githubOutputPath: null,
    sourcePromptModeEnabled: Boolean(visibleDraft.sourcePromptModeEnabled),
  }

  const promptSourceValidation = getPromptSourceValidationMessage(
    config,
    visibleDraft.selectedInputDocIds ?? [],
    visibleDraft.selectedInstructionId ?? null,
    githubConfig,
  )

  const blockingReasons: string[] = []
  const warnings: string[] = []

  if (!hasGenerationModels) {
    blockingReasons.push('No generation models are selected.')
  }
  if (promptSourceValidation) {
    blockingReasons.push(promptSourceValidation)
  }
  if ((config.eval.judgeModels?.length ?? 0) > 0 && !config.eval.singleEvalInstructionsId) {
    blockingReasons.push('No single-eval instructions are selected.')
  }
  if (config.eval.enablePairwise && generationModelCount >= 2 && !config.eval.pairwiseEvalInstructionsId) {
    blockingReasons.push('Pairwise comparison is enabled, but no pairwise-eval instructions are selected.')
  }
  if (!hasDocuments && githubConfig.inputSourceType !== 'github') {
    warnings.push('No input documents are selected in the visible draft.')
  }
  if (config.combine.selectedModels.length > 0 && !config.combine.combineInstructionsId) {
    warnings.push('Combine models are selected, but no combine instructions are attached.')
  }

  return {
    status: 'evaluated',
    subject: {
      preset_id: visibleDraft.selectedPresetId ?? fallbackPresetId ?? null,
      source: 'visible_preset_draft',
    },
    runnable: blockingReasons.length === 0,
    blocking_reasons: blockingReasons,
    warnings,
    checks: {
      has_models: hasGenerationModels,
      has_generation_instructions: Boolean(visibleDraft.selectedInstructionId),
      has_documents: hasDocuments || githubConfig.githubInputPaths.length > 0,
      has_visible_page_bridge: true,
    },
    notes: [
      'Blocking reasons prevent execution.',
      'Warnings do not prevent execution by themselves.',
    ],
  }
}

function evaluateSavedPresetRunnability(preset: PresetResponse) {
  const generationModelCount = getPresetGenerationModelCount(preset)
  const blockingReasons = Array.isArray(preset.validation_errors) ? [...preset.validation_errors] : []
  const warnings: string[] = []

  if (!preset.runnable && blockingReasons.length === 0) {
    blockingReasons.push('The saved preset is marked not runnable, but no detailed validation errors were returned.')
  }
  if ((preset.documents?.length ?? 0) === 0 && preset.input_source_type !== 'github') {
    warnings.push('No input documents are attached in the saved preset.')
  }
  if (preset.combine_config?.selected_models?.length && !preset.combine_instructions_id) {
    warnings.push('Combine models are selected, but no combine instructions are attached.')
  }

  return {
    status: 'evaluated',
    subject: {
      preset_id: preset.id,
      source: 'saved_preset',
    },
    runnable: blockingReasons.length === 0 && Boolean(preset.runnable),
    blocking_reasons: blockingReasons,
    warnings,
    checks: {
      has_models: generationModelCount > 0,
      has_generation_instructions: Boolean(preset.generation_instructions_id),
      has_documents: (preset.documents?.length ?? 0) > 0 || preset.input_source_type === 'github',
      has_visible_page_bridge: Boolean(window.acm2AssistantPresetBridge),
    },
    notes: [
      'Blocking reasons prevent execution.',
      'Warnings do not prevent execution by themselves.',
    ],
  }
}

function getDraftGenerationModelCount(config: ConfigStore) {
  return (
    config.fpf.selectedModels.length +
    config.gptr.selectedModels.length +
    config.dr.selectedModels.length +
    config.msagent.selectedModels.length +
    config.aiq.selectedModels.length +
    config.owl.selectedModels.length +
    config.translationAgent.selectedModels.length +
    config.marian.selectedModels.length +
    config.pdfMathTranslate.selectedModels.length
  )
}

function getPresetGenerationModelCount(preset: PresetResponse) {
  return (
    (preset.fpf_config?.selected_models?.length ?? 0) +
    (preset.gptr_config?.selected_models?.length ?? 0) +
    (preset.dr_config?.selected_models?.length ?? 0) +
    (preset.msagent_config?.selected_models?.length ?? 0) +
    (preset.aiq_config?.selected_models?.length ?? 0) +
    (preset.owl_config?.selected_models?.length ?? 0) +
    (preset.translation_agent_config?.selected_models?.length ?? 0) +
    (preset.marian_config?.selected_models?.length ?? 0) +
    (preset.pdfmathtranslate_config?.selected_models?.length ?? 0)
  )
}

function buildRunStatusSummaryResult(run: Run) {
  const generatedDocumentCount = runGeneratedDocumentCount(run)
  const outputsAvailable = generatedDocumentCount > 0
  const finished = isTerminalRunStatus(run.status)
  const researchCompleted = getRunResearchCompleted(run)

  return {
    status: 'loaded',
    run_id: run.id,
    summary: {
      state: run.status,
      finished,
      research_completed: researchCompleted,
      outputs_available: outputsAvailable,
      generated_document_count: generatedDocumentCount,
      started_at: run.started_at ?? null,
      updated_at: run.completed_at ?? run.started_at ?? run.created_at,
    },
    notes: [
      'This is a high-level run summary only.',
      'Use log and failure tools for deeper diagnosis.',
    ],
  }
}

function buildRunCostSummaryResult(run: Run) {
  const cost = run.cost_summary
  const totalCost = cost?.total_cost_usd ?? run.total_cost_usd ?? null

  return {
    status: 'loaded',
    run_id: run.id,
    summary: {
      total_cost_usd: typeof totalCost === 'number' && Number.isFinite(totalCost) ? totalCost : null,
      generation_cost_usd: cost?.generation_cost_usd ?? null,
      evaluation_cost_usd: cost?.eval_cost_usd ?? null,
      tool_cost_usd: cost?.tool_cost_usd ?? null,
      pricing_incomplete: Boolean(cost?.incomplete),
      known_cost_event_count: cost?.known_cost_event_count ?? null,
      unknown_cost_event_count: cost?.unknown_cost_event_count ?? null,
      total_input_tokens: cost?.total_input_tokens ?? null,
      total_output_tokens: cost?.total_output_tokens ?? null,
      total_reasoning_tokens: cost?.total_reasoning_tokens ?? null,
    },
    notes: [
      'A zero or null total is not proof that a run was free when pricing_incomplete is true.',
      'This summary never returns provider keys, request headers, or raw billing payloads.',
    ],
  }
}

function mergeAssistantRunLiveSummary(detail: Run, summary: RunLiveSummary): Run {
  const hasSourceDocResults = Boolean(summary.source_doc_results && Object.keys(summary.source_doc_results).length > 0)
  const sourceDocResults = hasSourceDocResults
    ? {
        ...(detail.source_doc_results ?? {}),
        ...summary.source_doc_results,
      } as Run['source_doc_results']
    : detail.source_doc_results

  return {
    ...detail,
    status: summary.status ?? detail.status,
    progress: summary.progress ?? detail.progress,
    started_at: summary.started_at ?? detail.started_at,
    completed_at: summary.completed_at ?? detail.completed_at,
    total_cost_usd: summary.total_cost_usd ?? detail.total_cost_usd,
    cost_summary: Object.prototype.hasOwnProperty.call(summary, 'cost_summary')
      ? summary.cost_summary
      : detail.cost_summary,
    error_message: summary.error_message ?? detail.error_message,
    pause_requested: summary.pause_requested ?? detail.pause_requested,
    resume_count: summary.resume_count ?? detail.resume_count,
    fpf_stats: summary.fpf_stats ?? detail.fpf_stats,
    openrouter_fpf_status: summary.openrouter_fpf_status ?? detail.openrouter_fpf_status,
    optimization_summary: summary.optimization_summary ?? detail.optimization_summary,
    ...(hasSourceDocResults ? { source_doc_results: sourceDocResults } : {}),
  }
}

function isTerminalRunStatus(status: Run['status']) {
  return ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status)
}

function getRunResearchCompleted(run: Run) {
  if (typeof run.openrouter_fpf_status?.research_completed === 'boolean') {
    return run.openrouter_fpf_status.research_completed
  }
  if (run.status === 'completed' || run.status === 'completed_with_errors') {
    return true
  }
  return false
}

async function loadAssistantRunLogs(runId: string, classification: 'event' | 'all') {
  const response = await apiClient.get<AssistantLogResponse>(`/runs/${resourceId(runId)}/logs`, {
    classification,
    limit: 200,
  })
  return normalizeAssistantLogs(response)
}

function normalizeAssistantLogs(logs: AssistantLogResponse | unknown): AssistantLogResponse {
  if (!logs || typeof logs !== 'object') {
    return { entries: [] }
  }

  const candidate = logs as { entries?: unknown }
  return {
    ...(logs as Record<string, unknown>),
    entries: Array.isArray(candidate.entries) ? candidate.entries as AssistantLogEntry[] : [],
  }
}

function buildRunFailureSignalsResult(run: Run, logs: AssistantLogResponse) {
  const evidence: Array<{ kind: string; message: string }> = []
  const topErrors: string[] = []
  const warnings: string[] = []
  const artifactEvidence = extractRunArtifactEvidence(logs.entries)
  const outputVisibilityContradiction =
    (run.generated_docs?.length ?? 0) === 0 &&
    isTerminalRunStatus(run.status) &&
    artifactEvidenceSuggestsGeneratedArtifacts(artifactEvidence)

  if (run.status === 'failed') {
    evidence.push({ kind: 'run_state', message: 'Run finished in failed state.' })
    topErrors.push('The run finished in a failed state.')
  } else if (run.status === 'completed_with_errors') {
    evidence.push({ kind: 'run_state', message: 'Run completed with errors.' })
    warnings.push('The run completed with errors.')
  }

  if (run.error_message) {
    const redactedRunError = redactAssistantLogText(run.error_message)
    evidence.push({ kind: 'run_error', message: redactedRunError })
    topErrors.push(redactedRunError)
  }

  if ((run.generated_docs?.length ?? 0) === 0 && ['failed', 'completed_with_errors'].includes(run.status)) {
    evidence.push({ kind: 'outputs', message: 'No generated documents were produced.' })
    topErrors.push('No generated documents were produced.')
  }

  if (outputVisibilityContradiction) {
    evidence.push({
      kind: 'output_visibility',
      message: 'Run logs indicate generated artifacts were saved, but zero generated documents are visible through the output API.',
    })
    warnings.push('Completed or terminal run has generated-artifact log evidence but no visible output documents.')
  }

  if (getRunResearchCompleted(run) === false && ['failed', 'completed_with_errors'].includes(run.status)) {
    warnings.push('Research phase did not complete.')
  }

  const logSignals = extractLogSignals(logs.entries)
  for (const signal of logSignals.errors) {
    topErrors.push(signal.message)
    evidence.push({ kind: 'log_event', message: signal.message })
  }
  for (const signal of logSignals.warnings) {
    warnings.push(signal.message)
  }

  const dedupedErrors = uniqueStrings(topErrors).slice(0, 5)
  const dedupedWarnings = uniqueStrings(warnings).slice(0, 5)
  const dedupedEvidence = uniqueEvidence(evidence).slice(0, 8)
  const nextSteps = outputVisibilityContradiction
    ? uniqueStrings([
        'Verify the output listing, attachment, or visibility path for this run before calling it successful.',
        'Use output-summary or output-loading tools to confirm whether generated documents are retrievable.',
        ...getFailureNextSteps(dedupedErrors, dedupedWarnings),
      ])
    : getFailureNextSteps(dedupedErrors, dedupedWarnings)

  return {
    status: 'loaded',
    run_id: run.id,
    signals: {
      severity: getFailureSeverity(run.status, dedupedErrors.length, dedupedWarnings.length),
      top_errors: dedupedErrors,
      warnings: dedupedWarnings,
      evidence: dedupedEvidence,
    },
    artifact_evidence_from_logs: outputVisibilityContradiction ? artifactEvidence : undefined,
    output_visibility_contradiction: outputVisibilityContradiction
      ? {
          detected: true,
          message: 'Run logs indicate generated artifacts were saved, but the run output API returned zero visible generated documents.',
          safe_interpretation: 'Treat this as completed with no visible outputs until the output listing/indexing/visibility path is verified.',
          avoid: [
            'Do not claim the run produced no work.',
            'Do not invent backend table names, SQL, queue names, or service internals.',
          ],
        }
      : { detected: false },
    next_steps: nextSteps,
    interpretation_notes: [
      'Failure signals are visible evidence from run state and logs, not a complete backend root-cause proof.',
      'Sparse or missing logs should be explained as limited evidence.',
      'When output_visibility_contradiction.detected is true, report it as an anomaly even if severity would otherwise be low.',
    ],
  }
}

function buildRunLogLoadResult(
  run: Run,
  resolvedRun: unknown,
  classification: 'event' | 'all',
  requestedLimit: number,
  logs: AssistantLogResponse,
) {
  const entries = logs.entries
  const logSignals = extractStructuredLogSignals(entries)
  const artifactEvidence = extractRunArtifactEvidence(entries)
  const sampledEntries = buildAssistantLogSamples(entries, logSignals)
  const queueOrWorkerSamples = buildQueueOrWorkerLogSamples(entries)

  return {
    status: 'loaded',
    run_id: run.id,
    resolved_run: resolvedRun,
    classification,
    log_window: {
      requested_limit: requestedLimit,
      response_limit: logs.limit ?? null,
      response_offset: logs.offset ?? null,
      response_total: logs.total ?? null,
      returned_entries: entries.length,
      raw_entries_omitted_from_assistant_payload: true,
    },
    run_summary: {
      state: run.status,
      finished: isTerminalRunStatus(run.status),
      generated_document_count: runGeneratedDocumentCount(run),
      started_at: run.started_at ?? null,
      updated_at: run.completed_at ?? run.started_at ?? run.created_at,
    },
    summary: {
      level_counts: countLogField(entries, 'level'),
      event_type_counts: countLogField(entries, 'event_type'),
      source_counts: countLogField(entries, 'source'),
    },
    concrete_failure_evidence: logSignals.errors.slice(0, 8),
    warnings: logSignals.warnings.slice(0, 8),
    notable_events: logSignals.notable.slice(0, 8),
    queue_or_worker_samples: queueOrWorkerSamples,
    artifact_evidence_from_logs: artifactEvidenceSuggestsGeneratedArtifacts(artifactEvidence) ? artifactEvidence : undefined,
    sampled_entries: sampledEntries,
    interpretation_notes: [
      'This tool returns a compact evidence summary, not the raw log payload, to keep the assistant focused on the current question.',
      'Use concrete_failure_evidence and sampled_entries for citations; do not claim absence of errors unless returned_entries and the requested log window are adequate.',
      'If the user asks for queue, worker, task, or job evidence, prefer queue_or_worker_samples before generic sampled_entries.',
      'The browser fetched and cached the full log response for this classification, but raw entries are intentionally omitted from the assistant-facing payload.',
      'Volatile internal task, job, and worker identifiers are redacted from assistant-facing log messages because they are rarely needed for user diagnosis.',
    ],
  }
}

function extractStructuredLogSignals(entries: AssistantLogEntry[]) {
  const errors: Array<ReturnType<typeof buildAssistantLogEvidenceEntry>> = []
  const warnings: Array<ReturnType<typeof buildAssistantLogEvidenceEntry>> = []
  const notable: Array<ReturnType<typeof buildAssistantLogEvidenceEntry>> = []

  for (const entry of entries) {
    const message = typeof entry.message === 'string' ? entry.message.trim() : ''
    if (!message) continue
    const normalized = message.toLowerCase()
    const level = typeof entry.level === 'string' ? entry.level.toUpperCase() : ''
    const eventType = typeof entry.event_type === 'string' ? entry.event_type.toLowerCase() : ''
    const evidence = buildAssistantLogEvidenceEntry(entry)

    if (isFailureLikeLogEntry(entry, normalized, level)) {
      errors.push(evidence)
      continue
    }
    if (level === 'WARNING' || normalized.includes('warning') || normalized.includes('blocked')) {
      warnings.push(evidence)
      continue
    }
    if (
      eventType.includes('saved') ||
      eventType.includes('worker') ||
      normalized.includes('doc_id=') ||
      normalized.includes('queued') ||
      normalized.includes('cancelled') ||
      normalized.includes('completed')
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

function isFailureLikeLogEntry(entry: AssistantLogEntry, normalizedMessage: string, normalizedLevel: string) {
  if (normalizedLevel === 'ERROR') return true
  if (normalizedMessage.includes('exception') || normalizedMessage.includes('traceback')) return true
  if (normalizedMessage.includes('timed out') || normalizedMessage.includes('timeouterror')) return true
  if (normalizedMessage.includes('timeout') && (normalizedMessage.includes('error') || normalizedMessage.includes('failed'))) return true

  const eventType = typeof entry.event_type === 'string' ? entry.event_type.toLowerCase() : ''
  if (eventType.includes('failed') || eventType.includes('error')) return true

  return [
    'tool calling failed',
    'generation failed',
    'worker failed',
    'job failed',
    'execution failed',
    'adapter failed',
    'request failed',
    'api failed',
    'warm api failed',
    'failed state',
    'status=failed',
    'state=failed',
  ].some((phrase) => normalizedMessage.includes(phrase))
}

function buildAssistantLogSamples(
  entries: AssistantLogEntry[],
  signals: ReturnType<typeof extractStructuredLogSignals>,
) {
  const prioritized = [
    ...signals.errors,
    ...signals.warnings,
    ...signals.notable,
    ...entries.slice(0, 2).map(buildAssistantLogEvidenceEntry),
    ...entries.slice(Math.max(0, entries.length - 2)).map(buildAssistantLogEvidenceEntry),
  ]

  return uniqueLogEvidence(prioritized).slice(0, 12).map((entry) => ({ ...entry }))
}

function buildQueueOrWorkerLogSamples(entries: AssistantLogEntry[]) {
  const matches: Array<ReturnType<typeof buildAssistantLogEvidenceEntry>> = []
  for (const entry of entries) {
    const message = typeof entry.message === 'string' ? entry.message.trim() : ''
    const eventType = typeof entry.event_type === 'string' ? entry.event_type.toLowerCase() : ''
    const source = typeof entry.source === 'string' ? entry.source.toLowerCase() : ''
    const normalized = message.toLowerCase()

    if (
      eventType.includes('queue') ||
      eventType.includes('worker') ||
      source.includes('queue') ||
      source.includes('worker') ||
      normalized.includes(' queue ') ||
      normalized.includes('worker') ||
      normalized.includes('task_id=') ||
      normalized.includes('job=') ||
      normalized.includes('live_workers=') ||
      normalized.includes('stale_workers=')
    ) {
      matches.push(buildAssistantLogEvidenceEntry(entry))
    }
  }

  return uniqueLogEvidence(matches).slice(0, 8).map((entry) => ({ ...entry }))
}

function buildAssistantLogEvidenceEntry(entry: AssistantLogEntry) {
  return {
    id: entry.id ?? null,
    timestamp: entry.timestamp ?? null,
    level: entry.level ?? null,
    event_type: entry.event_type ?? null,
    source: entry.source ?? null,
    message: truncateForAssistant(redactAssistantLogText(typeof entry.message === 'string' ? entry.message : ''), 500),
    payload_preview: typeof entry.payload === 'string' && entry.payload.trim().length > 0
      ? truncateForAssistant(redactAssistantLogText(entry.payload.trim()), 350)
      : null,
  }
}

function redactAssistantLogText(value: string) {
  return value
    .replace(/\b(task_id|job|worker)=([^,\s]+)/gi, (match, key: string, rawValue: string) => {
      const normalizedValue = rawValue.trim().toLowerCase()
      if (!normalizedValue || normalizedValue === 'none' || normalizedValue === 'null') return match
      return `${key}=[redacted]`
    })
    .replace(/(["'])(task_id|job|worker)\1\s*:\s*(["'])(.*?)\3/gi, (match, quote: string, key: string, valueQuote: string, rawValue: string) => {
      const normalizedValue = rawValue.trim().toLowerCase()
      if (!normalizedValue || normalizedValue === 'none' || normalizedValue === 'null') return match
      return `${quote}${key}${quote}:${valueQuote}[redacted]${valueQuote}`
    })
}

function uniqueLogEvidence<T extends { id: number | null; timestamp: string | null; message: string }>(values: T[]) {
  const seen = new Set<string>()
  const result: T[] = []
  for (const value of values) {
    const key = `${value.id ?? ''}:${value.timestamp ?? ''}:${value.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function countLogField(entries: AssistantLogEntry[], field: 'level' | 'event_type' | 'source') {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    const rawValue = entry[field]
    const value = typeof rawValue === 'string' && rawValue.trim().length > 0 ? rawValue.trim() : 'unknown'
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function extractLogSignals(entries: AssistantLogEntry[]) {
  const errors: Array<{ message: string }> = []
  const warnings: Array<{ message: string }> = []

  for (const entry of entries) {
    const message = typeof entry.message === 'string' ? entry.message.trim() : ''
    if (!message) continue
    const normalized = message.toLowerCase()
    const level = typeof entry.level === 'string' ? entry.level.toUpperCase() : ''

    if (level === 'ERROR' || normalized.includes('error') || normalized.includes('failed') || normalized.includes('exception')) {
      errors.push({ message: redactAssistantLogText(message) })
      continue
    }
    if (level === 'WARNING' || normalized.includes('warning') || normalized.includes('missing') || normalized.includes('blocked')) {
      warnings.push({ message: redactAssistantLogText(message) })
    }
  }

  return { errors, warnings }
}

function getFailureSeverity(status: Run['status'], errorCount: number, warningCount: number) {
  if (status === 'failed' || errorCount > 0) return 'high'
  if (status === 'completed_with_errors' || warningCount > 0) return 'medium'
  return 'low'
}

function getFailureNextSteps(topErrors: string[], warnings: string[]) {
  const nextSteps: string[] = []
  const allSignals = [...topErrors, ...warnings].join(' ').toLowerCase()

  if (allSignals.includes('instruction')) {
    nextSteps.push("Inspect the preset's instruction attachments.")
  }
  if (allSignals.includes('document') || allSignals.includes('input')) {
    nextSteps.push('Review the preset input document selection.')
  }
  if (allSignals.includes('model')) {
    nextSteps.push('Check the preset model selection for the active engines.')
  }
  if (nextSteps.length === 0) {
    nextSteps.push('Review run logs in more detail if you need deeper diagnostics.')
  }

  return uniqueStrings(nextSteps)
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)))
}

function uniqueEvidence(values: Array<{ kind: string; message: string }>) {
  const seen = new Set<string>()
  const result: Array<{ kind: string; message: string }> = []
  for (const value of values) {
    const key = `${value.kind}:${value.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function buildRunOutputSummaryResult(
  run: Run,
  includeDocumentTitles: boolean,
  artifactEvidence?: RunArtifactEvidence,
) {
  const documents = (run.generated_docs ?? []).map((document, index) => ({
    id: document.id,
    title: includeDocumentTitles ? buildGeneratedDocumentTitle(document, index) : document.id,
    type: document.generator ?? 'generated_document',
  }))
  const logEvidenceSuggestsGeneratedArtifacts = Boolean(
    artifactEvidence && artifactEvidenceSuggestsGeneratedArtifacts(artifactEvidence)
  )
  const runFinished = isTerminalRunStatus(run.status)
  const outputVisibilityContradiction = runFinished && documents.length === 0 && logEvidenceSuggestsGeneratedArtifacts
  const inProgressArtifactEvidence = !runFinished && documents.length === 0 && logEvidenceSuggestsGeneratedArtifacts

  return {
    status: 'loaded',
    run_id: run.id,
    summary: {
      outputs_available: documents.length > 0,
      generated_document_count: documents.length,
      documents,
    },
    artifact_evidence_from_logs: artifactEvidence,
    output_visibility_contradiction: outputVisibilityContradiction
      ? {
          detected: true,
          message: 'Run logs indicate generated artifacts were saved, but the run output API returned zero visible generated documents.',
          safe_interpretation: 'Treat this as completed with no visible outputs until the output listing/indexing/visibility path is verified.',
          avoid: [
            'Do not claim the run produced no work.',
            'Do not invent backend table names, SQL, queue names, or service internals.',
          ],
        }
      : { detected: false },
    in_progress_artifact_evidence: inProgressArtifactEvidence
      ? {
          detected: true,
          message: 'Run logs already indicate generated artifacts, but the run is still active and the output API has not yet returned visible generated documents.',
          safe_interpretation: 'Treat this as in-progress evidence, not an output visibility contradiction, until the run reaches a terminal state.',
          next_step: 'Re-check output summary or load outputs after the run completes.',
        }
      : { detected: false },
    notes: documents.length > 0
      ? [
          'This is an output summary only.',
          'Use a dedicated content tool to inspect the body of a generated document.',
        ]
      : outputVisibilityContradiction
        ? [
            'No generated outputs are visible through the run output API.',
            'Logs contain generated-artifact evidence, so explain the mismatch rather than calling the run simply successful.',
          ]
        : inProgressArtifactEvidence
          ? [
              'The run is still active and no generated outputs are visible through the run output API yet.',
              'Logs contain generated-artifact evidence, but that is not a visibility contradiction until the run is terminal.',
            ]
      : [
          'No generated outputs are currently available for this run.',
        ],
    interpretation_notes: [
      'Output availability describes generated document presence, not quality or correctness.',
      'Log-derived artifact evidence is not a substitute for loaded output documents; it only proves what user-visible logs reported.',
    ],
  }
}

function artifactEvidenceSuggestsGeneratedArtifacts(artifactEvidence: RunArtifactEvidence) {
  return artifactEvidence.generated_save_event_count > 0 || artifactEvidence.generated_file_save_message_count > 0
}

function extractRunArtifactEvidence(entries: AssistantLogEntry[]): RunArtifactEvidence {
  const generatedArtifacts: RunArtifactEvidence['generated_artifacts'] = []
  let generatedSaveEventCount = 0
  let generatedFileSaveMessageCount = 0
  let evalSaveEventCount = 0

  for (const entry of entries) {
    const message = typeof entry.message === 'string' ? entry.message.trim() : ''
    if (!message) continue
    const eventType = typeof entry.event_type === 'string' ? entry.event_type.toLowerCase() : ''
    const normalized = message.toLowerCase()

    const isGeneratedSaveEvent =
      eventType === 'gen_saved' ||
      /gen(?:eration)?\s*#?\d*.*doc_id=/i.test(message) ||
      normalized.includes('saved generated content')
    const isGeneratedFileSaveMessage = normalized.includes('saved generated content')
    const isEvalSaveEvent =
      eventType === 'eval_saved' ||
      /eval\s*#?\d+.*saved/i.test(message) ||
      normalized.includes('eval saved')

    if (isGeneratedSaveEvent) {
      generatedSaveEventCount += 1
      if (generatedArtifacts.length < 8) {
        generatedArtifacts.push({
          timestamp: entry.timestamp ?? null,
          doc_id: extractLogValue(message, 'doc_id'),
          model: extractLogValue(message, 'model'),
          source: 'log_event',
          message: truncateForAssistant(message, 260),
        })
      }
    }
    if (isGeneratedFileSaveMessage) {
      generatedFileSaveMessageCount += 1
    }
    if (isEvalSaveEvent) {
      evalSaveEventCount += 1
    }
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

function buildAssistantContentSummary(item: ContentSummary) {
  return {
    id: item.id,
    name: item.name,
    content_type: item.content_type,
    description: item.description,
    folder_path: item.folder_path,
    tags: item.tags.slice(0, 24),
    body_preview: truncateForAssistant(item.body_preview ?? '', 500),
    created_at: item.created_at,
    updated_at: item.updated_at,
  }
}

function contentDetailToSummary(detail: ContentDetail): ContentSummary {
  return {
    id: detail.id,
    name: detail.name,
    content_type: detail.content_type,
    description: detail.description,
    folder_path: detail.folder_path,
    tags: detail.tags,
    body_preview: truncateForAssistant(detail.body, 500),
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  }
}

function buildAssistantContentDetail(detail: ContentDetail, maxChars: number) {
  const bodyExcerpt = truncateForAssistant(detail.body, maxChars)
  return {
    id: detail.id,
    name: detail.name,
    content_type: detail.content_type,
    description: detail.description,
    folder_path: detail.folder_path,
    tags: detail.tags.slice(0, 24),
    variable_names: Object.keys(detail.variables ?? {}).slice(0, 50),
    body_length: detail.body.length,
    body_excerpt: bodyExcerpt,
    body_excerpt_complete: detail.body.length <= maxChars,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  }
}

function truncateForAssistant(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function buildGeneratedDocumentTitle(document: NonNullable<Run['generated_docs']>[number], index: number) {
  const parts = [
    document.generator,
    document.model,
    document.source_doc_id,
    typeof document.iteration === 'number' ? `iteration ${document.iteration}` : null,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)

  if (parts.length === 0) {
    return `Generated document ${index + 1}`
  }

  return parts.join(' | ')
}
