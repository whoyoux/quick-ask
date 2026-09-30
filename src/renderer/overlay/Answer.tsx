import { createCodePlugin } from '@streamdown/code'
import { lazy, Suspense } from 'react'
import { harden } from 'rehype-harden'
import { defaultRehypePlugins, defaultTranslations, Streamdown, type CustomRendererProps } from 'streamdown'
import type { Pluggable } from 'unified'

const code = createCodePlugin({ themes: ['github-dark', 'github-dark'] })

const Chart = lazy(() => import('./Chart'))

/** A ```vega-lite block becomes a chart once the model has finished writing it. */
function ChartBlock({ code, isIncomplete }: CustomRendererProps) {
  const placeholder = <div className="my-3 h-40 rounded-xl border border-border bg-white/3 motion-safe:animate-breathe" />
  if (isIncomplete) return placeholder
  return (
    <Suspense fallback={placeholder}>
      <Chart code={code} />
    </Suspense>
  )
}

const plugins = { code, renderers: [{ language: ['vega-lite', 'vegalite'], component: ChartBlock }] }

// Model output is untrusted. Raw HTML is dropped (no rehype-raw), HTML that survives is
// sanitized, only web and mail links are kept, and no images load: a remote image would
// leak the user's IP address.
const rehypePlugins: Pluggable[] = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      allowedProtocols: ['http', 'https', 'mailto'],
      allowedLinkPrefixes: ['*'],
      allowedImagePrefixes: [],
      allowDataImages: false
    }
  ]
]

const translations = {
  ...defaultTranslations,
  copied: 'Skopiowano',
  copyCode: 'Kopiuj kod',
  imageNotAvailable: 'Obraz zablokowany'
}

export function Answer({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      className="answer text-[15px] leading-relaxed"
      isAnimating={streaming}
      animated
      caret="block"
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      // Links open in the system browser (the main process enforces it), so the
      // in-page confirmation modal would be a second prompt in a tiny window.
      linkSafety={{ enabled: false }}
      controls={{ code: { copy: true, download: false }, table: false, mermaid: false, image: false }}
      lineNumbers={false}
      codeBlockMaxHeight={320}
      translations={translations}
    >
      {text}
    </Streamdown>
  )
}
