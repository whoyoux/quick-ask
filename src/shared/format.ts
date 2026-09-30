/** Dollars the way OpenRouter bills them; a single question costs fractions of a cent, so small amounts get more digits. */
export function formatUsd(usd: number): string {
  const digits = usd !== 0 && Math.abs(usd) < 0.1 ? 4 : 2
  return `$${usd.toFixed(digits).replace('.', ',')}`
}
