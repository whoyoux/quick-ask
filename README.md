<p align="center"><img src="build/icon.svg" width="96" alt="" /></p>

# Quick Ask

Hold a key, ask out loud, let go, and the answer appears in a chat window; while you speak, a small pill floats on top of whatever you're doing. Quick Ask lives in the system tray (menu bar on macOS) and works on Windows, macOS and Linux.

- **Push-to-talk**: hold right Ctrl (right Option on macOS) while you speak, release to send.
- **Follow-ups**: while the chat window is open, hold the key again (or type) to continue the same conversation. Close it and the next question starts fresh.
- **Any model**: bring your own [OpenRouter](https://openrouter.ai) key and pick the answering and transcription models from the tray menu.
- **Tools**: the model can run JavaScript in a sandbox for exact math and data work (paste a table and ask), draw charts, convert currencies at the National Bank of Poland's rates, check the weather and convert between time zones. Each one can be switched off under **Narzędzia AI** in the tray.
- **Private by default**: audio never touches the disk, the key is encrypted with the OS keychain, and nothing goes anywhere except OpenRouter (and GitHub, to check for new versions; you can turn that off in the tray menu). The currency and weather tools also send just a currency code or a place name to [NBP](https://api.nbp.pl) or [Open-Meteo](https://open-meteo.com).

## Install

Download the installer for your system from [Releases](https://github.com/whoyoux/quick-ask/releases). The builds aren't code-signed yet, so the first launch needs one extra step:

- **Windows** (`…-win-x64-setup.exe`): if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
- **macOS** (`…-mac-arm64.dmg` for Apple Silicon, `…-mac-x64.dmg` for Intel): macOS reports an unsigned download as "damaged" or unverified. After dragging the app to Applications, run `xattr -dr com.apple.quarantine "/Applications/Quick Ask.app"` once.
- **Linux** (x64, glibc 2.34+, e.g. Ubuntu 22.04, Debian 12, Fedora 35 or newer): on Debian and Ubuntu install the `.deb` with `sudo apt install ./quick-ask-*.deb`; it pulls in everything it needs. Elsewhere, make the `.AppImage` executable and run it. It needs FUSE 2 (`libfuse2`) and the X11 libraries push-to-talk links against: libX11, libXrandr, libXtst and libXt (`libx11-6 libxrandr2 libxtst6 libxt6` on Debian, `libX11 libXrandr libXtst libXt` on Fedora, `libx11 libxrandr libxtst libxt` on Arch). Most desktops already have them.

### Updates

Quick Ask checks [Releases](https://github.com/whoyoux/quick-ask/releases) for a new version shortly after it starts and every few hours (turn it off with **Sprawdzaj aktualizacje automatycznie** in the tray menu, or check by hand with **Sprawdź aktualizacje**):

- **Windows** and the Linux **AppImage** download the update in the background and install it the next time you quit Quick Ask, or right away with **Uruchom ponownie i zaktualizuj**.
- The Linux **.deb** downloads it the same way; **Uruchom ponownie i zaktualizuj** installs it and asks for your password.
- **macOS** only tells you about the new version and links to its download, because macOS installs updates only for signed apps.

## How it works

```
hold key ─▶ record (webm/opus) ─▶ OpenRouter /audio/transcriptions ─▶ question text
                                                   │
                    chat window ◀── streamed answer ◀── OpenRouter /chat/completions
```

When the model calls a tool, the app runs it and sends the result back until the model has its answer: JavaScript runs in [QuickJS](https://github.com/vercel-labs/quickjs-wasi) compiled to WebAssembly, on a worker thread, with no network or file access and limits on memory and time. Charts are ` ```vega-lite ` blocks in the answer, drawn with [Vega-Lite](https://vega.github.io/vega-lite/) without loading anything from the network.

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
| `npm run test:history` | Tests the conversation history database |
| `npm run test:tools` | Tests the model's tools and the tool-call stream, without network |
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

The Release workflow builds the installers on macOS, Windows and Linux and attaches them to a draft GitHub Release, together with the `latest*.yml` files, zips and blockmaps the updater reads; review the notes and publish it. Installed apps see the new version only once the release is published (drafts and pre-releases are ignored), so don't delete those extra files from it. Running the workflow by hand only builds the installers and keeps them as workflow artifacts. Local `npm run dist` packages for the current OS only.

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) (in Polish).

## License

[MIT](LICENSE)
