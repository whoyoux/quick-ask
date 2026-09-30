import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Timestamps are epoch milliseconds. After editing this file run `npm run db:generate`.

export const conversations = sqliteTable(
  'conversations',
  {
    id: text().primaryKey(),
    /** The first question, shortened; no extra model call. */
    title: text().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [index('conversations_updated_at_idx').on(t.updatedAt)]
)

export const turns = sqliteTable(
  'turns',
  {
    id: integer().primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Order in which the questions were asked; may have gaps. */
    position: integer().notNull(),
    question: text().notNull(),
    answer: text().notNull(),
    status: text({ enum: ['done', 'error'] }).notNull(),
    error: text(),
    /** OpenRouter model slugs. */
    transcriptionModel: text('transcription_model').notNull(),
    chatModel: text('chat_model').notNull(),
    transcriptionMs: integer('transcription_ms'),
    firstTokenMs: integer('first_token_ms'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [
    index('turns_conversation_idx').on(t.conversationId, t.position),
    check('turns_status_check', sql`${t.status} in ('done', 'error')`)
  ]
)
