import { app, clipboard, ClipboardItem, dialog, nativeImage, net, protocol, shell, type NativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Pictures (attachments and generated images) live as files in `<userData>/images`; the history
// stores only their names. Renderers show them through the `qa-image:` protocol, so a view update
// carries a short URL instead of megabytes of base64.

export const IMAGE_SCHEME = 'qa-image'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
const NAME_PATTERN = /^[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/
/** Sent to models as is up to this size; larger pictures are scaled down first. */
const MAX_BYTES = 4 * 1024 * 1024
/** Longest side after scaling; vision models downsample anything bigger anyway. */
const MAX_SIDE = 2048
/** Refuse reading anything larger than this from disk or a drop. */
const MAX_INPUT_BYTES = 40 * 1024 * 1024

export class ImageError extends Error {}

export function imagesDir(): string {
  return join(app.getPath('userData'), 'images')
}

function pathOf(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new ImageError('Nieprawidłowa nazwa obrazu.')
  return join(imagesDir(), name)
}

export function isImageName(value: unknown): value is string {
  return typeof value === 'string' && NAME_PATTERN.test(value)
}

export function imagePath(name: string): string {
  return pathOf(name)
}

export function mimeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** Stores bytes under a new name and returns it. */
export function storeImage(data: Buffer, mimeType: string): string {
  const ext = Object.entries(MIME).find(([, mime]) => mime === mimeType)?.[0] ?? '.png'
  const name = `${randomUUID()}${ext === '.jpeg' ? '.jpg' : ext}`
  mkdirSync(imagesDir(), { recursive: true })
  writeFileSync(pathOf(name), data)
  return name
}

/** The picture as a data URL, the form OpenRouter accepts for image input. */
export function imageDataUrl(name: string): string {
  return `data:${mimeOf(name)};base64,${readFileSync(pathOf(name)).toString('base64')}`
}

export function deleteImages(names: Iterable<string>): void {
  for (const name of names) {
    try {
      rmSync(pathOf(name), { force: true })
    } catch (error) {
      console.warn('[quick-ask] could not delete image', name, error)
    }
  }
}

/** Removes pictures no conversation refers to any more (unsaved conversations, pending attachments). */
export function sweepImages(keep: Set<string>): void {
  let names: string[]
  try {
    names = readdirSync(imagesDir())
  } catch {
    return
  }
  deleteImages(names.filter((name) => NAME_PATTERN.test(name) && !keep.has(name)))
}

function storeNative(image: NativeImage): string {
  const { width, height } = image.getSize()
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const scaled = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : image
  // PNG keeps screenshots and text sharp; photos that come out large go to JPEG.
  const png = scaled.toPNG()
  return png.byteLength <= MAX_BYTES ? storeImage(png, 'image/png') : storeImage(scaled.toJPEG(88), 'image/jpeg')
}

/** Accepts bytes of a picture file: kept as they are when small and in a format models read, re-encoded otherwise. */
export function importImageBytes(data: Buffer, mimeType: string): string {
  if (data.byteLength > MAX_INPUT_BYTES) throw new ImageError('Ten obraz jest za duży.')
  const known = Object.values(MIME).includes(mimeType)
  if (known && data.byteLength <= MAX_BYTES) return storeImage(data, mimeType)
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) throw new ImageError('Nie rozpoznaję tego formatu obrazu. Użyj PNG, JPG, WebP albo GIF.')
  return storeNative(image)
}

export function importImageFile(path: string): string {
  if (statSync(path).size > MAX_INPUT_BYTES) throw new ImageError('Ten obraz jest za duży.')
  return importImageBytes(readFileSync(path), MIME[extname(path).toLowerCase()] ?? '')
}

function localPath(uri: string): string | null {
  try {
    const url = new URL(uri.trim())
    return url.protocol === 'file:' ? fileURLToPath(url) : null
  } catch {
    return null
  }
}

async function blobText(item: ClipboardItem, type: string): Promise<string> {
  const blob = await item.getType(type)
  return blob instanceof Blob ? blob.text() : ''
}

/** Paths of image files copied in the file manager, where the platform exposes them. */
async function clipboardFilePaths(item: ClipboardItem): Promise<string[]> {
  const paths: string[] = []
  const raw = (format: string): string => `electron application/osclipboard;format="${format}"`
  try {
    if (item.types.includes('text/uri-list')) {
      for (const line of (await blobText(item, 'text/uri-list')).split(/\r?\n/)) {
        const path = localPath(line)
        if (path) paths.push(path)
      }
    } else if (process.platform === 'win32' && (await clipboard.has(raw('FileNameW')))) {
      // Explorer puts the copied file's path under "FileNameW" as UTF-16.
      const [osItem] = (await clipboard.read()).filter((i) => i.types.includes(raw('FileNameW')))
      const blob = osItem ? await osItem.getType(raw('FileNameW')) : null
      if (blob instanceof Blob) paths.push(Buffer.from(await blob.arrayBuffer()).toString('utf16le').replace(/\0+$/, ''))
    } else if (process.platform === 'darwin' && (await clipboard.has(raw('public.file-url')))) {
      const [osItem] = (await clipboard.read()).filter((i) => i.types.includes(raw('public.file-url')))
      const path = osItem ? localPath(await blobText(osItem, raw('public.file-url'))) : null
      if (path) paths.push(path)
    }
  } catch (error) {
    console.warn('[quick-ask] could not read copied files:', error)
  }
  return paths.filter((path) => MIME[extname(path).toLowerCase()])
}

/**
 * Pictures from the clipboard: a copied image, or image files copied in the file manager.
 * Returns their new names; at most `limit` of them.
 */
export async function importClipboardImages(limit: number): Promise<string[]> {
  const names: string[] = []
  for (const item of await clipboard.read()) {
    if (names.length >= limit) break
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (imageType) {
      const blob = await item.getType(imageType)
      if (blob instanceof Blob) names.push(importImageBytes(Buffer.from(await blob.arrayBuffer()), imageType))
      continue
    }
    for (const path of await clipboardFilePaths(item)) {
      if (names.length >= limit) break
      names.push(importImageFile(path))
    }
  }
  if (names.length === 0) throw new ImageError('W schowku nie ma obrazu.')
  return names
}

/** Puts a stored picture on the clipboard as PNG, which every app can paste. */
export async function copyImageToClipboard(name: string): Promise<void> {
  const image = nativeImage.createFromPath(pathOf(name))
  const png = image.isEmpty() && mimeOf(name) === 'image/png' ? readFileSync(pathOf(name)) : image.toPNG()
  if (png.byteLength === 0) throw new ImageError('Nie mogę skopiować tego obrazu.')
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

/** Must run before the app is ready. */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** Serves `qa-image://img/<name>` from the images folder. */
export function handleImageProtocol(): void {
  protocol.handle(IMAGE_SCHEME, (request) => {
    const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
    if (!NAME_PATTERN.test(name)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(pathOf(name)).toString())
  })
}

const PICKER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/** Lets the user pick picture files; returns their new names (at most `limit`). */
export async function pickImageFiles(limit: number): Promise<string[]> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Dołącz obrazy',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Obrazy', extensions: PICKER_EXTENSIONS }]
  })
  if (canceled) return []
  return filePaths.slice(0, limit).map(importImageFile)
}

/** Asks where to save a picture and copies it there. */
export async function saveImageAs(name: string): Promise<void> {
  const ext = extname(name)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Zapisz obraz',
    defaultPath: join(app.getPath('pictures'), `quick-ask-${stamp}${ext}`),
    filters: [{ name: 'Obraz', extensions: [ext.slice(1)] }]
  })
  if (!canceled && filePath) copyFileSync(pathOf(name), filePath)
}

/** Opens a picture in the system's image viewer. */
export async function openImage(name: string): Promise<void> {
  const error = await shell.openPath(pathOf(name))
  if (error) throw new ImageError(`Nie mogę otworzyć obrazu: ${error}`)
}
