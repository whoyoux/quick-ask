// Weather from Open-Meteo (https://open-meteo.com): free for non-commercial use, no key.
// Its data is CC BY 4.0, so the answer lists Open-Meteo among its sources.

import { fetchJson } from './http'
import { stringArg, ToolError, type LocalTool } from './types'

const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const SOURCE = { url: 'https://open-meteo.com/', title: 'Open-Meteo' }
const MAX_DAYS = 7
const DEFAULT_DAYS = 3

/** WMO weather interpretation codes, as Open-Meteo documents them. */
const CONDITIONS: Record<number, string> = {
  0: 'bezchmurnie',
  1: 'przeważnie bezchmurnie',
  2: 'częściowe zachmurzenie',
  3: 'pochmurno',
  45: 'mgła',
  48: 'mgła osadzająca szadź',
  51: 'słaba mżawka',
  53: 'umiarkowana mżawka',
  55: 'gęsta mżawka',
  56: 'słaba marznąca mżawka',
  57: 'gęsta marznąca mżawka',
  61: 'słaby deszcz',
  63: 'umiarkowany deszcz',
  65: 'silny deszcz',
  66: 'słaby marznący deszcz',
  67: 'silny marznący deszcz',
  71: 'słaby śnieg',
  73: 'umiarkowany śnieg',
  75: 'intensywny śnieg',
  77: 'śnieg ziarnisty',
  80: 'słabe przelotne opady deszczu',
  81: 'umiarkowane przelotne opady deszczu',
  82: 'gwałtowne przelotne opady deszczu',
  85: 'słabe przelotne opady śniegu',
  86: 'intensywne przelotne opady śniegu',
  95: 'burza',
  96: 'burza z drobnym gradem',
  99: 'burza z silnym gradem'
}

interface Place {
  name?: string
  latitude?: number
  longitude?: number
  country?: string
  admin1?: string
}

interface Forecast {
  timezone?: string
  current?: Record<string, number | string | undefined>
  daily?: Record<string, (number | string | null)[] | undefined>
}

const CURRENT = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_gusts_10m'
]
const DAILY = [
  'weather_code',
  'temperature_2m_min',
  'temperature_2m_max',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max'
]

function condition(code: unknown): string {
  return typeof code === 'number' ? (CONDITIONS[code] ?? `kod pogody ${code}`) : 'brak danych'
}

function num(value: unknown, unit: string): string {
  return typeof value === 'number' ? `${Math.round(value * 10) / 10}${unit}` : '?'
}

export function describeForecast(place: Place, forecast: Forecast): string {
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(', ')
  const lines = [`Pogoda: ${where} (strefa czasowa ${forecast.timezone ?? 'nieznana'})`]
  const now = forecast.current
  if (now) {
    lines.push(
      `Teraz (${String(now.time ?? '').replace('T', ' ')}): ${num(now.temperature_2m, ' °C')}, odczuwalna ${num(now.apparent_temperature, ' °C')}, ${condition(now.weather_code)}, wilgotność ${num(now.relative_humidity_2m, '%')}, opad ${num(now.precipitation, ' mm')}, wiatr ${num(now.wind_speed_10m, ' km/h')} (porywy ${num(now.wind_gusts_10m, ' km/h')})`
    )
  }
  const daily = forecast.daily
  const days = daily?.time ?? []
  if (days.length > 0) lines.push('Prognoza:')
  days.forEach((day, i) => {
    const at = (field: string): unknown => daily?.[field]?.[i]
    const chance = at('precipitation_probability_max')
    lines.push(
      `- ${day}: ${num(at('temperature_2m_min'), '')}…${num(at('temperature_2m_max'), ' °C')}, ${condition(at('weather_code'))}, opad ${num(at('precipitation_sum'), ' mm')}${typeof chance === 'number' ? ` (szansa ${chance}%)` : ''}, wiatr do ${num(at('wind_speed_10m_max'), ' km/h')}`
    )
  })
  return lines.join('\n')
}

export function createWeatherTool(): LocalTool {
  return {
    id: 'weather',
    label: 'Pogoda',
    definition: {
      name: 'get_weather',
      description:
        'Current weather and a daily forecast (up to 7 days) for a place. Use it for questions about weather, temperature, rain, snow or wind. If the user named no place and none is clear from the conversation, ask where.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Name of the city or place only, e.g. "Kraków" or "Paris".' },
          country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code to pick the right place, e.g. "PL".' },
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: `Days of forecast including today; default ${DEFAULT_DAYS}.` }
        },
        required: ['location']
      }
    },
    describe(args) {
      const country = stringArg(args, 'country_code')
      return `${stringArg(args, 'location')}${country ? ` (${country.toUpperCase()})` : ''}`
    },
    async run(args, { signal }) {
      const location = stringArg(args, 'location')
      if (!location) throw new ToolError('Nie podano miejscowości.')
      const country = stringArg(args, 'country_code').toUpperCase()
      const days = typeof args.days === 'number' ? Math.min(MAX_DAYS, Math.max(1, Math.round(args.days))) : DEFAULT_DAYS

      const search = new URLSearchParams({ name: location, count: '1', language: 'pl', format: 'json' })
      if (/^[A-Z]{2}$/.test(country)) search.set('countryCode', country)
      const found = await fetchJson<{ results?: Place[] }>(`${GEOCODING}?${search}`, `położenie „${location}”`, signal)
      const place = found?.results?.[0]
      if (typeof place?.latitude !== 'number' || typeof place.longitude !== 'number') {
        throw new ToolError(`Nie znalazłem miejscowości „${location}”.`)
      }

      const query = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: CURRENT.join(','),
        daily: DAILY.join(','),
        timezone: 'auto',
        forecast_days: String(days),
        wind_speed_unit: 'kmh'
      })
      const forecast = await fetchJson<Forecast>(`${FORECAST}?${query}`, `prognozę dla „${place.name ?? location}”`, signal)
      if (!forecast) throw new ToolError(`Open-Meteo nie ma prognozy dla „${place.name ?? location}”.`)
      return { content: describeForecast(place, forecast), sources: [SOURCE] }
    }
  }
}
