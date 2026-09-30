import { ToolError } from './types'

const TIMEOUT_MS = 10_000

/**
 * GETs JSON from a public API. Resolves to null for 404 (nothing there, e.g. no exchange rate
 * published that day); other failures become a ToolError naming `what` we tried to get.
 */
export async function fetchJson<T>(url: string, what: string, signal: AbortSignal): Promise<T | null> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'QuickAsk (+https://github.com/whoyoux/quick-ask)' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new ToolError(`Nie udało się pobrać: ${what} (brak połączenia albo serwis nie odpowiada).`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new ToolError(`Serwis zwrócił błąd ${response.status} przy pobieraniu: ${what}.`)
  try {
    return (await response.json()) as T
  } catch (error) {
    if (signal.aborted) throw error
    throw new ToolError(`Serwis zwrócił nieczytelną odpowiedź przy pobieraniu: ${what}.`)
  }
}
