// The functions the chat model may call while answering, and the tray switches for them.

import { createCurrencyTool } from './currency'
import { createJavaScriptTool } from './javascript'
import { createTimeTool } from './time'
import type { LocalTool, ToolId } from './types'
import { createWeatherTool } from './weather'

export type { LocalTool, ToolId } from './types'
export { ToolError } from './types'

const LOCAL_TOOLS: LocalTool[] = [createJavaScriptTool(), createCurrencyTool(), createWeatherTool(), createTimeTool()]

/** The tray's "Narzędzia AI" menu, in order. Charts are an answer format rather than a function. */
export const TOOL_MENU: { id: ToolId; label: string }[] = [
  { id: 'code', label: 'Obliczenia i analiza danych (JavaScript)' },
  { id: 'charts', label: 'Wykresy' },
  { id: 'currency', label: 'Kursy walut (NBP)' },
  { id: 'weather', label: 'Pogoda (Open-Meteo)' },
  { id: 'time', label: 'Strefy czasowe' }
]

const INSTRUCTIONS: Record<ToolId, string> = {
  code: 'For arithmetic beyond one easy step, percentages, statistics, date differences, counting, or processing data the user gave, call run_javascript instead of calculating in your head, then state the result.',
  charts:
    'When a chart makes the answer clearer (the user asks for one, or you compare several numbers or show a trend), add one ```vega-lite code block with a complete Vega-Lite JSON spec: data inline in "data.values" (never a URL), no width or height. Do not explain the spec.',
  currency: 'For currency conversions and exchange rates call get_exchange_rate (official NBP average rates) instead of guessing rates.',
  weather: 'For weather questions call get_weather.',
  time: 'For the time in other time zones, or to convert times between zones, call convert_time.'
}

export function enabledTools(disabled: readonly ToolId[]): LocalTool[] {
  return LOCAL_TOOLS.filter((tool) => !disabled.includes(tool.id))
}

/** System prompt lines for the enabled tools. */
export function toolInstructions(disabled: readonly ToolId[]): string[] {
  return TOOL_MENU.filter(({ id }) => !disabled.includes(id)).map(({ id }) => INSTRUCTIONS[id])
}
