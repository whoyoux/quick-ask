// Checks the tools the chat model can call and the streamed tool calls they depend on, inside
// Electron's own Node runtime (like test-history). Public APIs are replaced by canned responses
// and OpenRouter by a local server, so the tests need no network and no key.
//
//   npm run test:tools

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

if (!process.versions.electron) {
  // Outside Electron, `require('electron')` is the path to its binary.
  const electron = createRequire(import.meta.url)('electron') as string
  const script = fileURLToPath(import.meta.url)
  const { status } = spawnSync(electron, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  process.exit(status ?? 1)
}

// The sources import siblings without extensions (the bundler resolves them); do the same here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const extensionless = /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)
    return nextResolve(extensionless && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context)
  }
})

// A local stand-in for OpenRouter; openrouter.ts reads this when it loads.
const requests: Record<string, unknown>[] = []
let reply: string[] = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const line of reply) res.write(`${line}\n\n`)
    res.end()
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
server.unref()
process.env.QUICK_ASK_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const { mock, test } = await import('node:test')
const assert = await import('node:assert/strict')
const { ReasoningCollector, streamChat } = await import('../src/main/openrouter.ts')
const { createCurrencyTool } = await import('../src/main/tools/currency.ts')
const { createWeatherTool, describeForecast } = await import('../src/main/tools/weather.ts')
const { createTimeTool, instantOf, offsetMinutes } = await import('../src/main/tools/time.ts')
const { JsSandbox } = await import('../src/main/tools/sandbox.ts')
const { ToolError } = await import('../src/main/tools/types.ts')

const context = (question = '') => ({ signal: new AbortController().signal, question, timeZone: 'Europe/Warsaw' })

/** Answers fetch() from a table of URL prefixes; anything else is a 404. */
function fakeFetch(routes: Record<string, unknown>): string[] {
  const seen: string[] = []
  mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = String(input)
    seen.push(url)
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    return match
      ? new Response(JSON.stringify(routes[match]), { status: 200 })
      : new Response('Not Found', { status: 404 })
  })
  return seen
}

// Streaming ------------------------------------------------------------------------------------

const sse = (event: unknown): string => `data: ${JSON.stringify(event)}`

test('streamed tool calls keep their ids and arguments, reasoning is rebuilt in order', async () => {
  reply = [
    ': OPENROUTER PROCESSING',
    sse({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Liczę ', index: 0 }] } }] }),
    sse({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'sumę.', index: 0 }] } }] }),
    sse({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', signature: 'sig', index: 0 }] } }] }),
    sse({
      choices: [
        {
          delta: {
            content: 'Chwila.',
            reasoning_details: [{ type: 'reasoning.encrypted', data: 'abc', id: 'tool_1', format: 'google-gemini-v1', index: 0 }],
            tool_calls: [{ index: 0, id: 'tool_1', type: 'function', function: { name: 'run_javascript', arguments: '{"co' } }]
          }
        }
      ]
    }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'de":"1+1"}' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'convert_time', arguments: '{}' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 5 } }),
    'data: [DONE]'
  ]
  const deltas: string[] = []
  const result = await streamChat({
    apiKey: 'test',
    model: 'google/gemini-3.8-flash',
    messages: [{ role: 'user', content: 'Ile to 1+1?' }],
    webSearch: false,
    functions: [{ name: 'run_javascript', description: '', parameters: {} }],
    toolChoice: 'none',
    onDelta: (text) => deltas.push(text),
    onSource: () => {}
  })
  assert.equal(result.text, 'Chwila.')
  assert.deepEqual(deltas, ['Chwila.'])
  assert.deepEqual(result.toolCalls, [
    { id: 'tool_1', name: 'run_javascript', arguments: '{"code":"1+1"}' },
    // Providers that leave out the id still get one to pair the result with.
    { id: 'call_1', name: 'convert_time', arguments: '{}' }
  ])
  assert.deepEqual(result.reasoningDetails, [
    { type: 'reasoning.text', text: 'Liczę sumę.', signature: 'sig', index: 0 },
    { type: 'reasoning.encrypted', data: 'abc', id: 'tool_1', format: 'google-gemini-v1', index: 0 }
  ])
  assert.equal(result.cost, 0.001)
  const sent = requests.at(-1) as { tool_choice?: string; tools?: unknown[] }
  assert.equal(sent.tool_choice, 'none')
  assert.equal(sent.tools?.length, 1)
})

test('reasoning fragments without an index stay separate blocks', () => {
  const collector = new ReasoningCollector()
  collector.add([{ type: 'reasoning.summary', summary: 'a' }])
  collector.add([{ type: 'reasoning.summary', summary: 'b' }])
  collector.add('not an array')
  assert.equal(collector.details().length, 2)
})

// JavaScript sandbox ----------------------------------------------------------------------------

const root = join(fileURLToPath(import.meta.url), '..', '..')
const wasm = readFileSync(join(root, 'node_modules/quickjs-wasi/quickjs.wasm'))
const workerFile = new URL('../src/main/tools/javascript.worker.ts', import.meta.url)
const sandbox = new JsSandbox(() => new Worker(workerFile, { workerData: { wasm } }))

test('the sandbox computes with the question as `message` and captures console.log', async () => {
  const outcome = await sandbox.run(
    'const rows = message.split("\\n").slice(1).map((l) => l.split(";")); console.log(rows.length, "wierszy"); rows.reduce((s, r) => s + Number(r[1]), 0)',
    { message: 'nazwa;kwota\na;10.5\nb;20\nc;0.25' },
    2000,
    new AbortController().signal
  )
  assert.deepEqual(outcome, { ok: true, result: '30.75', error: null, logs: ['3 wierszy'] })
})

test('the sandbox has no Node, network or timers and reports errors with their place', async () => {
  const signal = new AbortController().signal
  const escape = await sandbox.run('[typeof process, typeof require, typeof fetch, typeof setTimeout].join()', {}, 2000, signal)
  assert.equal(escape.result, 'undefined,undefined,undefined,undefined')
  const failed = await sandbox.run('const x = 1;\nx.y.z', {}, 2000, signal)
  assert.equal(failed.ok, false)
  assert.match(failed.error ?? '', /^TypeError: .*code\.js:2/)
})

test('the sandbox stops endless loops and memory hogs, then keeps working', async () => {
  const signal = new AbortController().signal
  const loop = await sandbox.run('for (;;) {}', {}, 300, signal)
  assert.match(loop.error ?? '', /limit czasu/)
  const hog = await sandbox.run('const a = []; for (;;) a.push(new Array(1e5).fill(1))', {}, 5000, signal)
  assert.match(hog.error ?? '', /pamięci/)
  const after = await sandbox.run('2n ** 64n', {}, 2000, signal)
  assert.equal(after.result, '18446744073709551616')
})

test('a worker that never answers is killed after the time limit', async () => {
  const silent = new JsSandbox(() => new Worker('setInterval(() => {}, 1000)', { eval: true }))
  const outcome = await silent.run('1', {}, 100, new AbortController().signal)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /limit czasu/)
})

test('aborting a run (new conversation) rejects it at once', async () => {
  const controller = new AbortController()
  const running = sandbox.run('for (;;) {}', {}, 5000, controller.signal)
  setTimeout(() => controller.abort(new Error('nowa rozmowa')), 50)
  await assert.rejects(running, /nowa rozmowa/)
  assert.equal((await sandbox.run('1 + 1', {}, 2000, new AbortController().signal)).result, '2')
  sandbox.stop()
})

// Currency ---------------------------------------------------------------------------------------

const NBP = 'https://api.nbp.pl/api/exchangerates/rates'
const rate = (code: string, mid: number, date = '2026-09-29', no = '189/A/NBP/2026') => ({
  code,
  rates: [{ no, effectiveDate: date, mid }]
})

test('currency: converts through PLN at NBP average rates and cites NBP', async (t) => {
  t.after(() => mock.restoreAll())
  fakeFetch({ [`${NBP}/a/eur/last/1/`]: rate('EUR', 4.25), [`${NBP}/a/usd/last/1/`]: rate('USD', 4) })
  const tool = createCurrencyTool(() => new Date('2026-09-30T10:00:00Z'))
  const out = await tool.run({ amount: 100, from: 'eur', to: 'USD' }, context())
  assert.match(out.content, /^100 EUR = 106\.25 USD$/m)
  assert.match(out.content, /1 EUR = 4\.2500 PLN \(tabela 189\/A\/NBP\/2026 z 2026-09-29\)/)
  assert.equal(out.sources?.[0].url, 'https://api.nbp.pl/')
  const toPln = await tool.run({ from: 'EUR', to: 'PLN' }, context())
  assert.match(toPln.content, /^1 EUR = 4\.25 PLN$/m)
})

test('currency: falls back to table B and looks back from a past date', async (t) => {
  t.after(() => mock.restoreAll())
  const seen = fakeFetch({ [`${NBP}/b/aed/2026-05-17/2026-06-02/`]: rate('AED', 1.02, '2026-05-27', '021/B/NBP/2026') })
  const tool = createCurrencyTool(() => new Date('2026-09-30T10:00:00Z'))
  const out = await tool.run({ amount: 50, from: 'AED', to: 'PLN', date: '2026-06-02' }, context())
  assert.deepEqual(
    seen.map((url) => url.slice(NBP.length)),
    ['/a/aed/2026-05-23/2026-06-02/?format=json', '/b/aed/2026-05-17/2026-06-02/?format=json']
  )
  assert.match(out.content, /^50 AED = 51\.00 PLN$/m)
  assert.match(out.content, /z 2026-05-27/)
})

test('currency: a future date means the latest rate; bad input is explained', async (t) => {
  t.after(() => mock.restoreAll())
  const seen = fakeFetch({ [`${NBP}/a/eur/last/1/`]: rate('EUR', 4.25) })
  const tool = createCurrencyTool(() => new Date('2026-09-30T10:00:00Z'))
  await tool.run({ from: 'EUR', to: 'PLN', date: '2027-01-01' }, context())
  assert.ok(seen[0].includes('/last/1/'))
  await assert.rejects(tool.run({ from: 'euro', to: 'PLN' }, context()), ToolError)
  await assert.rejects(tool.run({ from: 'BTC', to: 'PLN' }, context()), /Kryptowalut/)
  await assert.rejects(tool.run({ from: 'EUR', to: 'PLN', date: '31.12.2025' }, context()), /RRRR-MM-DD/)
})

// Weather ----------------------------------------------------------------------------------------

test('weather: finds the place, then reads current conditions and the daily forecast', async (t) => {
  t.after(() => mock.restoreAll())
  const seen = fakeFetch({
    'https://geocoding-api.open-meteo.com/v1/search': {
      results: [{ name: 'Kraków', latitude: 50.06, longitude: 19.94, country: 'Polska', admin1: 'małopolskie' }]
    },
    'https://api.open-meteo.com/v1/forecast': {
      timezone: 'Europe/Warsaw',
      current: { time: '2026-09-30T12:00', temperature_2m: 14.24, apparent_temperature: 12.9, relative_humidity_2m: 71, precipitation: 0, weather_code: 3, wind_speed_10m: 12, wind_gusts_10m: 25 },
      daily: {
        time: ['2026-09-30', '2026-10-01'],
        weather_code: [3, 61],
        temperature_2m_min: [8.1, 7],
        temperature_2m_max: [15.3, 12],
        precipitation_sum: [0, 4.2],
        precipitation_probability_max: [10, 80],
        wind_speed_10m_max: [18, 30]
      }
    }
  })
  const out = await createWeatherTool().run({ location: 'Kraków', country_code: 'pl', days: 2 }, context())
  const geocoding = new URL(seen[0])
  assert.equal(geocoding.searchParams.get('name'), 'Kraków')
  assert.equal(geocoding.searchParams.get('countryCode'), 'PL')
  assert.equal(new URL(seen[1]).searchParams.get('forecast_days'), '2')
  assert.match(out.content, /Kraków, małopolskie, Polska/)
  assert.match(out.content, /Teraz \(2026-09-30 12:00\): 14\.2 °C, odczuwalna 12\.9 °C, pochmurno/)
  assert.match(out.content, /- 2026-10-01: 7…12 °C, słaby deszcz, opad 4\.2 mm \(szansa 80%\)/)
  assert.equal(out.sources?.[0].title, 'Open-Meteo')
})

test('weather: an unknown place is explained, unknown codes still show', async (t) => {
  t.after(() => mock.restoreAll())
  fakeFetch({ 'https://geocoding-api.open-meteo.com/v1/search': {} })
  await assert.rejects(createWeatherTool().run({ location: 'Xyzzy' }, context()), /Nie znalazłem/)
  assert.match(describeForecast({ name: 'X' }, { current: { weather_code: 42 } }), /kod pogody 42/)
})

// Time zones -------------------------------------------------------------------------------------

test('time: offsets follow daylight saving time', () => {
  assert.equal(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Europe/Warsaw'), 120)
  assert.equal(offsetMinutes(Date.parse('2026-12-01T12:00:00Z'), 'Europe/Warsaw'), 60)
  assert.equal(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Asia/Kolkata'), 330)
  // Warsaw leaves summer time on 2026-10-25 at 03:00; 04:00 local is then UTC+1.
  assert.equal(instantOf({ year: 2026, month: 10, day: 25, hour: 4, minute: 0 }, 'Europe/Warsaw'), Date.parse('2026-10-25T03:00:00Z'))
  assert.equal(instantOf({ year: 2026, month: 3, day: 1, hour: 9, minute: 30 }, 'America/New_York'), Date.parse('2026-03-01T14:30:00Z'))
})

test('time: converts a meeting time and the current time between zones', async () => {
  const tool = createTimeTool(() => Date.parse('2026-09-30T16:15:00Z'))
  const meeting = await tool.run(
    { time: '2026-11-02T15:00', from_time_zone: 'Europe/Warsaw', to_time_zones: ['America/New_York', 'Asia/Tokyo'] },
    context()
  )
  assert.match(meeting.content, /America\/New_York: poniedziałek, 2 listopada 2026 09:00 \(UTC−05:00\)/)
  assert.match(meeting.content, /Asia\/Tokyo: poniedziałek, 2 listopada 2026 23:00 \(UTC\+09:00\)/)
  const now = await tool.run({ to_time_zones: ['America/Los_Angeles'] }, context())
  assert.match(now.content, /Europe\/Warsaw: środa, 30 września 2026 18:15 \(UTC\+02:00\)/)
  assert.match(now.content, /America\/Los_Angeles: środa, 30 września 2026 09:15 \(UTC−07:00\)/)
  const today = await tool.run({ time: '08:00', to_time_zones: ['UTC'] }, context())
  assert.match(today.content, /UTC: środa, 30 września 2026 06:00/)
})

test('time: unknown zones and impossible dates are explained', async () => {
  const tool = createTimeTool()
  await assert.rejects(tool.run({ to_time_zones: ['Mars/Olympus'] }, context()), /IANA/)
  await assert.rejects(tool.run({ time: '2026-02-30T10:00', to_time_zones: ['UTC'] }, context()), /prawidłową/)
  await assert.rejects(tool.run({ to_time_zones: [] }, context()), /Nie podano/)
})
