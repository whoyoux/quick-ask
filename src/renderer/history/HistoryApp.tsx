import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversationSummary, HistoryList } from '../../shared/types'

const api = window.quickAsk

const SEARCH_DELAY_MS = 150

const timeFormat = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })
const dateWithYearFormat = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabel(date: Date, now: Date): string {
  if (dayKey(date) === dayKey(now)) return 'Dziś'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (dayKey(date) === dayKey(yesterday)) return 'Wczoraj'
  const label = (date.getFullYear() === now.getFullYear() ? dateFormat : dateWithYearFormat).format(date)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

interface DayGroup {
  label: string
  conversations: ConversationSummary[]
}

/** The list comes newest first, so each day is one run of consecutive conversations. */
function groupByDay(conversations: ConversationSummary[], now: Date): DayGroup[] {
  const groups: DayGroup[] = []
  let lastKey = ''
  for (const conversation of conversations) {
    const date = new Date(conversation.updatedAt)
    if (dayKey(date) !== lastKey) {
      lastKey = dayKey(date)
      groups.push({ label: dayLabel(date, now), conversations: [] })
    }
    groups[groups.length - 1].conversations.push(conversation)
  }
  return groups
}

export function HistoryApp() {
  const [query, setQuery] = useState('')
  const [list, setList] = useState<HistoryList | null>(null)
  const [failed, setFailed] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const queryRef = useRef(query)
  const latestRequest = useRef(0)

  const load = useCallback((text: string) => {
    // Typing fires several searches; only the newest one may update the list.
    const request = ++latestRequest.current
    api.list(text).then(
      (result) => {
        if (request !== latestRequest.current) return
        setList(result)
        setFailed(false)
      },
      () => {
        if (request === latestRequest.current) setFailed(true)
      }
    )
  }, [])

  const refresh = useCallback(() => load(queryRef.current), [load])

  useEffect(() => {
    queryRef.current = query
    const timer = window.setTimeout(() => load(query), query ? SEARCH_DELAY_MS : 0)
    return () => window.clearTimeout(timer)
  }, [query, load])

  // Answers keep getting saved while the window is open.
  useEffect(() => api.onChange(refresh), [refresh])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (queryRef.current) setQuery('')
      else api.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const open = (id: string): void => {
    // On success the main process closes this window; a miss means it was deleted meanwhile.
    api.open(id).then(
      (opened) => {
        if (!opened) refresh()
      },
      () => setFailed(true)
    )
  }

  const remove = (id: string): void => {
    api.remove(id).then(refresh, () => setFailed(true))
  }

  const clear = (): void => {
    setConfirmingClear(false)
    api.clear().then(refresh, () => setFailed(true))
  }

  const conversations = list?.conversations ?? []
  const searching = query.trim() !== ''
  const unavailable = failed || list?.available === false

  return (
    <main className="flex h-screen flex-col">
      <header className="border-b border-border p-4">
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Szukaj w pytaniach i odpowiedziach"
          aria-label="Szukaj w historii rozmów"
          spellCheck={false}
          maxLength={200}
          className="w-full rounded-lg border border-input bg-raised px-3 py-2 placeholder:text-faint focus:border-brand focus:outline-none"
        />
        {list?.available && !list.saving && (
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            Zapisywanie historii jest wyłączone. Włączysz je w menu ikony Quick Ask.
          </p>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-2 [scrollbar-color:rgb(255_255_255/0.14)_transparent]">
        {unavailable ? (
          <Empty>Nie udało się otworzyć historii rozmów.</Empty>
        ) : list && conversations.length === 0 ? (
          <Empty>{searching ? 'Nic nie znaleziono.' : 'Nie ma jeszcze zapisanych rozmów.'}</Empty>
        ) : (
          groupByDay(conversations, new Date()).map((group) => (
            <section key={group.label} className="mb-1.5">
              <h2 className="px-3 pt-2 pb-1 text-xs font-medium text-faint">{group.label}</h2>
              <ul>
                {group.conversations.map((conversation) => (
                  <Row
                    key={conversation.id}
                    conversation={conversation}
                    onOpen={() => open(conversation.id)}
                    onRemove={() => remove(conversation.id)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <footer className="flex min-h-14 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        {confirmingClear ? (
          <>
            <p role="alert" className="text-[13px]">
              Usunąć wszystkie zapisane rozmowy? Tego nie da się cofnąć.
            </p>
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={clear}
                className="rounded-lg bg-brand px-3 py-1.5 font-medium text-white hover:bg-[#f04a50]"
              >
                Usuń wszystko
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmingClear(false)}
                className="rounded-lg border border-border px-3 py-1.5 hover:bg-white/6"
              >
                Anuluj
              </button>
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={unavailable || !list || (!searching && conversations.length === 0)}
              onClick={() => setConfirmingClear(true)}
              className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-white/6 hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent"
            >
              Usuń całą historię
            </button>
            <button
              type="button"
              onClick={() => api.close()}
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 hover:bg-white/6"
            >
              Zamknij
            </button>
          </>
        )}
      </footer>
    </main>
  )
}

function Row({
  conversation,
  onOpen,
  onRemove
}: {
  conversation: ConversationSummary
  onOpen: () => void
  onRemove: () => void
}) {
  return (
    <li className="group flex items-center rounded-lg focus-within:bg-white/6 hover:bg-white/6">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-medium">{conversation.title}</span>
          <span className="shrink-0 text-xs text-faint tabular-nums">{timeFormat.format(conversation.updatedAt)}</span>
        </span>
        <span className={`mt-0.5 block truncate text-[13px] ${conversation.snippet ? 'text-muted-foreground' : 'text-faint'}`}>
          {conversation.snippet || 'Bez odpowiedzi'}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Usuń rozmowę „${conversation.title}”`}
        title="Usuń rozmowę"
        className="mr-1.5 shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-white/8 hover:text-foreground"
      >
        Usuń
      </button>
    </li>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-10 text-center text-muted-foreground">{children}</p>
}
