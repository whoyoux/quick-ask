// Runs model-written JavaScript in QuickJS compiled to WebAssembly. Inside there is no
// filesystem, network, timers, `require` or `process`: only the language, `console.log` and the
// `message` string. Memory, stack and time are limited, and every run gets a fresh VM. The
// thread keeps a busy script from freezing the app; the host kills it if it stops answering.
//
// Import nothing from sibling modules here: scripts/test-tools.ts starts this file as is.

import { parentPort, workerData } from 'node:worker_threads'
import { JSException, QuickJS } from 'quickjs-wasi'

export interface SandboxRequest {
  id: number
  code: string
  /** Plain data exposed to the script as global variables. */
  globals: Record<string, unknown>
  timeoutMs: number
}

export type SandboxReply =
  | { id: number; ok: true; result: string | null; logs: string[] }
  | { id: number; ok: false; error: string; logs: string[] }

const MEMORY_LIMIT = 64 * 1024 * 1024
const STACK_LIMIT = 512 * 1024
/** Enough for a table of results; more would only fill the model's context. */
const MAX_LOG_CHARS = 20_000

// Formats values the way a REPL would, inside the guest so its objects never cross over.
// Defined as non-enumerable globals so they don't show up in the script's own listings.
const PRELUDE = `(() => {
  const format = (value) => {
    if (typeof value === 'string') return value
    if (typeof value === 'bigint') return value.toString()
    if (value === undefined) return 'undefined'
    const seen = new WeakSet()
    const json = JSON.stringify(value, (key, v) => {
      if (typeof v === 'bigint') return v.toString()
      if (typeof v === 'number' && !Number.isFinite(v)) return String(v)
      if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']'
      if (typeof v === 'symbol') return v.toString()
      if (v instanceof Map) return Object.fromEntries(v)
      if (v instanceof Set) return [...v]
      if (v instanceof Error) return v.name + ': ' + v.message
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    }, 2)
    return json === undefined ? String(value) : json
  }
  const emit = globalThis.__emit
  delete globalThis.__emit
  const log = (...args) => emit(args.map(format).join(' '))
  globalThis.console = { log, info: log, warn: log, error: log, debug: log, table: (value) => emit(format(value)) }
  Object.defineProperty(globalThis, '__format', { value: format, enumerable: false })
})()`

// @types/node declares WebAssembly's types, not the global object; compile once, reuse per run.
declare const WebAssembly: { Module: new (bytes: Uint8Array) => WebAssembly.Module }
const wasm = new WebAssembly.Module(workerData.wasm as Uint8Array)

/** The limits are ours, so say so; everything else is the script's own error. */
function explain(message: string, timeoutMs: number): string {
  if (message === 'InternalError: interrupted') return `Przekroczono limit czasu (${timeoutMs / 1000} s). ${message}`
  if (message === 'InternalError: out of memory') return `Za mało pamięci (limit ${MEMORY_LIMIT / 1024 / 1024} MB). ${message}`
  return message
}

async function run(request: SandboxRequest): Promise<SandboxReply> {
  const logs: string[] = []
  let logChars = 0
  const deadline = Date.now() + request.timeoutMs
  const vm = await QuickJS.create({
    wasm,
    memoryLimit: MEMORY_LIMIT,
    maxStackSize: STACK_LIMIT,
    interruptHandler: () => Date.now() > deadline
  })
  try {
    const emit = vm.newFunction('__emit', (line) => {
      const text = String(vm.dump(line))
      if (logChars < MAX_LOG_CHARS) {
        logs.push(logChars + text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS - logChars)}… [ucięte]` : text)
      }
      logChars += text.length
      return vm.undefined
    })
    vm.setProp(vm.global, '__emit', emit)
    emit.dispose()
    vm.evalCode(PRELUDE, 'prelude.js').dispose()
    for (const [name, value] of Object.entries(request.globals)) {
      const handle = vm.hostToHandle(value)
      vm.setProp(vm.global, name, handle)
      handle.dispose()
    }

    const value = vm.evalCode(request.code, 'code.js')
    vm.setProp(vm.global, '__result', value)
    value.dispose()
    const formatted = vm.evalCode('__result === undefined ? null : __format(__result)', 'result.js')
    const result = vm.dump(formatted)
    formatted.dispose()
    return { id: request.id, ok: true, result: result === null ? null : String(result), logs }
  } catch (error) {
    if (!(error instanceof JSException)) {
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error), logs }
    }
    // Where in the script it failed helps the model fix it.
    const where = error.stack?.split('\n').find((line) => line.includes('code.js'))?.trim()
    const message = explain(`${error.name}: ${error.message}`, request.timeoutMs)
    error.dispose()
    return { id: request.id, ok: false, error: where ? `${message} (${where})` : message, logs }
  } finally {
    vm.dispose()
  }
}

parentPort?.on('message', (request: SandboxRequest) => {
  void run(request).then((reply) => parentPort?.postMessage(reply))
})
