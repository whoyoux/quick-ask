import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatUsd } from '../../shared/format'
import type { OverlayView, RecordingIndicator, Source, Turn } from '../../shared/types'
import iconUrl from '../assets/icon.svg'
import { Answer } from './Answer'
import { useLevels } from './levels'

const api = window.quickAsk

const INITIAL_VIEW: OverlayView = {
  mode: 'hidden',
  recording: null,
  notice: null,
  turns: [],
  hint: ''
}

// Frameless window: these areas move it, everything interactive inside must opt out.
const DRAG = '[-webkit-app-region:drag]'
const NO_DRAG = '[-webkit-app-region:no-drag]'

export function App() {
  const [view, setView] = useState(INITIAL_VIEW)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => api.onView(setView), [])

  // The transparent window follows the size of whatever is shown.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => api.resize({ width: root.offsetWidth, height: root.offsetHeight }))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // Esc closes the panel only once the user has clicked into it; elsewhere Esc belongs to other apps.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') api.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    // The padding leaves room for the shadow inside the transparent window.
    <div ref={rootRef} className="inline-block p-3">
      {view.mode === 'pill' && <Pill view={view} />}
      {view.mode === 'panel' && <Panel view={view} />}
    </div>
  )
}

// Recording pill ------------------------------------------------------------------------------

function Pill({ view }: { view: OverlayView }) {
  const { recording } = view
  return (
    <section
      className={`flex h-11 items-center gap-2.5 rounded-full border border-border bg-graphite px-4 whitespace-nowrap shadow-[0_6px_20px_rgb(0_0_0/0.3)] ${DRAG}`}
    >
      {recording ? (
        <>
          <LiveDot />
          <Meter height={20} />
          <Elapsed recording={recording} />
          <span>{recording.handsFree ? 'Słucham…' : 'Słucham… puść, aby wysłać'}</span>
          {recording.handsFree && (
            <span className={`ml-1 flex gap-1.5 ${NO_DRAG}`}>
              <Button variant="primary" onClick={() => api.sendNow()}>
                Wyślij
              </Button>
              <Button onClick={() => api.cancelRecording()}>Anuluj</Button>
            </span>
          )}
        </>
      ) : (
        <span>{view.notice}</span>
      )}
    </section>
  )
}

function LiveDot() {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-brand motion-safe:animate-live" />
}

function Meter({ height }: { height: number }) {
  const levels = useLevels()
  return (
    <span aria-hidden className="inline-flex items-center gap-[3px]" style={{ height }}>
      {levels.map((level, i) => (
        <i
          key={i}
          className="h-full w-[3px] rounded-sm bg-foreground transition-transform duration-75 ease-linear"
          style={{ transform: `scaleY(${0.18 + level * 0.82})` }}
        />
      ))}
    </span>
  )
}

function Elapsed({ recording }: { recording: RecordingIndicator }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - recording.startedAt) / 1000))
  return (
    <span className="min-w-8 text-muted-foreground tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

// Answer panel --------------------------------------------------------------------------------

function Panel({ view }: { view: OverlayView }) {
  const threadRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [copied, setCopied] = useState(false)

  // Follow the streaming answer unless the user scrolled up to read something.
  useLayoutEffect(() => {
    const thread = threadRef.current
    if (thread && followRef.current) thread.scrollTop = thread.scrollHeight
  }, [view.turns])

  const costs = view.turns.map((t) => t.costUsd).filter((c): c is number => c !== null)
  const conversationCost = costs.length > 0 ? costs.reduce((sum, c) => sum + c, 0) : null
  const last = view.turns.at(-1)
  const lastAnswer = last?.status === 'done' ? last.answer : ''

  const copy = (): void => {
    api.copy(lastAnswer)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <section className="flex w-[600px] flex-col overflow-hidden rounded-2xl border border-border bg-graphite shadow-[0_10px_32px_rgb(0_0_0/0.35)]">
      <header className={`flex h-10 items-center gap-2 border-b border-border pr-1.5 pl-4 ${DRAG}`}>
        <img src={iconUrl} alt="" className="size-4 rounded-[4px]" />
        <span className="text-xs text-muted-foreground">Quick Ask</span>
        {conversationCost !== null && (
          <span className="text-xs text-faint tabular-nums" title="Koszt tej rozmowy w OpenRouter">
            · {formatUsd(conversationCost)}
          </span>
        )}
        <span className={`ml-auto flex gap-0.5 ${NO_DRAG}`}>
          {lastAnswer && (
            <Button variant="ghost" onClick={copy}>
              {copied ? 'Skopiowano' : 'Kopiuj'}
            </Button>
          )}
          {view.turns.length > 0 && (
            <Button variant="ghost" onClick={() => api.newConversation()}>
              Nowa rozmowa
            </Button>
          )}
          <Button variant="ghost" label="Zamknij (aplikacja zostaje w tle)" onClick={() => api.close()}>
            <span className="text-base leading-none">×</span>
          </Button>
        </span>
      </header>

      <div
        ref={threadRef}
        aria-live="polite"
        className="overflow-y-auto px-5 pt-4 pb-3.5 select-text [scrollbar-color:rgb(255_255_255/0.14)_transparent]"
        style={{ maxHeight: Math.round(window.screen.availHeight * 0.6) }}
        onScroll={(event) => {
          const el = event.currentTarget
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {view.turns.length === 0 && <p className="py-2 text-muted-foreground">{view.hint}</p>}
        {view.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>

      <footer className={`flex min-h-9 items-center justify-between gap-3 border-t border-border py-1 pr-1.5 pl-5 ${DRAG}`}>
        <div className="min-w-0 truncate text-xs">
          {view.recording ? (
            <span className="inline-flex items-center gap-2 text-foreground">
              <LiveDot />
              <Meter height={14} />
              {view.recording.handsFree ? 'Słucham…' : 'Słucham… puść, aby wysłać'}
            </span>
          ) : view.notice ? (
            <span className="text-foreground">{view.notice}</span>
          ) : (
            <span className="text-faint">{view.hint}</span>
          )}
        </div>
        {view.recording?.handsFree && (
          <span className={`flex shrink-0 gap-1 ${NO_DRAG}`}>
            <Button variant="primary" onClick={() => api.sendNow()}>
              Wyślij
            </Button>
            <Button variant="ghost" onClick={() => api.cancelRecording()}>
              Anuluj
            </Button>
          </span>
        )}
      </footer>
    </section>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <article className="mt-3.5 border-t border-border pt-3.5 first:mt-0 first:border-t-0 first:pt-0">
      {turn.status === 'transcribing' ? (
        <p className="mb-2 text-[13px] text-faint motion-safe:animate-breathe">Rozpoznaję mowę…</p>
      ) : (
        <p className="mb-2 text-[13px] text-muted-foreground">{turn.question}</p>
      )}
      {turn.status === 'answering' && !turn.answer && (
        <p className="text-[15px] text-faint motion-safe:animate-breathe">Myślę…</p>
      )}
      {turn.answer && <Answer text={turn.answer} streaming={turn.status === 'answering'} />}
      {turn.sources.length > 0 && <Sources sources={turn.sources} />}
      {turn.error && <p className="mt-1.5 text-brand-light">{turn.error}</p>}
      {turn.status === 'done' && <Timing turn={turn} />}
    </article>
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`
}

/** Which models answered, how fast and for how much, to help pick models in the menu. */
function Timing({ turn }: { turn: Turn }) {
  const { timing, costUsd } = turn
  const parts: string[] = []
  if (timing.transcriptionMs !== null && timing.firstTokenMs !== null) {
    parts.push(
      `${timing.transcriptionModel} ${seconds(timing.transcriptionMs)} → ${timing.chatModel} ${seconds(timing.firstTokenMs)}`
    )
  }
  if (costUsd !== null) parts.push(formatUsd(costUsd))
  if (parts.length === 0) return null
  return <p className="mt-2 text-[11px] text-faint tabular-nums">{parts.join(' · ')}</p>
}

/** Pages the web search found; links open in the browser. */
function Sources({ sources }: { sources: Source[] }) {
  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]">
      <span className="text-faint">Źródła:</span>
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          title={source.url}
          className="max-w-56 truncate text-muted-foreground underline decoration-white/20 underline-offset-2 hover:text-foreground"
        >
          {source.title}
        </a>
      ))}
    </p>
  )
}

// Controls ------------------------------------------------------------------------------------

function Button({
  children,
  onClick,
  variant = 'outline',
  label
}: {
  children: ReactNode
  onClick: () => void
  variant?: 'outline' | 'ghost' | 'primary'
  label?: string
}) {
  const variants = {
    outline: 'border-border text-muted-foreground hover:bg-white/6 hover:text-foreground',
    ghost: 'border-transparent text-muted-foreground hover:bg-white/6 hover:text-foreground',
    primary: 'border-brand bg-brand text-white hover:bg-[#f04a50]'
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs ${variants[variant]}`}
    >
      {children}
    </button>
  )
}
