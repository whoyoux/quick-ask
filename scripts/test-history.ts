// Checks the conversation history database (migrations, save, list, search, delete) inside
// Electron's own Node runtime, so node:sqlite behaves exactly as in the app. Electron runs as
// plain Node: no window opens. Every test uses a fresh file in the temp folder.
//
//   npm run test:history

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const { DatabaseSync } = await import('node:sqlite')
const { mock, test } = await import('node:test')
const assert = await import('node:assert/strict')
const { HistoryStore, titleFrom, toSnippet } = await import('../src/main/db/history.ts')
type TurnRecord = import('../src/main/db/history.ts').TurnRecord

const root = join(fileURLToPath(import.meta.url), '..', '..')
const migrations = join(root, 'drizzle')

function tempDb(): { file: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'quick-ask-history-test-'))
  return { file: join(dir, 'history.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function turn(position: number, question: string, answer: string, extra: Partial<TurnRecord> = {}): TurnRecord {
  return {
    position,
    question,
    answer,
    status: 'done',
    error: null,
    transcriptionModel: 'openai/whisper-large-v3-turbo',
    chatModel: 'google/gemini-3.8-flash',
    transcriptionMs: 420,
    firstTokenMs: 610,
    costUsd: null,
    sources: null,
    inputTokens: null,
    outputTokens: null,
    attachments: null,
    images: null,
    createdAt: Date.now(),
    ...extra
  }
}

function count(file: string, table: string): number {
  const raw = new DatabaseSync(file, { readOnly: true })
  const row = raw.prepare(`select count(*) as n from ${table}`).get() as { n: number }
  raw.close()
  return row.n
}

test('migrations create the schema once', () => {
  const { file, cleanup } = tempDb()
  try {
    new HistoryStore(file, migrations).close()
    new HistoryStore(file, migrations).close()
    assert.equal(count(file, '__drizzle_migrations'), readdirSync(migrations).length)
    assert.equal(count(file, 'conversations'), 0)
    assert.equal(count(file, 'turns'), 0)
  } finally {
    cleanup()
  }
})

test('costs add up per conversation and sources come back as saved', () => {
  const { file, cleanup } = tempDb()
  const store = new HistoryStore(file, migrations)
  try {
    const sources = [{ url: 'https://example.com/a', title: 'Przykład' }]
    store.saveTurn('c1', turn(0, 'Kurs euro?', '4,25 zł.', { costUsd: 0.0012, sources, inputTokens: 100, outputTokens: 20 }))
    store.saveTurn('c1', turn(1, 'A dolara?', '3,90 zł.', { costUsd: 0.0008, inputTokens: 150 }))
    store.saveTurn('c2', turn(0, 'Bez kosztu', 'Odpowiedź.'))
    const byId = new Map(store.list().map((c) => [c.id, c.costUsd]))
    assert.equal(store.list().find((c) => c.id === 'c1')?.tokens, 270)
    assert.equal(store.list().find((c) => c.id === 'c2')?.tokens, null)
    assert.ok(Math.abs((byId.get('c1') ?? 0) - 0.002) < 1e-12)
    assert.equal(byId.get('c2'), null)
    assert.deepEqual(
      store.turns('c1').map((t) => t.sources),
      [sources, null]
    )
  } finally {
    store.close()
    cleanup()
  }
})

test('deleting returns the picture files the conversation used', () => {
  const { file, cleanup } = tempDb()
  const store = new HistoryStore(file, migrations)
  try {
    store.saveTurn('c1', turn(0, 'Narysuj kota', '', { attachments: ['a.png'], images: ['b.png', 'c.png'] }))
    store.saveTurn('c2', turn(0, 'Inna', 'x', { images: ['d.png'] }))
    assert.deepEqual(store.imageFiles().sort(), ['a.png', 'b.png', 'c.png', 'd.png'])
    assert.deepEqual(store.delete('c1'), ['a.png', 'b.png', 'c.png'])
    assert.deepEqual(store.clear(), ['d.png'])
    assert.deepEqual(store.imageFiles(), [])
  } finally {
    store.close()
    cleanup()
  }
})

test('saving turns creates the conversation, keeps its title and bumps updated_at', () => {
  const { file, cleanup } = tempDb()
  mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const store = new HistoryStore(file, migrations)
  try {
    store.saveTurn('c1', turn(0, 'Jaka jest stolica Australii?', 'Canberra.', { createdAt: 900 }))
    mock.timers.setTime(5_000)
    store.saveTurn('c1', turn(1, 'A ile ma mieszkańców?', 'Około 470 tysięcy.', { createdAt: 4_000 }))

    const [summary] = store.list()
    assert.deepEqual(summary, {
      id: 'c1',
      title: 'Jaka jest stolica Australii?',
      updatedAt: 5_000,
      costUsd: null,
      tokens: null,
      snippet: 'Canberra.'
    })
    const saved = store.turns('c1')
    assert.deepEqual(
      saved.map((t) => [t.position, t.question, t.chatModel, t.transcriptionMs, t.firstTokenMs]),
      [
        [0, 'Jaka jest stolica Australii?', 'google/gemini-3.8-flash', 420, 610],
        [1, 'A ile ma mieszkańców?', 'google/gemini-3.8-flash', 420, 610]
      ]
    )
  } finally {
    mock.timers.reset()
    store.close()
    cleanup()
  }
})

test('turns come back in question order and keep errors', () => {
  const { file, cleanup } = tempDb()
  const store = new HistoryStore(file, migrations)
  try {
    // A follow-up can finish before the question asked just before it.
    store.saveTurn('c1', turn(2, 'Trzecie', 'C'))
    store.saveTurn('c1', turn(0, 'Pierwsze', '', { status: 'error', error: 'Brak środków', firstTokenMs: null }))
    store.saveTurn('c1', turn(1, 'Drugie', 'B'))
    const saved = store.turns('c1')
    assert.deepEqual(saved.map((t) => t.question), ['Pierwsze', 'Drugie', 'Trzecie'])
    assert.equal(saved[0].status, 'error')
    assert.equal(saved[0].error, 'Brak środków')
    assert.equal(saved[0].firstTokenMs, null)
    // The title comes from the first saved turn, the snippet from the first answered one.
    assert.equal(store.list()[0].title, 'Trzecie')
    assert.equal(store.list()[0].snippet, 'B')
    assert.deepEqual(store.turns('missing'), [])
  } finally {
    store.close()
    cleanup()
  }
})

test('list is newest first', () => {
  const { file, cleanup } = tempDb()
  mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const store = new HistoryStore(file, migrations)
  try {
    store.saveTurn('old', turn(0, 'Stare pytanie', 'a'))
    mock.timers.setTime(2_000)
    store.saveTurn('new', turn(0, 'Nowe pytanie', 'b'))
    assert.deepEqual(store.list().map((c) => c.id), ['new', 'old'])
    // Continuing the old conversation moves it to the top.
    mock.timers.setTime(3_000)
    store.saveTurn('old', turn(1, 'Dopytanie', 'c'))
    assert.deepEqual(store.list().map((c) => c.id), ['old', 'new'])
  } finally {
    mock.timers.reset()
    store.close()
    cleanup()
  }
})

test('search matches questions and answers, ignoring case, including Polish letters', () => {
  const { file, cleanup } = tempDb()
  const store = new HistoryStore(file, migrations)
  try {
    store.saveTurn('lodz', turn(0, 'Ile osób mieszka w Łodzi?', 'Około 650 tysięcy.'))
    store.saveTurn('rabat', turn(0, 'Co to jest rabat?', 'Zniżka 100% nie jest typowa, zwykle 5_10.'))
    store.saveTurn('kod', turn(0, 'Jak odwrócić listę?', 'Użyj `reversed()` w **Pythonie**.'))

    const ids = (query: string): string[] => store.list(query).map((c) => c.id).sort()
    assert.deepEqual(ids('łodzi'), ['lodz'])
    assert.deepEqual(ids('ŁODZI'), ['lodz'])
    assert.deepEqual(ids('650 TYSIĘCY'), ['lodz'])
    assert.deepEqual(ids('pythonie'), ['kod'])
    assert.deepEqual(ids('  rabat  '), ['rabat'])
    // LIKE wildcards in the query are plain characters.
    assert.deepEqual(ids('100%'), ['rabat'])
    assert.deepEqual(ids('%'), ['rabat'])
    assert.deepEqual(ids('5_1'), ['rabat'])
    assert.deepEqual(ids('_'), ['rabat'])
    assert.deepEqual(ids('nie ma takiego'), [])
    assert.deepEqual(ids(''), ['kod', 'lodz', 'rabat'])
  } finally {
    store.close()
    cleanup()
  }
})

test('deleting a conversation removes its turns', () => {
  const { file, cleanup } = tempDb()
  const store = new HistoryStore(file, migrations)
  try {
    store.saveTurn('a', turn(0, 'A1', 'a'))
    store.saveTurn('a', turn(1, 'A2', 'a'))
    store.saveTurn('b', turn(0, 'B1', 'b'))
    store.delete('a')
    assert.deepEqual(store.list().map((c) => c.id), ['b'])
    assert.deepEqual(store.turns('a'), [])
    assert.equal(count(file, 'turns'), 1)

    store.clear()
    assert.deepEqual(store.list(), [])
    assert.equal(count(file, 'turns'), 0)
  } finally {
    store.close()
    cleanup()
  }
})

test('the database rejects unknown turn statuses', () => {
  const { file, cleanup } = tempDb()
  const store = new HistoryStore(file, migrations)
  try {
    assert.throws(() => store.saveTurn('c', turn(0, 'Pytanie', '', { status: 'answering' as 'done' })))
    // The failed turn rolled back the conversation it would have created.
    assert.deepEqual(store.list(), [])
  } finally {
    store.close()
    cleanup()
  }
})

test('titles are cut at a word boundary', () => {
  assert.equal(titleFrom('  Krótkie\npytanie  '), 'Krótkie pytanie')
  const long = 'Jak działa fotosynteza u roślin i dlaczego liście zmieniają kolor jesienią, zanim opadną?'
  const title = titleFrom(long)
  assert.ok(title.length <= 61, title)
  assert.ok(title.endsWith('…'))
  assert.ok(long.startsWith(title.slice(0, -1)))
  assert.equal(titleFrom('x'.repeat(80)), `${'x'.repeat(60)}…`)
})

test('snippets are one line of plain text', () => {
  assert.equal(toSnippet('# Nagłówek\n\n**Pogrubienie** i `kod`.\n- punkt\n> cytat'), 'Nagłówek Pogrubienie i kod. punkt cytat')
  assert.equal(toSnippet('Zobacz [dokumentację](https://example.com).'), 'Zobacz dokumentację.')
  assert.ok(toSnippet('słowo '.repeat(100)).length <= 161)
})
