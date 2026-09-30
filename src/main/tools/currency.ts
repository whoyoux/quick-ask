// Currency conversion at the National Bank of Poland's average rates (https://api.nbp.pl):
// free, no key, official. Table A covers the major currencies every working day, table B the
// rest once a week. Every rate is in PLN, so other pairs go through the złoty.

import { fetchJson } from './http'
import { stringArg, ToolError, type LocalTool } from './types'

const API = 'https://api.nbp.pl/api/exchangerates/rates'
const SOURCE = { url: 'https://api.nbp.pl/', title: 'NBP: kursy średnie walut' }
/** Rates exist from this day on. */
const FIRST_DATE = '2002-01-02'
/** How far back to look for the last rate published on or before a date (holidays, table B's weekly rhythm). */
const LOOKBACK_DAYS: Record<Table, number> = { a: 10, b: 16 }

type Table = 'a' | 'b'

interface NbpRates {
  code?: string
  rates?: { no?: string; effectiveDate?: string; mid?: number }[]
}

interface Rate {
  code: string
  /** PLN for one unit. */
  mid: number
  table: string
  date: string
}

const PLN: Rate = { code: 'PLN', mid: 1, table: '', date: '' }

/** Today in Warsaw, where NBP publishes; later dates have no rates yet. */
function warsawToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now)
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function rateOf(code: string, date: string | null, signal: AbortSignal): Promise<Rate> {
  if (code === 'PLN') return PLN
  for (const table of ['a', 'b'] as Table[]) {
    const range = date ? `${shiftDate(date, -LOOKBACK_DAYS[table])}/${date}` : 'last/1'
    const body = await fetchJson<NbpRates>(
      `${API}/${table}/${code.toLowerCase()}/${range}/?format=json`,
      `kurs ${code} z NBP`,
      signal
    )
    const last = body?.rates?.at(-1)
    if (typeof last?.mid === 'number' && last.mid > 0) {
      return { code, mid: last.mid, table: last.no ?? table.toUpperCase(), date: last.effectiveDate ?? '' }
    }
  }
  throw new ToolError(
    date
      ? `NBP nie opublikował kursu ${code} w dniach przed ${date} (albo to nie jest kod waluty).`
      : `NBP nie publikuje kursu ${code} (albo to nie jest kod waluty ISO 4217). Kryptowalut nie ma w tabelach NBP.`
  )
}

function currencyCode(args: Record<string, unknown>, name: string): string {
  const code = stringArg(args, name).toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new ToolError(`„${stringArg(args, name)}” nie jest trzyliterowym kodem waluty (np. EUR).`)
  return code
}

/** Keeps small rates (HUF, JPY) readable without printing 15 digits. */
function round(value: number, significant: number): string {
  if (value === 0) return '0'
  const digits = Math.max(2, significant - Math.floor(Math.log10(Math.abs(value))) - 1)
  return value.toFixed(Math.min(digits, 10))
}

/** Money in cents, except amounts below one unit, which keep a few significant digits. */
function money(value: number): string {
  return Math.abs(value) >= 1 ? value.toFixed(2) : round(value, 4)
}

function describeRate(rate: Rate): string {
  return `1 ${rate.code} = ${round(rate.mid, 5)} PLN (tabela ${rate.table} z ${rate.date})`
}

export function createCurrencyTool(now: () => Date = () => new Date()): LocalTool {
  return {
    id: 'currency',
    label: 'Kursy walut',
    definition: {
      name: 'get_exchange_rate',
      description:
        'Converts an amount between currencies at the official average exchange rates of the National Bank of Poland (NBP), for today or a past date. Use it for every currency conversion or exchange rate question instead of guessing rates. Not for cryptocurrencies.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Amount in the source currency. 1 to get just the rate.' },
          from: { type: 'string', description: 'ISO 4217 code of the source currency, e.g. EUR.' },
          to: { type: 'string', description: 'ISO 4217 code of the target currency, e.g. PLN.' },
          date: { type: 'string', description: 'YYYY-MM-DD for the rate on a past day. Omit for the latest rate.' }
        },
        required: ['from', 'to']
      }
    },
    describe(args) {
      const amount = typeof args.amount === 'number' ? `${args.amount} ` : ''
      const date = stringArg(args, 'date')
      return `${amount}${stringArg(args, 'from').toUpperCase()} → ${stringArg(args, 'to').toUpperCase()}${date ? `, ${date}` : ''}`
    },
    async run(args, { signal }) {
      const from = currencyCode(args, 'from')
      const to = currencyCode(args, 'to')
      const amount = typeof args.amount === 'number' && Number.isFinite(args.amount) ? args.amount : 1
      const today = warsawToday(now())
      let date: string | null = stringArg(args, 'date') || null
      if (date !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
          throw new ToolError(`„${date}” nie jest datą w formacie RRRR-MM-DD.`)
        }
        if (date < FIRST_DATE) throw new ToolError(`NBP udostępnia kursy od ${FIRST_DATE}.`)
        // Today's table may not be out yet, and the future has none: take the latest.
        if (date >= today) date = null
      }
      const [source, target] = await Promise.all([rateOf(from, date, signal), rateOf(to, date, signal)])
      const result = (amount * source.mid) / target.mid
      const rates = [source, target].filter((r) => r.code !== 'PLN').map(describeRate)
      return {
        content: [
          `${amount} ${from} = ${money(result)} ${to}`,
          ...(rates.length > 0 ? [`Kursy średnie NBP: ${rates.join('; ')}.`] : []),
          ...(date ? [`Kurs na dzień ${date}: to ostatnia tabela opublikowana w tym dniu lub przed nim.`] : [])
        ].join('\n'),
        sources: [SOURCE]
      }
    }
  }
}
