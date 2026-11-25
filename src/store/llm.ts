/**
 * LLM models offered by the phone settings.
 *
 * The backend owns the real list (it may point at an OpenAI-compatible
 * endpoint, a local server or a cloud provider — build-agent-tz.md § LLM).
 * This list is the demo default so the picker has something honest to show;
 * when the backend can advertise `/api/llm/models`, the list moves there and
 * the screen stays the same.
 *
 * Labels are product names, not UI copy: they are not translated.
 */

export const LLM_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat' },
] as const

export type LlmModel = (typeof LLM_MODELS)[number]['id']

/** Cheap and fast is the right default for "three short reply options". */
export const DEFAULT_LLM_MODEL: LlmModel = 'gpt-4o-mini'

export function isLlmModel(value: unknown): value is LlmModel {
  return LLM_MODELS.some((model) => model.id === value)
}

export function modelLabel(id: string): string {
  return LLM_MODELS.find((model) => model.id === id)?.label ?? id
}
