import {
  hasAdvancedAssistantConfig,
  hasBasicAssistantRuntimeConfig,
} from './assistantConfig'

export function isAssistantDemoMode(): boolean {
  return !window.acm2Config?.currentUser
}

export function canRenderAssistant(): boolean {
  return hasBasicAssistantRuntimeConfig() || hasAdvancedAssistantConfig()
}

export function canShowAssistant(): boolean {
  return canRenderAssistant() || isAssistantDemoMode()
}

export function isAssistantInteractive(): boolean {
  return canRenderAssistant()
}
