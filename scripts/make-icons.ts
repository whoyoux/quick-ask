// Generates every icon from one vector mark: `npm run icons`.
// The mark is a Q drawn as a speech bubble with three voice bars in its counter.
// Runs directly on Node's built-in TypeScript support (Node 22.18+).
import { Resvg } from '@resvg/resvg-js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RED = '#E9383F'
const GRAPHITE = '#1E1E22'
const WHITE = '#FFFFFF'

/** The mark on a 1024 canvas; its visual center is (516, 517). */
function mark(q: string, bars: string): string {
  return [
    `<circle cx="492" cy="478" r="250" fill="none" stroke="${q}" stroke-width="104"/>`,
    `<path d="M758.6 619.8 C790 720 815 800 842 858 C770 830 680 800 585.3 765.2 Z" fill="${q}"/>`,
    `<rect x="376" y="413" width="52" height="130" rx="26" fill="${bars}"/>`,
    `<rect x="466" y="353" width="52" height="250" rx="26" fill="${bars}"/>`,
    `<rect x="556" y="413" width="52" height="130" rx="26" fill="${bars}"/>`
  ].join('')
}

/** Mark on a rounded square. `scale` enlarges the mark for small tray sizes. */
function badge(background: string, q: string, bars: string, scale = 1): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<rect width="1024" height="1024" rx="228" fill="${background}"/>` +
    `<g transform="translate(516 517) scale(${scale}) translate(-516 -517)">${mark(q, bars)}</g>` +
    `</svg>`
  )
}

/** Mark alone, cropped to its bounds, for the macOS menu bar. */
function glyph(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="166 167 700 700">${mark(color, color)}</svg>`
}

function png(svg: string, size: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
function write(relativePath: string, data: string | Buffer): void {
  const file = join(root, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log(`wrote ${relativePath}`)
}

const appIcon = badge(GRAPHITE, RED, WHITE)
write('build/icon.svg', appIcon)
write('build/icon.png', png(appIcon, 1024))
write('src/renderer/assets/icon.svg', appIcon)
// Window, taskbar and Dock icon at runtime (the packaged app's .exe/.app icon comes from build/).
write('resources/icon.png', png(appIcon, 512))

// Windows/Linux tray: 16px at 100%, 125%, 150% and 200% display scaling.
for (const size of [16, 20, 24, 32]) {
  write(`resources/tray/badge-${size}.png`, png(badge(GRAPHITE, RED, WHITE, 1.14), size))
  write(`resources/tray/badge-recording-${size}.png`, png(badge(RED, WHITE, WHITE, 1.14), size))
}

// macOS menu bar: a template image (tinted by the system) and a red variant while recording.
for (const size of [18, 36]) {
  write(`resources/tray/template-${size}.png`, png(glyph('#000000'), size))
  write(`resources/tray/template-recording-${size}.png`, png(glyph(RED), size))
}
