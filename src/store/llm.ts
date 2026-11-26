/**
 * LLM models offered by the phone settings.
 *
 * The backend owns the real list (`GET /llm/models`): it may point at an
 * OpenAI-compatible endpoint, a local server or a cloud provider
 * (build-agent-tz.md § LLM). This list is the offline fallback so the picker
 * has something honest to show in the demo; the screen still renders whatever
 * the backend advertises.
 *
 * Labels are product names, not UI copy: they are not translated.
 */

export const LLM_MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
] as const

/**
 * Backend model ids are not a compile-time union: `.env` decides the provider.
 * The settings keep the id as a string and the backend falls back to its
 * default when the id is unknown.
 */
export type LlmModel = string

/** Cheap and fast is the right default for "three short reply options". */
export const DEFAULT_LLM_MODEL: LlmModel = 'deepseek-flash'

export function isLlmModel(value: unknown): value is LlmModel {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}

export function modelLabel(id: string): string {
  return LLM_MODELS.find((model) => model.id === id)?.label ?? id
}
