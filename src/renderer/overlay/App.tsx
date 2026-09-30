import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatTokens, formatUsd, imageUrl } from '../../shared/format'
import {
  MAX_ATTACHMENTS,
  type DroppedFile,
  type ImageName,
  type OverlayView,
  type RecordingIndicator,
  type Source,
  type ToolUse,
  type Turn
} from '../../shared/types'
import iconUrl from '../assets/icon.svg'
import { Answer } from './Answer'
import { useLevels } from './levels'

const api = window.quickAsk

const INITIAL_VIEW: OverlayView = {
  mode: 'hidden',
  recording: null,
  notice: null,
  turns: [],
  hint: '',
  attachments: []
}

// Frameless window: these areas move it, everything interactive inside must opt out.
const DRAG = '[-webkit-app-region:drag]'
const NO_DRAG = '[-webkit-app-region:no-drag]'

/** The always-on-top window: only the recording pill and short notices. */
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

  const showPill = view.recording !== null || (view.mode === 'pill' && view.notice !== null)
  return (
    // The padding leaves room for the shadow inside the transparent window.
    <div ref={rootRef} className="inline-block p-3">
      {showPill && <Pill view={view} />}
    </div>
  )
}

/** The chat window: the conversation, filling an ordinary app window. */
export function ChatApp() {
  const [view, setView] = useState(INITIAL_VIEW)
  useEffect(() => api.onView(setView), [])

  // Pictures dropped on the window or pasted into it.
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const send = async (files: File[]): Promise<void> => {
      const images = files.filter((file) => file.type.startsWith('image/')).slice(0, MAX_ATTACHMENTS)
      if (images.length === 0) return
      const dropped: DroppedFile[] = await Promise.all(
        images.map(async (file) => ({ name: file.name, type: file.type, data: await file.arrayBuffer() }))
      )
      api.attachDropped(dropped)
    }
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault()
      setDragging(true)
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!event.relatedTarget) setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      event.preventDefault()
      setDragging(false)
      void send([...(event.dataTransfer?.files ?? [])])
    }
    const onPaste = (event: ClipboardEvent): void => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length === 0) return
      event.preventDefault()
      void send(files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  return <Panel view={view} dragging={dragging} />
}

/** The system draws the window buttons over our header: on the left on macOS, on the right elsewhere. */
const IS_MAC = navigator.userAgent.includes('Mac')

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

function Panel({ view, dragging }: { view: OverlayView; dragging: boolean }) {
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
  const counted = view.turns.filter((t) => t.tokens !== null)
  const conversationTokens =
    counted.length > 0 ? counted.reduce((sum, t) => sum + (t.tokens?.input ?? 0) + (t.tokens?.output ?? 0), 0) : null
  const summary = [
    conversationTokens !== null ? formatTokens(conversationTokens) : null,
    conversationCost !== null ? formatUsd(conversationCost) : null
  ].filter(Boolean)
  const last = view.turns.at(-1)
  const lastAnswer = last?.status === 'done' ? last.answer : ''

  const copy = (): void => {
    api.copy(lastAnswer)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <section className={`flex h-screen flex-col bg-graphite ${dragging ? 'ring-2 ring-brand ring-inset' : ''}`}>
      <header
        className={`flex h-10 shrink-0 items-center gap-2 border-b border-border ${IS_MAC ? 'pr-2 pl-20' : 'pr-[148px] pl-4'} ${DRAG}`}
      >
        <img src={iconUrl} alt="" className="size-4 rounded-[4px]" />
        <span className="text-xs text-muted-foreground">Quick Ask</span>
        {summary.length > 0 && (
          <span className="text-xs text-faint tabular-nums" title="Tokeny i koszt tej rozmowy w OpenRouter">
            · {summary.join(' · ')}
          </span>
        )}
        <span className={`ml-auto flex gap-0.5 ${NO_DRAG}`}>
          <Button variant="ghost" label="Dołącz obraz ze schowka" onClick={() => api.attachClipboard()}>
            <ClipboardIcon />
          </Button>
          <Button variant="ghost" label="Dołącz obrazy z dysku (albo przeciągnij je tutaj)" onClick={() => api.attachFiles()}>
            <PaperclipIcon />
          </Button>
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
        </span>
      </header>

      <div
        ref={threadRef}
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-3.5 select-text [scrollbar-color:rgb(255_255_255/0.14)_transparent]"
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

      {view.attachments.length > 0 && <PendingAttachments names={view.attachments} />}

      <Composer followUp={view.turns.length > 0} />

      <footer className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-t border-border py-1 pr-1.5 pl-5">
        {/* Not `truncate` while recording: its overflow clipping would cut off the pulsing dot's halo. */}
        <div className={`min-w-0 text-xs ${view.recording ? '' : 'truncate'}`}>
          {view.recording ? (
            <span className="inline-flex items-center gap-2 whitespace-nowrap text-foreground">
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
      {turn.attachments.length > 0 && (
        <div className="mb-2 flex gap-1.5">
          {turn.attachments.map((name) => (
            <Thumbnail key={name} name={name} size={40} />
          ))}
        </div>
      )}
      {turn.tools.length > 0 && <ToolUses tools={turn.tools} />}
      {turn.status === 'answering' &&
        !turn.answer &&
        !turn.generatingImage &&
        !turn.tools.some((tool) => tool.status === 'running') && (
          <p className="text-[15px] text-faint motion-safe:animate-breathe">Myślę…</p>
        )}
      {turn.answer && <Answer text={turn.answer} streaming={turn.status === 'answering' && !turn.generatingImage} />}
      {turn.generatingImage && (
        <div className="mt-2 flex h-40 items-center justify-center rounded-xl border border-border bg-white/3 text-[13px] text-faint motion-safe:animate-breathe">
          Generuję obraz…
        </div>
      )}
      {turn.images.map((name) => (
        <GeneratedImage key={name} name={name} />
      ))}
      {turn.sources.length > 0 && <Sources sources={turn.sources} />}
      {turn.error && <p className="mt-1.5 text-brand-light">{turn.error}</p>}
      {turn.status === 'done' && <Timing turn={turn} />}
    </article>
  )
}

/** What the model computed or looked up, one line each; opening one shows the input and the result. */
function ToolUses({ tools }: { tools: ToolUse[] }) {
  return (
    <div className="mb-2.5 flex flex-col gap-1">
      {tools.map((tool, i) => (
        <details key={i} className="rounded-lg border border-border bg-white/3 text-[12px]">
          <summary
            className={`flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 select-none [&::-webkit-details-marker]:hidden ${
              tool.status === 'running' ? 'motion-safe:animate-breathe' : ''
            }`}
          >
            <ToolStatus status={tool.status} />
            <span className="shrink-0 text-muted-foreground">{tool.label}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-faint">{tool.input.split('\n')[0]}</span>
          </summary>
          <div className="flex flex-col gap-1.5 border-t border-border px-2.5 py-2">
            {tool.input && <ToolText label="Wejście" text={tool.input} />}
            {tool.output !== null && <ToolText label={tool.status === 'error' ? 'Błąd' : 'Wynik'} text={tool.output} />}
          </div>
        </details>
      ))}
    </div>
  )
}

function ToolStatus({ status }: { status: ToolUse['status'] }) {
  if (status === 'running') return <span aria-label="W toku" className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
  if (status === 'error') return <span aria-label="Błąd" className="size-1.5 shrink-0 rounded-full bg-brand" />
  return <span aria-label="Gotowe" className="size-1.5 shrink-0 rounded-full bg-emerald-400/80" />
}

function ToolText({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] text-faint">{label}</div>
      <pre className="max-h-48 overflow-auto rounded-md bg-black/25 px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap text-muted-foreground select-text">
        {text}
      </pre>
    </div>
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`
}

/** Typing instead of speaking: Enter sends, Shift+Enter starts a new line. */
function Composer({ followUp }: { followUp: boolean }) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => api.onFocusInput(() => inputRef.current?.focus()), [])

  // Grows with the text up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`
  }, [text])

  const send = (): void => {
    if (!text.trim()) return
    api.askText(text)
    setText('')
  }

  return (
    <div className="flex shrink-0 items-end gap-2 border-t border-border py-2 pr-2 pl-5">
      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        placeholder={followUp ? 'Napisz, aby dopytać…' : 'Napisz pytanie…'}
        aria-label="Pytanie"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          } else if (event.key === 'Escape' && text) {
            // First Esc clears the draft; the next one closes the panel.
            event.preventDefault()
            setText('')
          }
        }}
        className="max-h-[120px] min-h-7 flex-1 resize-none bg-transparent py-1 text-[14px] leading-5 text-foreground outline-none placeholder:text-faint select-text"
      />
      <Button variant={text.trim() ? 'primary' : 'ghost'} label="Wyślij (Enter)" onClick={send}>
        Wyślij
      </Button>
    </div>
  )
}

/** Which models answered, how fast and for how much, to help pick models in the menu. */
function Timing({ turn }: { turn: Turn }) {
  const { timing, costUsd } = turn
  const parts: string[] = []
  if (timing.firstTokenMs !== null) {
    const answer = `${timing.chatModel} ${seconds(timing.firstTokenMs)}`
    // Typed questions skip transcription.
    parts.push(
      timing.transcriptionMs !== null ? `${timing.transcriptionModel} ${seconds(timing.transcriptionMs)} → ${answer}` : answer
    )
  }
  if (turn.tokens) parts.push(formatTokens(turn.tokens.input + turn.tokens.output))
  if (costUsd !== null) parts.push(formatUsd(costUsd))
  if (parts.length === 0) return null
  const breakdown = turn.tokens
    ? `Tokeny: ${turn.tokens.input} wejściowych (pytanie, historia, obrazy), ${turn.tokens.output} wyjściowych`
    : undefined
  return (
    <p className="mt-2 text-[11px] text-faint tabular-nums" title={breakdown}>
      {parts.join(' · ')}
    </p>
  )
}

// Pictures -------------------------------------------------------------------------------------

function Thumbnail({ name, size }: { name: ImageName; size: number }) {
  return (
    <button
      type="button"
      title="Otwórz obraz"
      onClick={() => api.openImage(name)}
      className="shrink-0 overflow-hidden rounded-md border border-border"
      style={{ width: size, height: size }}
    >
      <img src={imageUrl(name)} alt="" className="size-full object-cover" draggable={false} />
    </button>
  )
}

/** Pictures that will go with the next question. */
function PendingAttachments({ names }: { names: ImageName[] }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-2.5">
      {names.map((name) => (
        <span key={name} className="relative">
          <Thumbnail name={name} size={52} />
          <button
            type="button"
            aria-label="Usuń obraz"
            title="Usuń obraz"
            onClick={() => api.removeAttachment(name)}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-graphite text-xs leading-none text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <span className="ml-1 text-xs text-faint">
        {names.length < MAX_ATTACHMENTS ? `Pójdzie z następnym pytaniem (maks. ${MAX_ATTACHMENTS})` : 'Pójdą z następnym pytaniem'}
      </span>
    </div>
  )
}

function GeneratedImage({ name }: { name: ImageName }) {
  return (
    <figure className="mt-2">
      <button type="button" title="Otwórz w przeglądarce obrazów" onClick={() => api.openImage(name)} className="block">
        <img
          src={imageUrl(name)}
          alt="Wygenerowany obraz"
          draggable={false}
          className="max-h-[60vh] max-w-full rounded-xl border border-border object-contain"
        />
      </button>
      <figcaption className="mt-1.5 flex gap-1">
        <Button onClick={() => api.copyImage(name)}>Kopiuj obraz</Button>
        <Button onClick={() => api.saveImage(name)}>Zapisz…</Button>
      </figcaption>
    </figure>
  )
}

function PaperclipIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.3l7.9-8" />
    </svg>
  )
}

function ClipboardIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
    </svg>
  )
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
