import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import wasmPath from 'quickjs-wasi/quickjs.wasm?asset'
import workerPath from './javascript.worker?modulePath'
import { JsSandbox } from './sandbox'
import { stringArg, ToolError, type LocalTool } from './types'

const TIMEOUT_MS = 5000
/** What goes back to the model; a longer result would only fill its context. */
const MAX_OUTPUT_CHARS = 20_000

let wasm: Uint8Array | null = null

// A worker thread can't count on reading inside app.asar, so its script ships unpacked next to
// it (electron-builder.yml), and the wasm is read here, where Electron can read the archive.
const unpackedWorker = workerPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
const sandbox = new JsSandbox(() => new Worker(unpackedWorker, { workerData: { wasm: (wasm ??= readFileSync(wasmPath)) } }))

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}… [ucięte, ${text.length} znaków]` : text
}

export function formatRun(result: string | null, logs: string[]): string {
  const parts = [`Wynik: ${result ?? 'undefined (brak wartości ostatniego wyrażenia)'}`]
  if (logs.length > 0) parts.push(`console.log:\n${logs.join('\n')}`)
  return clip(parts.join('\n'))
}

export function createJavaScriptTool(): LocalTool {
  return {
    id: 'code',
    label: 'Obliczenia',
    definition: {
      name: 'run_javascript',
      description:
        "Runs JavaScript in an isolated sandbox and returns the value of the last expression (no top-level return) and console.log output. Use it for exact arithmetic, percentages, statistics, date differences, counting, sorting, and for processing data the user gave: lists, tables, CSV, JSON, text. No network, files, timers or Intl; every run starts fresh. The global string `message` holds the user's whole latest message: parse pasted data from it instead of copying the data into the code. Use BigInt for integers above 2^53.",
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'The script. Its last expression is the result.' } },
        required: ['code']
      }
    },
    describe: (args) => stringArg(args, 'code'),
    async run(args, { signal, question }) {
      const code = stringArg(args, 'code')
      if (!code) throw new ToolError('Model nie podał kodu do uruchomienia.')
      const outcome = await sandbox.run(code, { message: question }, TIMEOUT_MS, signal)
      if (!outcome.ok) {
        throw new ToolError(clip([outcome.error ?? 'Błąd', ...(outcome.logs.length ? [`console.log:\n${outcome.logs.join('\n')}`] : [])].join('\n')))
      }
      return { content: formatRun(outcome.result, outcome.logs) }
    }
  }
}
