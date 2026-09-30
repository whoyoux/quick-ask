// Time zone conversion with the tz database built into Intl, so daylight saving time is exact.
// Models know the current local time from the system prompt but often get other zones' offsets wrong.

import { stringArg, ToolError, type LocalTool } from './types'

const MAX_ZONES = 10

function checkZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    throw new ToolError(`„${zone}” nie jest nazwą strefy czasowej IANA (np. Europe/Warsaw, America/New_York).`)
  }
}

interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function wallTime(instant: number, zone: string): WallTime & { second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(instant))
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

/** Minutes the zone is ahead of UTC at that instant. */
export function offsetMinutes(instant: number, zone: string): number {
  const w = wallTime(instant, zone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000)
}

/** The instant a zone's clocks show `wall`; in a DST gap it lands just after the jump. */
export function instantOf(wall: WallTime, zone: string): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const first = guess - offsetMinutes(guess, zone) * 60_000
  return guess - offsetMinutes(first, zone) * 60_000
}

function parseTime(text: string, zone: string, now: number): WallTime {
  const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(text)
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text)
  let wall: WallTime
  if (full) {
    const [, year, month, day, hour, minute] = full.map(Number)
    wall = { year, month, day, hour, minute }
  } else if (clock) {
    wall = { ...wallTime(now, zone), hour: Number(clock[1]), minute: Number(clock[2]) }
  } else {
    throw new ToolError(`„${text}” nie jest czasem w formacie RRRR-MM-DDTGG:MM albo GG:MM.`)
  }
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute))
  if (wall.hour > 23 || wall.minute > 59 || date.getUTCDate() !== wall.day || date.getUTCMonth() !== wall.month - 1) {
    throw new ToolError(`„${text}” nie jest prawidłową datą i godziną.`)
  }
  return wall
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+'
  const abs = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

export function formatIn(instant: number, zone: string): string {
  const text = new Intl.DateTimeFormat('pl-PL', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(instant))
  return `${zone}: ${text} (${formatOffset(offsetMinutes(instant, zone))})`
}

export function createTimeTool(now: () => number = Date.now): LocalTool {
  return {
    id: 'time',
    label: 'Strefy czasowe',
    definition: {
      name: 'convert_time',
      description:
        'Tells the current time in other time zones, or converts a date and time from one zone to others, with daylight saving time applied exactly. Use it for "what time is it in…" and for meeting or broadcast times across zones.',
      parameters: {
        type: 'object',
        properties: {
          time: {
            type: 'string',
            description: 'Date and time to convert as "YYYY-MM-DDTHH:mm", or "HH:mm" for today. Omit for the current time.'
          },
          from_time_zone: {
            type: 'string',
            description: "IANA zone the time is given in, e.g. Europe/London. Omit for the user's own zone."
          },
          to_time_zones: {
            type: 'array',
            items: { type: 'string' },
            description: 'IANA zones to show the time in, e.g. ["America/New_York", "Asia/Tokyo"].'
          }
        },
        required: ['to_time_zones']
      }
    },
    describe(args) {
      const targets = Array.isArray(args.to_time_zones) ? args.to_time_zones.filter((z) => typeof z === 'string') : []
      const time = stringArg(args, 'time')
      const from = stringArg(args, 'from_time_zone')
      return `${time || 'teraz'}${from ? ` (${from})` : ''} → ${targets.join(', ')}`
    },
    async run(args, { timeZone }) {
      const from = checkZone(stringArg(args, 'from_time_zone') || timeZone)
      const targets = (Array.isArray(args.to_time_zones) ? args.to_time_zones : [])
        .filter((z): z is string => typeof z === 'string' && z.trim() !== '')
        .slice(0, MAX_ZONES)
        .map((z) => checkZone(z.trim()))
      if (targets.length === 0) throw new ToolError('Nie podano stref czasowych.')
      const time = stringArg(args, 'time')
      const instant = time ? instantOf(parseTime(time, from, now()), from) : now()
      const zones = [from, ...targets.filter((z) => z !== from)]
      return {
        content: [
          time ? `Czas ${time} w strefie ${from} to:` : 'Aktualny czas:',
          ...zones.map((zone) => `- ${formatIn(instant, zone)}`)
        ].join('\n')
      }
    }
  }
}
