import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { KeyCheckResult, SetupStatus } from '../../shared/types'
import iconUrl from '../assets/icon.svg'

const api = window.quickAsk

export function SettingsApp() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<KeyCheckResult | null>(null)

  const refresh = useCallback(() => {
    void api.getStatus().then(setStatus)
  }, [])

  useEffect(refresh, [refresh])

  // Granting Accessibility happens in System Settings; pick it up when it lands.
  useEffect(() => {
    if (!status?.needsAccessibility) return
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [status?.needsAccessibility, refresh])

  if (!status) return null

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setResult(null)
    const outcome = await api.saveKey(key)
    setSaving(false)
    setResult(outcome)
    if (outcome.ok) {
      setKey('')
      setEditing(false)
      refresh()
    }
  }

  const remove = async (): Promise<void> => {
    await api.removeKey()
    setResult(null)
    refresh()
  }

  const showForm = !status.hasKey || editing
  const ready = status.hasKey && !status.needsAccessibility

  return (
    <main className="flex min-h-screen flex-col gap-6 p-7">
      <header className="flex items-center gap-3.5">
        <img src={iconUrl} alt="" className="size-12" />
        <div>
          <h1 className="text-lg font-semibold">Quick Ask</h1>
          <p className="text-muted-foreground">Zadaj pytanie na głos, odpowiedź pojawi się nad ekranem.</p>
        </div>
      </header>

      <section className="flex flex-col gap-2.5">
        <h2 className="font-medium">Klucz API OpenRouter</h2>
        {showForm ? (
          <form onSubmit={save} className="flex flex-col gap-2.5">
            <div className="flex gap-2">
              <input
                type="password"
                autoFocus
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="sk-or-v1-…"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-input bg-raised px-3 py-2 font-mono text-[13px] placeholder:text-faint focus:border-brand focus:outline-none"
              />
              <button
                type="submit"
                disabled={saving || !key.trim()}
                className="rounded-lg bg-brand px-3.5 py-2 font-medium text-white hover:bg-[#f04a50] disabled:opacity-50"
              >
                {saving ? 'Sprawdzam…' : 'Zapisz i sprawdź'}
              </button>
            </div>
            <p className="text-[13px] text-muted-foreground">
              Klucz zostaje na tym komputerze, zaszyfrowany przez system. Nie masz klucza?{' '}
              <button type="button" onClick={() => api.openLink('keys')} className="text-brand-light underline">
                Utwórz go na openrouter.ai
              </button>
            </p>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-raised px-3 py-2">
            <span className="font-mono text-[13px] text-muted-foreground">{status.maskedKey}</span>
            <span className="flex gap-1">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-white/6 hover:text-foreground"
              >
                Zmień
              </button>
              <button
                type="button"
                onClick={remove}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-white/6 hover:text-foreground"
              >
                Usuń
              </button>
            </span>
          </div>
        )}
        {result && (
          <p role="status" className={`text-[13px] ${result.ok ? 'text-emerald-400' : 'text-brand-light'}`}>
            {result.message}
          </p>
        )}
      </section>

      {status.needsAccessibility && (
        <section className="flex flex-col gap-2.5">
          <h2 className="font-medium">Dostęp do klawiatury</h2>
          <p className="text-[13px] text-muted-foreground">
            Żeby wiedzieć, kiedy trzymasz {status.pttLabel}, Quick Ask potrzebuje uprawnienia Dostępność w
            Ustawieniach systemowych → Prywatność i ochrona.
          </p>
          <button
            type="button"
            onClick={() => void api.requestAccessibility()}
            className="self-start rounded-lg border border-border px-3 py-1.5 hover:bg-white/6"
          >
            Nadaj dostęp
          </button>
        </section>
      )}

      <footer className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-[13px] text-muted-foreground">
          {ready ? `Gotowe. Przytrzymaj ${status.pttLabel} i zadaj pytanie.` : 'Ustawienia znajdziesz w menu ikony Quick Ask.'}
        </p>
        <button
          type="button"
          onClick={() => api.close()}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 hover:bg-white/6"
        >
          Zamknij
        </button>
      </footer>
    </main>
  )
}
