/**
 * Experimental bridge: a real DSH continuable Agent owns the session,
 * while AGY CLI serves its text-only LLM transport. The CLI itself never
 * acquires a DSH Agent, tool registry, or Session write capability.
 *
 * Text requests, plus images handed over as files AGY opens with its own
 * viewer (the runner saves them and passes their paths); AGY uses its own
 * CLI-internal tools.
 * Native child creation restricts global tools, but per-child scoped tools
 * may still be advertised by DSH. The adapter strips model-facing tool
 * schemas/history at its own boundary. It never emits DSH tool calls.
 *
 * Streaming: the runner forwards AGY's real visible `text_delta` fragments
 * through a sink as they arrive (agy `--output-format stream-json`), and the
 * adapter yields them as DSH `text-delta` chunks immediately. AGY tool steps
 * have no honest DSH StreamChunk equivalent (they are not DSH tool calls and
 * AGY does not expose its hidden reasoning), so they go to the durable trace
 * (`antigravity_trace`) instead of being disguised as tool-call or reasoning
 * deltas. The final response is reconciled against what was already streamed,
 * so it is never appended twice.
 */
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * Legacy transport label meaning "the CLI's own default model and effort" (no
 * --model/--effort). No longer listed; still resolvable so children created
 * with it keep working after a cold resume.
 */
export const NATIVE_MODEL_ID = 'agy-cli'

/** One selectable AGY model as listed by "agy models" (base id + effort variants). */
export interface NativeModelEntry {
  id: string
  name: string
  efforts: readonly string[]
  defaultEffort?: string
  /** Context capacity to advertise (configured vendor figure; agy itself does not report one). */
  contextWindow?: number
}
/** Source of real AGY models; failures surface as errors, never as invented entries. */
export interface NativeModelSource {
  list(): Promise<readonly NativeModelEntry[]>
}

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

/** Longest prompt passed as one CLI argument (Windows command lines cap near 32k). */
export const MAX_PROMPT_CHARS = 24_000

/** How one DSH request is rendered for the CLI. */
export interface NativePromptOptions {
  /**
   * strict (default; DSH child sessions): anything that is not text, a
   * supported image, user/assistant/system fails closed, and an oversized
   * first turn is an error.
   * lenient (a main session that selected an AGY model): DSH tool traffic and
   * reasoning are replaced by explicit omission notes, and only the newest
   * history that fits the CLI argument limit is kept.
   */
  mode?: 'strict' | 'lenient'
  /** Keep the DSH system prompt (children; auxiliary title/compaction calls). Default: true in strict mode, false in lenient mode. */
  includeSystem?: boolean
  /** Text that stands in for an image block (normally the saved file path); without it an image is rejected (strict) or noted (lenient). */
  image?: (block: { type: 'image'; attachment?: unknown }) => string | undefined
}

interface RenderState {
  omittedTools: number
}

function renderBlocks(content: unknown, options: NativePromptOptions, state: RenderState): string {
  const lenient = options.mode === 'lenient'
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
    if (block.type === 'image') {
      const placeholder = options.image?.(block as { type: 'image'; attachment?: unknown })
      if (placeholder !== undefined) {
        pieces.push(placeholder)
        continue
      }
      if (lenient) {
        pieces.push('[image omitted: it could not be handed to Antigravity CLI]')
        continue
      }
    }
    if (lenient) {
      if (block.type === 'tool-call') {
        state.omittedTools += 1
        pieces.push(`[earlier DSH tool call ${'name' in block ? String(block.name) : ''} omitted]`)
        continue
      }
      if (block.type === 'reasoning') continue
      pieces.push(`[${String(block.type)} content omitted]`)
      continue
    }
    // Never silently discard media or a DSH-native tool call/result.
    throw new Error(`AGY native bridge: unsupported request block ${String(block.type)} (text-only transport)`)
  }
  return pieces.join('\n')
}

/** Full first turn; only the latest user delivery for AGY CLI --conversation. */
export function nativePrompt(options: GenerateOptions, resume: boolean, render: NativePromptOptions = {}): string {
  const lenient = render.mode === 'lenient'
  const includeSystem = render.includeSystem ?? !lenient
  const state: RenderState = { omittedTools: 0 }
  // A child's scoped tools can survive ctx.tools.restrict({ allow: [] });
  // schema advertisement is not permission or evidence that AGY can call them.
  // options.tools is never included in the CLI prompt. In strict mode DSH tool
  // messages fail closed rather than silently disappearing from history.
  const items: { role: string; body: string }[] = []
  for (const message of options.messages) {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
      if (!lenient) throw new Error(`AGY native bridge: unsupported DSH message role ${String(message.role)} (text-only transport)`)
      state.omittedTools += 1
      continue
    }
    if (message.role === 'system' && !includeSystem) continue
    const body = renderBlocks(message.content, render, state)
    // A main chat's own execution panels (GenUI fences) are display-only.
    const visible = lenient && message.role === 'assistant' ? body.replace(/```dsh-ui[\s\S]*?```/g, '[AGY execution panel omitted]') : body
    if (visible.trim().length > 0) items.push({ role: message.role, body: visible })
  }
  if (resume) {
    const lastUser = items.findLast((message) => message.role === 'user')
    if (!lastUser) throw new Error('AGY native bridge: no user delivery available for conversation continuation')
    if (lastUser.body.length > MAX_PROMPT_CHARS) throw new Error('AGY native bridge: continued prompt exceeds safe CLI argument limit')
    return lastUser.body
  }
  const header = includeSystem && options.system ? [`[DSH system]\n${options.system}`] : []
  const boundary = '[AGY execution boundary]\nYou are running inside Antigravity CLI. You cannot invoke DSH host tools. Use only the tools that AGY CLI actually exposes. Report real outcomes; never fabricate DSH tool results.'
  const notes = state.omittedTools > 0 ? [`[note] ${state.omittedTools} earlier DSH tool call(s)/result(s) were omitted; they are not available to you.`] : []
  const assemble = (kept: typeof items, dropped: number): string => [
    ...header,
    ...(dropped > 0 ? [`[note] ${dropped} earlier message(s) omitted to fit the Antigravity CLI argument limit.`] : []),
    ...notes,
    ...kept.map(({ role, body }) => `[${role}]\n${body}`),
    boundary,
  ].join('\n\n')
  let full = assemble(items, 0)
  if (full.length <= MAX_PROMPT_CHARS) return full
  if (!lenient) throw new Error('AGY native bridge: first-turn prompt exceeds safe CLI argument limit')
  // Keep the newest history that fits; the latest user message is never dropped.
  for (let dropped = 1; dropped < items.length; dropped += 1) {
    full = assemble(items.slice(dropped), dropped)
    if (full.length <= MAX_PROMPT_CHARS) return full
  }
  throw new Error('AGY native bridge: the latest message alone exceeds the safe CLI argument limit')
}

/** Receives AGY's real visible text fragments while the run is still executing. */
export interface NativeTextSink {
  text(delta: string): void
}

/**
 * Runs one AGY turn. Streams visible text through `sink` when the transport
 * supports it and resolves with AGY's authoritative final response text.
 * A runner that never calls the sink still works (final-only fallback).
 */
export type NativeCliRunner = (options: GenerateOptions, sink: NativeTextSink) => Promise<string | NativeRunOutcome>

/** Final text plus the token usage AGY reported for the turn (never estimated). */
export interface NativeRunOutcome {
  text: string
  usage?: TokenUsage
  /**
   * Final assembled text when it should differ from what was streamed (a main
   * chat replaces its live AGY progress lines with a collapsible execution
   * panel). DSH keeps the block-end text as the message; nothing is invented —
   * the panel lists AGY's own recorded tool steps.
   */
  display?: string
}

/**
 * What remains to be emitted once the final response is known.
 * - nothing streamed: the whole final response;
 * - streamed text equals the final response: nothing (no double append);
 * - streamed text is a strict prefix: only the missing suffix;
 * - otherwise: nothing — streamed text cannot be retracted, and appending the
 *   final response would duplicate it (agy 1.4.0 response == joined deltas).
 */
export function reconcileFinalText(streamed: string, final: string): string {
  if (streamed.length === 0) return final
  if (final === streamed) return ''
  if (final.startsWith(streamed)) return final.slice(streamed.length)
  return ''
}

/**
 * Provider-scoped model identifier is deliberately a transport label,
 * not a guessed Gemini model slug. CLI decides its own model default.
 */
export class NativeAgyLlmAdapter extends LlmAdapter {
  constructor(
    private readonly route: string,
    private readonly runner: NativeCliRunner,
    private readonly models?: NativeModelSource,
    /** Declare image input: the runner can hand images to AGY as files. */
    private readonly imageInput = false,
  ) {
    super()
  }

  private modalities(): ('text' | 'image')[] {
    return this.imageInput ? ['text', 'image'] : ['text']
  }

  private defaultEntry(provider: string): LlmModelInfo {
    return { provider, id: NATIVE_MODEL_ID, name: 'Antigravity CLI default model', inputModalities: this.modalities() }
  }

  providerInfo(provider: string): LlmProviderInfo {
    this.checkProvider(provider)
    return { id: provider, name: 'Antigravity CLI (native child · experimental)' }
  }

  /** Every model "agy models" reports (agy-cli is no longer listed); a failed listing lists nothing. */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.checkProvider(provider)
    let listed: readonly NativeModelEntry[] = []
    try {
      listed = (await this.models?.list()) ?? []
    } catch {
      listed = []
    }
    return listed.map((entry) => ({ provider, id: entry.id, name: `AGY · ${entry.name}`, inputModalities: this.modalities() }))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.checkProvider(provider)
    if (model === NATIVE_MODEL_ID) return this.defaultEntry(provider)
    if (this.models === undefined) throw new Error(`AGY native bridge: unsupported model route ${model}`)
    const entry = (await this.models.list()).find((candidate) => candidate.id === model)
    if (entry === undefined) throw new Error(`AGY native bridge: "agy models" does not list ${model}`)
    return {
      provider,
      id: entry.id,
      name: `AGY · ${entry.name}`,
      inputModalities: this.modalities(),
      ...(entry.contextWindow !== undefined ? { context: { contextWindow: entry.contextWindow } } : {}),
      ...(entry.efforts.length > 0 ? {
        reasoning: {
          efforts: entry.efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: EFFORT_LABELS[effort] ?? effort })),
          ...(entry.defaultEffort !== undefined ? { defaultEffort: ReasoningEffortId(entry.defaultEffort) } : {}),
        },
      } : {}),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.checkProvider(options.provider)
    if (typeof options.model !== 'string' || options.model.length === 0) throw new Error('AGY native bridge: unknown model')
    if (options.signal?.aborted) throw new Error('AGY native bridge: request aborted')
    // Use the persisted conversation index as the source of resume state,
    // not heuristics based on the DSH request message count.
    // Never expose DSH tool declarations or tool histories to the AGY
    // subprocess runner, even when scoped child tools survive the allow-list.
    // Only text messages/system information can cross this transport boundary.
    const { tools: _hostTools, toolHistory: _hostToolHistory, ...safeOptions } = options

    // A consumer that stops iterating early must also stop the AGY process.
    const linked = new AbortController()
    const forwardAbort = (): void => linked.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forwardAbort, { once: true })

    const queue: string[] = []
    let wake: (() => void) | undefined
    let settled = false
    let finalText = ''
    let usage: TokenUsage | undefined
    let display: string | undefined
    let failure: { error: unknown } | undefined
    const notify = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const sink: NativeTextSink = {
      text(delta: string) {
        if (settled || typeof delta !== 'string' || delta.length === 0) return
        queue.push(delta)
        notify()
      },
    }
    const running = Promise.resolve()
      .then(() => this.runner({ ...safeOptions, signal: linked.signal }, sink))
      .then(
        (outcome) => {
          finalText = typeof outcome === 'string' ? outcome : typeof outcome?.text === 'string' ? outcome.text : ''
          usage = typeof outcome === 'object' && outcome !== null ? outcome.usage : undefined
          display = typeof outcome === 'object' && outcome !== null && typeof outcome.display === 'string' ? outcome.display : undefined
          settled = true
          notify()
        },
        (error: unknown) => {
          failure = { error }
          settled = true
          notify()
        },
      )

    let opened = false
    let streamed = ''
    try {
      for (;;) {
        while (queue.length > 0) {
          const delta = queue.shift() as string
          if (!opened) {
            opened = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          streamed += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }
        if (settled) break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      await running
      if (failure !== undefined) throw failure.error
      if (options.signal?.aborted) throw new Error('AGY native bridge: request aborted')
      // With a display override the runner already reconciled AGY's text itself.
      const remainder = display !== undefined ? '' : reconcileFinalText(streamed, finalText)
      if (!opened) {
        opened = true
        yield { type: 'block-start', index: 0, blockType: 'text' }
      }
      if (remainder.length > 0) {
        streamed += remainder
        yield { type: 'text-delta', index: 0, text: remainder }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: display ?? streamed } }
      // Real AGY-reported counts only; nothing is estimated.
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort)
      if (!settled) linked.abort(new Error('AGY native bridge: stream consumer closed before AGY finished'))
    }
  }

  private checkProvider(provider: string): void {
    if (provider !== this.route) throw new Error(`AGY native bridge: unregistered provider ${provider}`)
  }
}
