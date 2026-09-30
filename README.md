<p align="center"><img src="build/icon.svg" width="96" alt="" /></p>

# Quick Ask

Hold a key, ask out loud, let go, and the answer appears in a small overlay on top of whatever you're doing. Quick Ask lives in the system tray (menu bar on macOS) and works on Windows, macOS and Linux.

- **Push-to-talk**: hold right Ctrl (right Option on macOS) while you speak, release to send.
- **Follow-ups**: while the answer is still on screen, hold the key again to continue the same conversation. Close the panel and the next question starts fresh.
- **Any model**: bring your own [OpenRouter](https://openrouter.ai) key and pick the answering and transcription models from the tray menu.
- **Private by default**: audio never touches the disk, the key is encrypted with the OS keychain, and nothing goes anywhere except OpenRouter.

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
- **Linux (Wayland)**: apps can't listen to global keys. Bind `quick-ask --toggle` to a system shortcut: the first press starts recording, the second sends it.

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) (in Polish).

## License

[MIT](LICENSE)
