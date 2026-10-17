/**
 * Unified AGY activity model: folds stream-json step updates into one record per
 * step (sessionId + runId + stepIndex). ACTIVE/DONE/ERROR updates of the same
 * step update the same record; tool parameters, output and errors are redacted
 * and truncated; unknown step types keep their raw identifier instead of a
 * guessed meaning. Records describe AGY-internal work only: they are never DSH
 * tool calls and never model reasoning.
 */
import type { AgyStreamEvent } from './stream-events.js'
import { sanitizeText, type SanitizeContext } from './trace.js'

export type AgyActivityType = 'tool' | 'response' | 'checkpoint' | 'subagent' | 'other'
export type AgyActivityState = 'running' | 'completed' | 'failed'

export interface AgyActivityEvent {
  sessionId: string
  runId: string
  stepIndex: number
  type: AgyActivityType
  /** AGY's own step_type (always kept; the only meaning for type 'other'). */
  rawType: string
  state: AgyActivityState
  toolName?: string
  /** Redacted one-line subject: command, file, URL or query. */
  summary?: string
  /** Redacted, truncated output preview or error message. */
  detail?: string
  durationMs?: number
  /** First time this step was seen. */
  timestamp: number
  /** Last update time. */
  updatedAt: number
  /** Trace key + run id where the full record lives. */
  traceRef?: string
}

const SUBJECT_KEYS = ['CommandLine', 'TargetFile', 'AbsolutePath', 'SearchPath', 'DirectoryPath', 'Url', 'Query', 'SearchQuery']

function subjectOf(parameters: unknown): string {
  if (typeof parameters !== 'object' || parameters === null) return ''
  const record = parameters as Record<string, unknown>
  for (const key of SUBJECT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return ''
}

function typeOf(stepType: string | undefined, hasTool: boolean): AgyActivityType {
  if (hasTool || stepType === 'tool') return 'tool'
  if (stepType === 'agent_response') return 'response'
  if (stepType === 'system_message' || stepType === 'checkpoint') return 'checkpoint'
  if (stepType === 'subagent' || stepType === 'subagent_info') return 'subagent'
  return 'other'
}

export interface ActivityOptions {
  sessionId: string
  runId: string
  traceRef?: string
  sanitize: SanitizeContext
  /** Max characters of a summary / detail (default 160). */
  maxChars?: number
}

/** Folds one run's (or one turn's) step updates into activity records. */
export class ActivityTracker {
  private readonly records = new Map<number, AgyActivityEvent>()
  private fallbackIndex = 1_000_000
  private thinking = 0

  constructor(private readonly options: ActivityOptions) {}

  /** Apply one event; returns the updated record when it changed an activity, else undefined. */
  observe(event: AgyStreamEvent, now = Date.now()): AgyActivityEvent | undefined {
    if (event.kind === 'step' && event.stepType === 'agent_response' && event.usage?.thinking_tokens !== undefined) {
      this.thinking += event.usage.thinking_tokens
    }
    if (event.kind !== 'step' || event.stepType === 'user_input') return undefined
    const index = event.stepIndex ?? this.fallbackIndex++
    const info = event.toolInfo
    const type = typeOf(event.stepType, info !== undefined || event.toolName !== undefined)
    // Text-only response steps without state changes carry no activity of their own.
    if (type === 'response' && event.state !== 'ERROR' && this.records.get(index) === undefined && event.state !== 'ACTIVE' && event.state !== 'DONE') return undefined
    const max = this.options.maxChars ?? 160
    const clean = (text: string): string => sanitizeText(text, this.options.sanitize, max).replace(/\s+/g, ' ').trim()
    const error = info?.error as { message?: unknown } | null | undefined
    const failed = event.state === 'ERROR' || (error !== undefined && error !== null)
    const state: AgyActivityState = failed ? 'failed' : event.state === 'DONE' ? 'completed' : 'running'
    const previous = this.records.get(index)
    const output = typeof info?.output === 'string' ? info.output : info?.output !== undefined && info.output !== null ? JSON.stringify(info.output) : ''
    const detail = failed && typeof error?.message === 'string' ? error.message : output
    const subject = subjectOf(info?.parameters)
    const record: AgyActivityEvent = {
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      stepIndex: index,
      type,
      rawType: event.stepType ?? previous?.rawType ?? 'unknown',
      state,
      ...(event.toolName ?? info?.name ?? previous?.toolName ? { toolName: event.toolName ?? info?.name ?? previous?.toolName } : {}),
      ...(subject ? { summary: clean(subject) } : previous?.summary !== undefined ? { summary: previous.summary } : {}),
      ...(detail ? { detail: clean(detail) } : previous?.detail !== undefined ? { detail: previous.detail } : {}),
      ...(event.durationSeconds !== undefined ? { durationMs: Math.round(event.durationSeconds * 1000) } : previous?.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
      timestamp: previous?.timestamp ?? now,
      updatedAt: now,
      ...(this.options.traceRef !== undefined ? { traceRef: this.options.traceRef } : {}),
    }
    this.records.set(index, record)
    return record
  }

  /** Records in step order. */
  list(): AgyActivityEvent[] {
    return [...this.records.values()].sort((a, b) => a.stepIndex - b.stepIndex)
  }

  /** Tool records only (what an execution panel shows). */
  tools(): AgyActivityEvent[] {
    return this.list().filter((record) => record.type === 'tool')
  }

  /** Total thinking tokens AGY reported for the steps seen (count only; the text is not exposed). */
  get thinkingTokens(): number {
    return this.thinking
  }
}
