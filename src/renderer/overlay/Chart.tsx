// Draws a ```vega-lite block from an answer. Loaded lazily: Vega is large and most answers have no chart.
// The spec comes from the model, so it gets no network (no data URLs, no images, no links) and
// its expressions run in Vega's interpreter, which our CSP needs anyway (no eval).

import { useEffect, useRef, useState } from 'react'
import embed, { vega, type VisualizationSpec } from 'vega-embed'
import { expressionInterpreter } from 'vega-interpreter'

// Categorical slots for a dark surface, in this order (validated for colour-blind separation on #1e1e22).
const CATEGORY = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const INK = '#f4f4f5'
const MUTED = '#a1a1aa'
const GRID = 'rgba(255, 255, 255, 0.07)'
const AXIS = 'rgba(255, 255, 255, 0.18)'
const FONT = "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Ubuntu, Cantarell, sans-serif"

const CONFIG = {
  background: 'transparent',
  font: FONT,
  padding: 4,
  view: { stroke: null, continuousHeight: 220 },
  range: { category: CATEGORY },
  mark: { color: CATEGORY[0] },
  bar: { cornerRadiusEnd: 3 },
  line: { strokeWidth: 2 },
  point: { size: 64, filled: true },
  arc: { stroke: '#1e1e22', strokeWidth: 2 },
  axis: {
    domainColor: AXIS,
    tickColor: AXIS,
    gridColor: GRID,
    labelColor: MUTED,
    titleColor: MUTED,
    labelFontSize: 11,
    titleFontSize: 11,
    titleFontWeight: 'normal'
  },
  axisBand: { grid: false },
  // Upright category labels; Vega-Lite hides the ones that would overlap.
  axisXBand: { labelAngle: 0 },
  legend: { labelColor: MUTED, titleColor: MUTED, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 'normal' },
  title: { color: INK, subtitleColor: MUTED, fontSize: 13, fontWeight: 600, anchor: 'start' }
} as const

// No fetching anything: inline data only, and marks can't link anywhere.
const offline = vega.loader()
offline.load = async () => {
  throw new Error('Wykres może używać tylko danych zapisanych w odpowiedzi.')
}
offline.sanitize = (async () => ({})) as unknown as typeof offline.sanitize

/** A lone chart fills the panel's width; composed ones (facets, concat) keep their own sizing. */
function fitWidth(spec: Record<string, unknown>): Record<string, unknown> {
  const composed = ['facet', 'concat', 'hconcat', 'vconcat', 'repeat'].some((key) => key in spec)
  return composed || 'width' in spec ? spec : { ...spec, width: 'container' }
}

export default function Chart({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let spec: Record<string, unknown>
    try {
      spec = JSON.parse(code)
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('not an object')
    } catch {
      setFailed(true)
      return
    }
    setFailed(false)
    let finalize: (() => void) | null = null
    let cancelled = false
    embed(el, fitWidth(spec) as VisualizationSpec, {
      mode: 'vega-lite',
      ast: true,
      expr: expressionInterpreter,
      loader: offline,
      actions: false,
      renderer: 'svg',
      config: CONFIG,
      tooltip: { theme: 'dark' },
      logLevel: vega.Error
    }).then(
      (result) => {
        if (cancelled) result.finalize()
        else finalize = result.finalize
      },
      (error: unknown) => {
        console.warn('[quick-ask] chart failed:', error)
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
      finalize?.()
    }
  }, [code])

  return (
    <figure className="my-3">
      <div ref={ref} className={failed ? 'hidden' : 'w-full'} />
      {failed && <p className="text-[13px] text-faint">Nie udało się narysować wykresu.</p>}
    </figure>
  )
}
