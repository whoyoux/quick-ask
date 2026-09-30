// Contracts for the functions the chat model can call while answering.
// No Electron or bundler imports here: scripts/test-tools.ts loads the tools directly.

import type { Source } from '../../shared/types'
import type { FunctionTool } from '../openrouter'

/** Each can be switched off in the tray's "Narzędzia AI" menu. */
export type ToolId = 'code' | 'charts' | 'currency' | 'weather' | 'time'

export interface ToolContext {
  signal: AbortSignal
  /** The question being answered; the code tool can read data pasted into it. */
  question: string
  /** The user's IANA time zone. */
  timeZone: string
}

export interface ToolOutput {
  /** What the model reads. */
  content: string
  /** What the user sees when they open the tool's details; shorter than `content` if needed. */
  display?: string
  /** Where the data came from; listed with the answer's sources. */
  sources?: Source[]
}

/** A failure worth telling the model (so it can retry or explain) and the user. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export interface LocalTool {
  id: ToolId
  /** Shown above the answer while the tool runs and after, e.g. "Kursy walut". */
  label: string
  definition: FunctionTool
  /** One line on what the model asked for, e.g. "100 EUR → PLN". */
  describe(args: Record<string, unknown>): string
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>
}

export function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  return typeof value === 'string' ? value.trim() : ''
}
