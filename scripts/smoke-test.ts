// Starts the packaged app in release/ with --smoke-test (see src/main/smoke-test.ts) and fails
// unless it exits cleanly in time. Package first; the unpacked app is enough:
//
//   npm run build && npx electron-builder --dir && npm run test:smoke

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A crash in the main process shows an error dialog instead of exiting, so give up after this. */
const TIMEOUT_MS = 60_000

const { name, productName, version } = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, string>
// electron-builder's folder names: the x64 build has no arch suffix (except on macOS, where arm64 has one).
const suffix = process.arch === 'x64' ? '' : `-${process.arch}`
const executable = join(
  'release',
  version,
  process.platform === 'darwin'
    ? `mac${suffix}/${productName}.app/Contents/MacOS/${productName}`
    : process.platform === 'win32'
      ? `win${suffix}-unpacked/${productName}.exe`
      : `linux${suffix}-unpacked/${name}`
)
if (!existsSync(executable)) {
  console.error(`${executable} not found: package the app first (npx electron-builder --dir)`)
  process.exit(1)
}

let command = executable
let args = ['--smoke-test']
if (process.platform === 'linux') {
  // The unpacked chrome-sandbox isn't setuid root, and Ubuntu 24.04 blocks the namespace
  // sandbox Chromium falls back to; the installed .deb and AppImage don't have this problem.
  args.push('--no-sandbox')
  // CI runners have no display.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    args = ['-a', command, ...args]
    command = 'xvfb-run'
  }
}

// Its own process group on macOS and Linux, so a timeout can kill Electron's helpers too:
// left running, they would keep the output open and CI would wait for them.
const child = spawn(command, args, { stdio: 'inherit', detached: process.platform !== 'win32' })
const timer = setTimeout(() => {
  console.error(`smoke test failed: still running after ${TIMEOUT_MS / 1000} s`)
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'])
  else process.kill(-child.pid!, 'SIGKILL')
  process.exit(1)
}, TIMEOUT_MS)
child.on('error', (error) => {
  console.error(`smoke test failed: ${error.message}`)
  process.exit(1)
})
child.on('exit', (status, signal) => {
  clearTimeout(timer)
  if (status !== 0) {
    console.error(`smoke test failed: ${signal ? `killed by ${signal}` : `exit code ${status}`}`)
    process.exit(1)
  }
  console.log('smoke test passed')
})
