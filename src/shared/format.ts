/** Dollars the way OpenRouter bills them; a single question costs fractions of a cent, so small amounts get more digits. */
export function formatUsd(usd: number): string {
  const digits = usd !== 0 && Math.abs(usd) < 0.1 ? 4 : 2
  return `$${usd.toFixed(digits).replace('.', ',')}`
}

const tokenFormat = new Intl.NumberFormat('pl-PL')

/** "1 234 tok." */
export function formatTokens(tokens: number): string {
  return `${tokenFormat.format(Math.round(tokens))} tok.`
}

/** Where the renderer loads a stored picture from (served by the main process). */
export function imageUrl(name: string): string {
  return `qa-image://img/${encodeURIComponent(name)}`
}
