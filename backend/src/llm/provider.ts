/**
 * Thin OpenAI-compatible client: one `POST /chat/completions`, one string back.
 * The concrete provider is chosen by `.env`; a local model with the same API
 * drops in here unchanged.
 *
 * Provider-specific knobs (26.11.2026, DeepSeek):
 * - `response_format: {"type":"json_object"}` — we validate the schema anyway.
 * - `thinking: {"type":"disabled"}` — thinking mode is on by default, costs
 *   seconds on an 8-second budget and ignores `temperature`; the temperature
 *   line is only meaningful when thinking is off.
 *
 * The response body is never logged or passed through: it can echo the prompt,
 * and the prompt carries message text by design.
 */

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export type LlmFailure = 'timeout' | 'network' | 'http' | 'shape' | 'empty'

export class LlmError extends Error {
  readonly reason: LlmFailure

  constructor(reason: LlmFailure) {
    super(reason)
    this.name = 'LlmError'
    this.reason = reason
  }
}

export interface LlmClient {
  complete(messages: ChatMessage[], opts: { model: string; timeoutMs: number }): Promise<string>
}

/** Low on purpose: three options, not a creative essay. */
const TEMPERATURE = 0.3
/** Summary ≤ 90 + three options ≤ 120; 400 leaves room for JSON syntax. */
const MAX_TOKENS = 400

export function createOpenAiClient(baseUrl: string, apiKey: string): LlmClient {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(messages, { model, timeoutMs }) {
      if (timeoutMs <= 0) throw new LlmError('timeout')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: TEMPERATURE,
            max_tokens: MAX_TOKENS,
            response_format: { type: 'json_object' },
            thinking: { type: 'disabled' },
          }),
          signal: controller.signal,
        })
        if (!response.ok) throw new LlmError('http')
        let body: unknown
        try {
          body = await response.json()
        } catch {
          throw new LlmError('shape')
        }
        const choices = (body as { choices?: unknown }).choices
        const first = Array.isArray(choices) ? (choices[0] as { message?: unknown }) : undefined
        const content = (first?.message as { content?: unknown } | undefined)?.content
        if (typeof content !== 'string') throw new LlmError('empty')
        return content
      } catch (err) {
        if (err instanceof LlmError) throw err
        throw new LlmError(controller.signal.aborted ? 'timeout' : 'network')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
