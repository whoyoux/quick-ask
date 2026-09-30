// Host side of the JavaScript sandbox: one worker thread, started on first use and stopped
// when idle. No bundler imports here, so scripts/test-tools.ts can start the worker itself.

import type { Worker } from 'node:worker_threads'
import type { SandboxReply, SandboxRequest } from './javascript.worker'

/** Extra time the worker gets to report a timeout itself before it is killed. */
const GRACE_MS = 2000
/** An idle worker holds a few MB; start it again when needed. */
const IDLE_MS = 120_000

export interface SandboxResult {
  ok: boolean
  /** The value of the script's last expression, formatted; null when it was undefined. */
  result: string | null
  error: string | null
  logs: string[]
}

interface Pending {
  resolve(result: SandboxResult): void
  reject(error: unknown): void
}

export class JsSandbox {
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: NodeJS.Timeout | null = null
  private readonly spawn: () => Worker

  /** `spawn` starts a worker running javascript.worker.ts with the QuickJS wasm in `workerData.wasm`. */
  constructor(spawn: () => Worker) {
    this.spawn = spawn
  }

  run(code: string, globals: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<SandboxResult> {
    signal.throwIfAborted()
    const worker = this.start()
    const id = this.nextId++
    return new Promise<SandboxResult>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(watchdog)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        if (this.pending.size === 0) this.scheduleIdleStop()
      }
      // A script stuck where the interrupt handler can't reach it (or a crashed VM) costs the
      // whole worker; the next run starts a fresh one.
      const watchdog = setTimeout(() => {
        done()
        this.stop()
        resolve({ ok: false, result: null, error: `Przekroczono limit czasu (${timeoutMs / 1000} s).`, logs: [] })
      }, timeoutMs + GRACE_MS)
      const onAbort = (): void => {
        done()
        this.stop()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (result) => {
          done()
          resolve(result)
        },
        reject: (error) => {
          done()
          reject(error)
        }
      })
      const request: SandboxRequest = { id, code, globals, timeoutMs }
      worker.postMessage(request)
    })
  }

  stop(): void {
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = null
    if (!worker) return
    void worker.terminate()
    this.failAll(new Error('Sandbox JavaScript został zatrzymany.'))
  }

  private start(): Worker {
    this.clearIdleTimer()
    if (this.worker) return this.worker
    const worker = this.spawn()
    worker.unref()
    worker.on('message', (reply: SandboxReply) => {
      const pending = this.pending.get(reply.id)
      if (!pending) return
      pending.resolve(
        reply.ok
          ? { ok: true, result: reply.result, error: null, logs: reply.logs }
          : { ok: false, result: null, error: reply.error, logs: reply.logs }
      )
    })
    const lost = (error: unknown): void => {
      if (this.worker !== worker) return
      this.worker = null
      this.failAll(error instanceof Error ? error : new Error(`Sandbox JavaScript zakończył działanie (${String(error)}).`))
    }
    worker.on('error', lost)
    worker.on('exit', (code) => lost(code))
    this.worker = worker
    return worker
  }

  private failAll(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) p.reject(error)
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
