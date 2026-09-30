/** Dollars the way OpenRouter bills them; a single question costs fractions of a cent, so small amounts get more digits. */
export function formatUsd(usd: number): string {
  const digits = usd !== 0 && Math.abs(usd) < 0.1 ? 4 : 2
  return `$${usd.toFixed(digits).replace('.', ',')}`
}

// Polish skips the group separator in 4-digit numbers ("4900"); always group so they read alike.
const tokenFormat = new Intl.NumberFormat('pl-PL', { useGrouping: 'always' })

/** "4 900 → 64 tok.": input (prompt) tokens, then output (answer) tokens. */
export function formatTokens(tokens: { input: number; output: number }): string {
  return `${tokenFormat.format(Math.round(tokens.input))} → ${tokenFormat.format(Math.round(tokens.output))} tok.`
}

/** Tooltip explaining the two token counts. */
export const TOKENS_HINT =
  'Tokeny wejściowe → wyjściowe. Wejściowe: pytanie, wcześniejsza rozmowa, wyniki wyszukiwania i obrazy. ' +
  'Wyjściowe: odpowiedź, razem z myśleniem modelu; zwykle są kilka razy droższe.'

/** Where the renderer loads a stored picture from (served by the main process). */
export function imageUrl(name: string): string {
  return `qa-image://img/${encodeURIComponent(name)}`
}
