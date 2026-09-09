export type AllieOwlActionCategory = 'content' | 'preset' | 'run' | 'model' | 'usage' | 'credits'

export type AllieOwlSharedAction = {
  name: string
  category: AllieOwlActionCategory
  mutatesPage: boolean
  requiresConfirmation: boolean
  downstreamOperation: string
}

/**
 * Canonical names shared with the standalone Allie Owl action registry.
 * Website implementations remain page-owned and use the logged-in session;
 * Owl implementations use the user's API-key-authenticated backend client.
 */
export const ALLIE_OWL_SHARED_ACTIONS = [
  {
    "name": "apicostx_list_content",
    "category": "content",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /contents"
  },
  {
    "name": "apicostx_get_content",
    "category": "content",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /contents/{content_id}"
  },
  {
    "name": "apicostx_create_content",
    "category": "content",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /contents"
  },
  {
    "name": "apicostx_update_content",
    "category": "content",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "PUT /contents/{content_id}"
  },
  {
    "name": "apicostx_delete_content",
    "category": "content",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "DELETE /contents/{content_id}"
  },
  {
    "name": "apicostx_list_presets",
    "category": "preset",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /presets"
  },
  {
    "name": "apicostx_get_preset",
    "category": "preset",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /presets/{preset_id}"
  },
  {
    "name": "apicostx_validate_preset",
    "category": "preset",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /presets/{preset_id}/runnable"
  },
  {
    "name": "apicostx_create_preset",
    "category": "preset",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /presets"
  },
  {
    "name": "apicostx_update_preset",
    "category": "preset",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "PUT /presets/{preset_id}"
  },
  {
    "name": "apicostx_delete_preset",
    "category": "preset",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "DELETE /presets/{preset_id}"
  },
  {
    "name": "apicostx_execute_preset",
    "category": "preset",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /presets/{preset_id}/execute"
  },
  {
    "name": "apicostx_list_runs",
    "category": "run",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /runs"
  },
  {
    "name": "apicostx_get_run",
    "category": "run",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /runs/{run_id}"
  },
  {
    "name": "apicostx_get_run_logs",
    "category": "run",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /runs/{run_id}/logs"
  },
  {
    "name": "apicostx_get_generated_output",
    "category": "run",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /runs/{run_id}/generated/{doc_id}"
  },
  {
    "name": "apicostx_pause_run",
    "category": "run",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /runs/{run_id}/pause"
  },
  {
    "name": "apicostx_resume_run",
    "category": "run",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /runs/{run_id}/resume"
  },
  {
    "name": "apicostx_cancel_run",
    "category": "run",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /runs/{run_id}/cancel"
  },
  {
    "name": "apicostx_list_models",
    "category": "model",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /models"
  },
  {
    "name": "apicostx_get_usage",
    "category": "usage",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /assistant-usage"
  },
  {
    "name": "apicostx_get_credits",
    "category": "credits",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /credits"
  },
  {
    "name": "apicostx_duplicate_content",
    "category": "content",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /contents/{content_id}/duplicate"
  },
  {
    "name": "apicostx_resolve_content",
    "category": "content",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "POST /contents/{content_id}/resolve"
  },
  {
    "name": "apicostx_duplicate_preset",
    "category": "preset",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "POST /presets/{preset_id}/duplicate"
  },
  {
    "name": "apicostx_get_resume_info",
    "category": "run",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /runs/{run_id}/resume-info"
  },
  {
    "name": "apicostx_get_checkpoint",
    "category": "run",
    "mutatesPage": false,
    "requiresConfirmation": false,
    "downstreamOperation": "GET /runs/{run_id}/checkpoint"
  },
  {
    "name": "apicostx_delete_run",
    "category": "run",
    "mutatesPage": true,
    "requiresConfirmation": true,
    "downstreamOperation": "DELETE /runs/{run_id}"
  }
] as const satisfies readonly AllieOwlSharedAction[]

export const ALLIE_OWL_SHARED_ACTION_NAMES = ALLIE_OWL_SHARED_ACTIONS.map((action) => action.name)

declare global {
  interface Window {
    acm2SharedUserActionBridge?: {
      listTools: () => readonly string[]
      invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>
    }
  }
}
