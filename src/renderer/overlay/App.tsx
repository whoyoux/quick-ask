import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { OverlayView, RecordingIndicator, Turn } from '../../shared/types'
import { Answer } from './Answer'
import { useLevels } from './levels'

const api = window.quickAsk

const INITIAL_VIEW: OverlayView = {
  mode: 'hidden',
  recording: null,
  notice: null,
  turns: [],
  pinned: false,
  hint: ''
}

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
    <section className="flex h-11 items-center gap-2.5 rounded-full border border-border bg-graphite/96 px-4 whitespace-nowrap shadow-[0_8px_28px_rgb(0_0_0/0.35)]">
      {recording ? (
        <>
          <LiveDot />
          <Meter height={20} />
          <Elapsed recording={recording} />
          <span>{recording.handsFree ? 'Słucham…' : 'Słucham… puść, aby wysłać'}</span>
          {recording.handsFree && (
            <span className="ml-1 flex gap-1.5">
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

  const last = view.turns.at(-1)
  const lastAnswer = last?.status === 'done' ? last.answer : ''

  const copy = (): void => {
    api.copy(lastAnswer)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <section className="flex w-[600px] flex-col overflow-hidden rounded-2xl border border-border bg-graphite/96 shadow-[0_16px_48px_rgb(0_0_0/0.45)]">
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
        {view.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>

      <footer className="flex min-h-10 items-center justify-between gap-3 border-t border-border py-1.5 pr-2 pl-5">
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
        <div className="flex shrink-0 gap-0.5">
          {view.recording?.handsFree && (
            <Button variant="primary" onClick={() => api.sendNow()}>
              Wyślij
            </Button>
          )}
          {lastAnswer && (
            <Button variant="ghost" onClick={copy}>
              {copied ? 'Skopiowano' : 'Kopiuj'}
            </Button>
          )}
          <Button variant="ghost" pressed={view.pinned} onClick={() => api.togglePin()}>
            {view.pinned ? 'Przypięte' : 'Przypnij'}
          </Button>
          <Button variant="ghost" label="Zamknij" onClick={() => api.close()}>
            <span className="text-base leading-none">×</span>
          </Button>
        </div>
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
      {turn.error && <p className="mt-1.5 text-brand-light">{turn.error}</p>}
    </article>
  )
}

// Controls ------------------------------------------------------------------------------------

function Button({
  children,
  onClick,
  variant = 'outline',
  pressed,
  label
}: {
  children: ReactNode
  onClick: () => void
  variant?: 'outline' | 'ghost' | 'primary'
  pressed?: boolean
  label?: string
}) {
  const quiet = pressed ? 'text-brand-light' : 'text-muted-foreground hover:text-foreground'
  const variants = {
    outline: `border-border hover:bg-white/6 ${quiet}`,
    ghost: `border-transparent hover:bg-white/6 ${quiet}`,
    primary: 'border-brand bg-brand text-white hover:bg-[#f04a50]'
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs ${variants[variant]}`}
    >
      {children}
    </button>
  )
}
