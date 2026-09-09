import type { AssistantMode } from './assistantTypes'

export const ASSISTANT_MODE_OVERRIDE_STORAGE_KEY = 'acm2.assistant.modeOverride'

export type BasicAssistantEndpointConfig = {
  transport: 'copilot_runtime'
  runtimeBaseUrl: string
  runtimeUrl: string
  assistantToken: string
}

export type AdvancedAssistantEndpointConfig = {
  transport: 'backend_api'
  baseUrl: string
  enabled: boolean
}

export function getBasicAssistantEndpoint(): BasicAssistantEndpointConfig | null {
  const configured = window.acm2Config?.assistantEndpoints?.basic
  const runtimeBaseUrl =
    configured?.runtimeBaseUrl ||
    window.acm2Config?.copilotRuntimeBaseUrl ||
    ''
  const runtimeUrl =
    configured?.runtimeUrl ||
    window.acm2Config?.copilotRuntimeUrl ||
    ''
  const assistantToken =
    configured?.assistantToken ||
    window.acm2Config?.copilotAssistantToken ||
    ''

  if (!runtimeBaseUrl || !runtimeUrl) {
    return null
  }

  return {
    transport: 'copilot_runtime',
    runtimeBaseUrl,
    runtimeUrl,
    assistantToken,
  }
}

export function getAdvancedAssistantEndpoint(): AdvancedAssistantEndpointConfig | null {
  const configured = window.acm2Config?.assistantEndpoints?.advanced
  const baseUrl = configured?.baseUrl?.replace(/\/+$/, '') || ''
  const enabled = configured?.enabled !== false

  if (!baseUrl || !enabled) {
    return null
  }

  return {
    transport: 'backend_api',
    baseUrl,
    enabled,
  }
}

export function hasBasicAssistantRuntimeConfig(): boolean {
  const basic = getBasicAssistantEndpoint()
  return Boolean(
    basic?.runtimeUrl &&
      basic.assistantToken &&
      window.acm2Config?.currentUser,
  )
}

export function hasAdvancedAssistantConfig(): boolean {
  return Boolean(getAdvancedAssistantEndpoint()?.baseUrl && window.acm2Config?.currentUser)
}

export function getBootstrapAssistantDefaultMode(): AssistantMode {
  return window.acm2Config?.assistantMode?.defaultMode === 'advanced' ? 'advanced' : 'basic'
}

export function readAssistantModeOverride(): AssistantMode | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(ASSISTANT_MODE_OVERRIDE_STORAGE_KEY)
    return value === 'advanced' || value === 'basic' ? value : null
  } catch {
    return null
  }
}

export function writeAssistantModeOverride(mode: AssistantMode | null): void {
  if (typeof window === 'undefined') return
  try {
    if (!mode) {
      window.localStorage.removeItem(ASSISTANT_MODE_OVERRIDE_STORAGE_KEY)
      return
    }
    window.localStorage.setItem(ASSISTANT_MODE_OVERRIDE_STORAGE_KEY, mode)
  } catch {
    // Local preference storage is non-critical.
  }
}
