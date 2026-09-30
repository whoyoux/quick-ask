import { DatabaseSync } from 'node:sqlite'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import type { ConversationSummary } from '../../shared/types'
import { conversations, turns } from './schema'

// No Electron imports here: scripts/test-history.ts runs this module against a temporary file.

const TITLE_LENGTH = 60
const SNIPPET_LENGTH = 160
/** The window lists this many recent conversations; older ones are still found by search. */
const LIST_LIMIT = 500

export type StoredTurn = typeof turns.$inferSelect
export type TurnRecord = Omit<StoredTurn, 'id' | 'conversationId'>

/** Saved conversations in `<userData>/history.db`, one row per finished question. */
export class HistoryStore {
  private readonly client: DatabaseSync
  private readonly db: NodeSQLiteDatabase

  constructor(file: string, migrationsFolder: string) {
    this.client = new DatabaseSync(file)
    try {
      // Cascading deletes need foreign keys; secure_delete overwrites deleted text in the file.
      this.client.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON')
      // SQLite's LIKE only ignores the case of ASCII letters; search "łódź" should find "Łódź" too.
      this.client.function('fold', { deterministic: true }, (value) =>
        typeof value === 'string' ? value.toLowerCase() : value
      )
      this.db = drizzle({ client: this.client })
      migrate(this.db, { migrationsFolder })
    } catch (error) {
      this.client.close()
      throw error
    }
  }

  /** Stores a finished turn, creating its conversation on the first one. */
  saveTurn(conversationId: string, turn: TurnRecord): void {
    const now = Date.now()
    this.db.transaction((tx) => {
      tx.insert(conversations)
        .values({ id: conversationId, title: titleFrom(turn.question), createdAt: turn.createdAt, updatedAt: now })
        .onConflictDoUpdate({ target: conversations.id, set: { updatedAt: now } })
        .run()
      tx.insert(turns)
        .values({ ...turn, conversationId })
        .run()
    })
  }

  /** Most recently active first; `query` matches any question or answer. */
  list(query = ''): ConversationSummary[] {
    // Spelled out because Drizzle leaves column names unqualified in single-table queries,
    // and an unqualified `id` inside this subquery would mean the turn's id.
    const firstAnswer = sql<string | null>`(
      select substr(t.answer, 1, 400) from turns t
      where t.conversation_id = conversations.id and t.status = 'done'
      order by t.position limit 1
    )`
    const costUsd = sql<number | null>`(
      select sum(t.cost_usd) from turns t where t.conversation_id = conversations.id
    )`
    const tokens = sql<number | null>`(
      select sum(coalesce(t.input_tokens, 0) + coalesce(t.output_tokens, 0)) from turns t
      where t.conversation_id = conversations.id and (t.input_tokens is not null or t.output_tokens is not null)
    )`
    const needle = query.trim().toLowerCase()
    const pattern = `%${needle.replace(/[\\%_]/g, '\\$&')}%`
    const matching = this.db
      .select({ id: turns.conversationId })
      .from(turns)
      .where(sql`fold(${turns.question}) like ${pattern} escape '\\' or fold(${turns.answer}) like ${pattern} escape '\\'`)
    return this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
        costUsd,
        tokens,
        firstAnswer
      })
      .from(conversations)
      .where(needle ? inArray(conversations.id, matching) : undefined)
      .orderBy(desc(conversations.updatedAt))
      .limit(LIST_LIMIT)
      .all()
      .map(({ firstAnswer, ...row }) => ({ ...row, snippet: toSnippet(firstAnswer ?? '') }))
  }

  /** The conversation's turns in question order; empty if it doesn't exist. */
  turns(conversationId: string): StoredTurn[] {
    return this.db
      .select()
      .from(turns)
      .where(eq(turns.conversationId, conversationId))
      .orderBy(asc(turns.position), asc(turns.id))
      .all()
  }

  /** Deletes the conversation and returns the picture files it used, for the caller to remove. */
  delete(conversationId: string): string[] {
    const files = this.imageFiles(conversationId)
    this.db.delete(conversations).where(eq(conversations.id, conversationId)).run()
    return files
  }

  /** Deletes every conversation and returns the picture files they used. */
  clear(): string[] {
    const files = this.imageFiles()
    this.db.delete(conversations).run()
    return files
  }

  /** Picture files referenced by one conversation, or by all of them. */
  imageFiles(conversationId?: string): string[] {
    const rows = this.db
      .select({ attachments: turns.attachments, images: turns.images })
      .from(turns)
      .where(conversationId === undefined ? undefined : eq(turns.conversationId, conversationId))
      .all()
    return rows.flatMap((row) => [...(row.attachments ?? []), ...(row.images ?? [])])
  }

  close(): void {
    this.client.close()
  }
}

/** The first question, cut at a word boundary. */
export function titleFrom(question: string): string {
  const text = question.replace(/\s+/g, ' ').trim()
  if (text.length <= TITLE_LENGTH) return text
  const cut = text.slice(0, TITLE_LENGTH)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`
}

/** One line of plain text from a markdown answer. */
export function toSnippet(markdown: string): string {
  const text = markdown
    // Code blocks (and charts, which are JSON in a code block) say nothing in one line.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH).trimEnd()}…` : text
}
