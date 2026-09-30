<p align="center"><img src="build/icon.svg" width="96" alt="" /></p>

# Quick Ask

Hold a key, ask out loud, let go, and the answer appears in a small overlay on top of whatever you're doing. Quick Ask lives in the system tray (menu bar on macOS) and works on Windows, macOS and Linux.

- **Push-to-talk**: hold right Ctrl (right Option on macOS) while you speak, release to send.
- **Follow-ups**: while the answer is still on screen, hold the key again to continue the same conversation. Close the panel and the next question starts fresh.
- **Any model**: bring your own [OpenRouter](https://openrouter.ai) key and pick the answering and transcription models from the tray menu.
- **Private by default**: audio never touches the disk, the key is encrypted with the OS keychain, and nothing goes anywhere except OpenRouter.

## Install

Download the installer for your system from [Releases](https://github.com/whoyoux/quick-ask/releases). The builds aren't code-signed yet, so the first launch needs one extra step:

- **Windows** (`…-win-x64-setup.exe`): if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
- **macOS** (`…-mac-arm64.dmg` for Apple Silicon, `…-mac-x64.dmg` for Intel): macOS reports an unsigned download as "damaged" or unverified. After dragging the app to Applications, run `xattr -dr com.apple.quarantine "/Applications/Quick Ask.app"` once.
- **Linux** (x64, glibc 2.34+, e.g. Ubuntu 22.04, Debian 12, Fedora 35 or newer): on Debian and Ubuntu install the `.deb` with `sudo apt install ./quick-ask-*.deb`; it pulls in everything it needs. Elsewhere, make the `.AppImage` executable and run it. It needs FUSE 2 (`libfuse2`) and the X11 libraries push-to-talk links against: libX11, libXrandr, libXtst and libXt (`libx11-6 libxrandr2 libxtst6 libxt6` on Debian, `libX11 libXrandr libXtst libXt` on Fedora, `libx11 libxrandr libxtst libxt` on Arch). Most desktops already have them.

## How it works

```
hold key ─▶ record (webm/opus) ─▶ OpenRouter /audio/transcriptions ─▶ question text
                                                   │
                        overlay ◀── streamed answer ◀── OpenRouter /chat/completions
```

Electron's built-in `globalShortcut` only reports key presses, so push-to-talk listens to raw key down/up events through [`uiohook-napi`](https://github.com/SnosMe/uiohook-napi). Answers are rendered while streaming with [Streamdown](https://streamdown.ai).

## Development

Requires Node 22.18+.

```bash
npm install
npm run dev
```

On first launch a window asks for your OpenRouter API key. Other scripts:

| Script | What it does |
|---|---|
| `npm run typecheck` | Type-checks the main process and the renderer |
| `npm run build` | Bundles main, preload and renderer into `out/` |
| `npm run icons` | Regenerates every icon from the vector mark in `scripts/make-icons.ts` |
| `npm run dist` | Builds installers into `release/` |

Set `QUICK_ASK_DEBUG=1` to log push-to-talk and overlay events to the console.

### Platform notes

- **macOS**: global key listening needs the Accessibility permission; the app asks for it on first launch.
- **Linux (Wayland)**: apps can't listen to global keys. Bind `quick-ask --toggle` (or `/path/to/the.AppImage --toggle`) to a system shortcut: the first press starts recording, the second sends it.

### Releases

CI type-checks and builds every push to `main` and every pull request. To publish a version, bump `version` in `package.json`, then tag and push:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The Release workflow builds the installers on macOS, Windows and Linux and attaches them to a draft GitHub Release; review the notes and publish it. Running the workflow by hand only builds the installers and keeps them as workflow artifacts. Local `npm run dist` packages for the current OS only.

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) (in Polish).

## License

[MIT](LICENSE)
