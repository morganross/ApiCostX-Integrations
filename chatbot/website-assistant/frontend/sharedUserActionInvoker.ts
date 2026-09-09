import { resourceId } from '@/api/resourceId'
import { sharedActionParameters } from './sharedActionSchema'
import { apiClient } from '@/api/client'
import { contentsApi, type ContentType } from '@/api/contents'
import {
  createPreset,
  deletePreset,
  executePreset,
  getPreset,
  listPresets,
  updatePreset,
  duplicatePreset,
} from '@/api/presets'
import { runsApi } from '@/api/runs'
import { ALLIE_OWL_SHARED_ACTION_NAMES, ALLIE_OWL_SHARED_ACTIONS } from './allieOwlActionContract'

export type SharedUserActionBridgeApi = {
  listTools: () => readonly string[]
  invoke: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function confirmationFailure(confirm: unknown) {
  return confirm === true
    ? null
    : {
        status: 'confirmation_required',
        message: 'This action changes APICostX data. Repeat it with confirm=true after the user explicitly confirms it.',
      }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(value)))
    : fallback
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringMap(value: unknown) {
  const record = recordValue(value)
  return Object.fromEntries(
    Object.entries(record).filter(([, item]) => typeof item === 'string' || item === null),
  ) as Record<string, string | null>
}

const CREATABLE_CONTENT_TYPES = new Set<ContentType>([
  'generation_instructions',
  'input_document',
  'single_eval_instructions',
  'pairwise_eval_instructions',
  'eval_criteria',
  'combine_instructions',
  'template_fragment',
])

/**
 * Executes the canonical shared action contract in the logged-in website
 * session. It intentionally has no generic URL or arbitrary HTTP operation.
 */
export function createSharedUserActionInvoker(options: { trustedConfirmation?: boolean } = {}): SharedUserActionBridgeApi {
  const execute = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (!ALLIE_OWL_SHARED_ACTION_NAMES.includes(name as typeof ALLIE_OWL_SHARED_ACTION_NAMES[number])) {
      return { status: 'not_allowed', requested_tool: name, allowed_tools: ALLIE_OWL_SHARED_ACTION_NAMES }
    }
    if (!window.acm2Config?.currentUser) {
      return { status: 'unauthenticated', message: 'A logged-in APICostX user is required for this action.' }
    }
    const action = ALLIE_OWL_SHARED_ACTIONS.find(action => action.name === name)
    if (action?.mutatesPage && args.confirm === true && !options.trustedConfirmation) {
      if (!window.confirm(`Allow Allie to perform ${name}?\n${JSON.stringify(args, null, 2)}`)) {
        return { status: 'cancelled', message: 'The user declined this action.' }
      }
    }

    if (name === 'apicostx_list_content') {
      return {
        status: 'loaded',
        source: 'frontend_content_api',
        content: await contentsApi.list({
          content_type: typeof args.content_type === 'string' ? args.content_type as ContentType : undefined,
          search: typeof args.search === 'string' ? args.search : undefined,
          tag: typeof args.tag === 'string' ? args.tag : undefined,
          folder_path: typeof args.folder_path === 'string' ? args.folder_path : undefined,
          page: boundedInteger(args.page, 1, 1, 100),
          page_size: boundedInteger(args.page_size, 20, 1, 50),
        }),
      }
    }
    if (name === 'apicostx_duplicate_content') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      return { status: 'created', content: await contentsApi.duplicate(stringValue(args.content_id), stringValue(args.name) || undefined) }
    }
    if (name === 'apicostx_resolve_content') return { status: 'loaded', content: await contentsApi.resolve(stringValue(args.content_id), recordValue(args.runtime_variables) as Record<string, string>) }
    if (name === 'apicostx_duplicate_preset') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      return { status: 'created', preset: await duplicatePreset(stringValue(args.preset_id), stringValue(args.new_name)) }
    }
    if (name === 'apicostx_get_resume_info') return { status: 'loaded', result: await runsApi.getResumeInfo(stringValue(args.run_id)) }
    if (name === 'apicostx_get_checkpoint') return { status: 'loaded', result: await runsApi.getCheckpoint(stringValue(args.run_id)) }
    if (name === 'apicostx_delete_run') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      await runsApi.delete(stringValue(args.run_id))
      return { status: 'deleted', run_id: args.run_id }
    }
    if (name === 'apicostx_get_content') {
      const content = await contentsApi.get(stringValue(args.content_id))
      const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = boundedInteger(args.max_chars, 4000, 200, 12000)
      return {
        status: 'loaded',
        source: 'frontend_content_api',
        content: { ...content, body: content.body.slice(offset, offset + limit) },
        next_offset: offset + limit < content.body.length ? offset + limit : null,
        total_chars: content.body.length,
      }
    }
    if (name === 'apicostx_create_content') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      const contentType = stringValue(args.content_type) as ContentType
      if (!CREATABLE_CONTENT_TYPES.has(contentType)) {
        return { status: 'rejected', message: 'This content type is not writable through the assistant action contract.' }
      }
      const created = await contentsApi.create({
        name: stringValue(args.name).trim(),
        content_type: contentType,
        body: stringValue(args.body),
        variables: stringMap(args.variables),
        description: typeof args.description === 'string' ? args.description.trim() : undefined,
        folder_path: typeof args.folder_path === 'string' ? args.folder_path.trim() : undefined,
        tags: stringArray(args.tags),
      })
      return { status: 'created', source: 'frontend_content_api', content: await contentsApi.get(created.id), verification: { reloaded_by_id: true } }
    }
    if (name === 'apicostx_update_content') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      const patch = recordValue(args.patch)
      const update: Record<string, unknown> = {}
      for (const field of ['name', 'body', 'description', 'folder_path']) {
        if (typeof patch[field] === 'string') update[field] = patch[field]
      }
      if (Array.isArray(patch.tags)) update.tags = stringArray(patch.tags)
      if (patch.variables !== undefined) update.variables = stringMap(patch.variables)
      const contentId = stringValue(args.content_id)
      await contentsApi.update(contentId, update)
      return { status: 'updated', source: 'frontend_content_api', content: await contentsApi.get(contentId), verification: { reloaded_by_id: true } }
    }
    if (name === 'apicostx_delete_content') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      const contentId = stringValue(args.content_id)
      await contentsApi.delete(contentId)
      return { status: 'deleted', source: 'frontend_content_api', content_id: contentId }
    }
    if (name === 'apicostx_list_presets') {
      return { status: 'loaded', source: 'frontend_preset_api', ...(await listPresets(boundedInteger(args.page, 1, 1, 100), boundedInteger(args.page_size, 20, 1, 100))) }
    }
    if (name === 'apicostx_get_preset') {
      return { status: 'loaded', source: 'frontend_preset_api', preset: await getPreset(stringValue(args.preset_id)) }
    }
    if (name === 'apicostx_validate_preset') {
      return { status: 'loaded', source: 'frontend_preset_api', runnability: await apiClient.get(`/presets/${resourceId(stringValue(args.preset_id))}/runnable`) }
    }
    if (name === 'apicostx_create_preset') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      const created = await createPreset(recordValue(args.preset) as unknown as Parameters<typeof createPreset>[0])
      return { status: 'created', source: 'frontend_preset_api', preset: await getPreset(created.id), verification: { reloaded_by_id: true } }
    }
    if (name === 'apicostx_update_preset') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      const presetId = stringValue(args.preset_id)
      const updated = await updatePreset(presetId, recordValue(args.patch) as unknown as Parameters<typeof updatePreset>[1])
      return { status: 'updated', source: 'frontend_preset_api', preset: await getPreset(updated.id), verification: { reloaded_by_id: true } }
    }
    if (name === 'apicostx_delete_preset') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      return { status: 'deleted', source: 'frontend_preset_api', result: await deletePreset(stringValue(args.preset_id)) }
    }
    if (name === 'apicostx_execute_preset') {
      const denied = confirmationFailure(args.confirm)
      if (denied) return denied
      return { status: 'started', source: 'frontend_preset_api', result: await executePreset(stringValue(args.preset_id), undefined, typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined) }
    }
    if (name === 'apicostx_list_runs') {
      const page = boundedInteger(args.page, 1, 1, 100)
      const pageSize = boundedInteger(args.page_size, 20, 1, 100)
      return {
        status: 'loaded',
        source: 'frontend_run_api',
        page,
        page_size: pageSize,
        runs: await runsApi.list({ limit: pageSize, offset: (page - 1) * pageSize, status: typeof args.status === 'string' ? args.status : undefined }),
      }
    }
    if (name === 'apicostx_get_run') {
      const runId = stringValue(args.run_id)
      return { status: 'loaded', source: 'frontend_run_api', run: await runsApi.getExecutionView(runId) }
    }
    if (name === 'apicostx_get_run_logs') {
      const runId = stringValue(args.run_id)
      return {
        status: 'loaded',
        source: 'frontend_run_api',
        run_id: runId,
        logs: await apiClient.get(`/runs/${resourceId(runId)}/logs`, {
          classification: args.classification === 'all' ? 'all' : 'event',
          limit: boundedInteger(args.limit, 50, 1, 200),
          offset: boundedInteger(args.offset, 0, 0, 100000),
        }),
      }
    }
    if (name === 'apicostx_get_generated_output') {
      return {
        status: 'loaded',
        source: 'frontend_run_api',
        output: await runsApi.getGeneratedDocumentContent(stringValue(args.run_id), stringValue(args.doc_id)),
      }
    }
    if (name === 'apicostx_list_models') {
      return { status: 'loaded', source: 'frontend_model_api', models: await apiClient.get('/models') }
    }
    if (name === 'apicostx_get_usage') {
      return { status: 'loaded', source: 'frontend_usage_api', usage: await apiClient.get('/assistant-usage') }
    }
    if (name === 'apicostx_get_credits') {
      return { status: 'loaded', source: 'frontend_credits_api', credits: await apiClient.get('/credits') }
    }

    const denied = confirmationFailure(args.confirm)
    if (denied) return denied
    if (name === 'apicostx_pause_run') {
      return { status: 'updated', source: 'frontend_run_api', result: await runsApi.pause(stringValue(args.run_id)) }
    }
    if (name === 'apicostx_resume_run') {
      return { status: 'updated', source: 'frontend_run_api', result: await runsApi.resume(stringValue(args.run_id)) }
    }
    if (name === 'apicostx_cancel_run') {
      return { status: 'updated', source: 'frontend_run_api', result: await runsApi.cancel(stringValue(args.run_id)) }
    }

    return { status: 'not_allowed', requested_tool: name, allowed_tools: ALLIE_OWL_SHARED_ACTION_NAMES }
  }

  return {
    listTools: () => ALLIE_OWL_SHARED_ACTION_NAMES,
    invoke: async (name, args = {}) => {
      const parsed = sharedActionParameters(name).parse(args) as Record<string, unknown>
      const result = await execute(name, parsed)
      const action = ALLIE_OWL_SHARED_ACTIONS.find(item => item.name === name)
      if (!action?.mutatesPage) {
        const encoded = JSON.stringify(result)
        const offset = boundedInteger(args.result_offset, 0, 0, Number.MAX_SAFE_INTEGER)
        const size = boundedInteger(args.result_chars, 4000, 200, 4000)
        if (encoded.length > size || offset) return {
          result_json_fragment: encoded.slice(offset, offset + size), total_result_chars: encoded.length,
          next_result_offset: offset + size < encoded.length ? offset + size : null,
        }
      }
      return result
    },
  }
}
