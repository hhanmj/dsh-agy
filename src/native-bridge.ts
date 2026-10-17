/**
 * Experimental bridge: a real DSH continuable Agent owns the session,
 * while AGY CLI serves its text-only LLM transport. The CLI itself never
 * acquires a DSH Agent, tool registry, or Session write capability.
 *
 * Supports plain text requests only; AGY uses its own CLI-internal tools.
 * DSH child tools must be filtered away at native child creation.
 */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const NATIVE_MODEL_ID = 'agy-cli'

function asText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new Error('AGY native bridge: unsupported non-text request content')
  const pieces: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null || !('type' in block)) {
      throw new Error('AGY native bridge: malformed request block')
    }
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      pieces.push(block.text)
      continue
    }
    // Never silently discard media or a DSH-native tool call/result.
    throw new Error(`AGY native bridge: unsupported request block ${String(block.type)} (text-only transport)`)
  }
  return pieces.join('\n')
}

/** Full first turn; only the latest user delivery for AGY CLI --conversation. */
export function nativePrompt(options: GenerateOptions, resume: boolean): string {
  if (options.tools?.length) {
    throw new Error('AGY native bridge: DSH tools are not supported; native child toolFilter must be { allow: [] }')
  }
  const items = options.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
    .map((message) => ({ role: message.role, body: asText(message.content) }))
    .filter(({ body }) => body.trim().length > 0)
  if (resume) {
    const lastUser = items.findLast((message) => message.role === 'user')
    if (!lastUser) throw new Error('AGY native bridge: no user delivery available for conversation continuation')
    if (lastUser.body.length > 24_000) throw new Error('AGY native bridge: continued prompt exceeds safe CLI argument limit')
    return lastUser.body
  }
  const full = [
    ...(options.system ? [`[DSH system]\n${options.system}`] : []),
    ...items.map(({ role, body }) => `[${role}]\n${body}`),
    '[AGY execution boundary]\nYou are running inside Antigravity CLI. You cannot invoke DSH host tools. Use only the tools that AGY CLI actually exposes. Report real outcomes; never fabricate DSH tool results.',
  ].join('\n\n')
  if (full.length > 24_000) throw new Error('AGY native bridge: first-turn prompt exceeds safe CLI argument limit')
  return full
}

export type NativeCliRunner = (options: GenerateOptions) => Promise<string>

/**
 * Provider-scoped model identifier is deliberately a transport label,
 * not a guessed Gemini model slug. CLI decides its own model default.
 */
export class NativeAgyLlmAdapter extends LlmAdapter {
  constructor(
    private readonly route: string,
    private readonly runner: NativeCliRunner,
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    this.checkProvider(provider)
    return { id: provider, name: 'Antigravity CLI (native child · experimental)' }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.checkProvider(provider)
    return [{ provider, id: NATIVE_MODEL_ID, name: 'Antigravity CLI transport', inputModalities: ['text'] }]
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.checkProvider(provider)
    if (model !== NATIVE_MODEL_ID) throw new Error(`AGY native bridge: unsupported model route ${model}`)
    return { provider, id: model, name: 'Antigravity CLI transport', inputModalities: ['text'] }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.checkProvider(options.provider)
    if (options.model !== NATIVE_MODEL_ID) throw new Error('AGY native bridge: unknown model')
    if (options.signal?.aborted) throw new Error('AGY native bridge: request aborted')
    // Use the persisted conversation index as the source of resume state,
    // not heuristics based on the DSH request message count.
    const text = await this.runner(options)
    if (options.signal?.aborted) throw new Error('AGY native bridge: request aborted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private checkProvider(provider: string): void {
    if (provider !== this.route) throw new Error(`AGY native bridge: unregistered provider ${provider}`)
  }
}