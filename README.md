# Strudel Shaper

A browser-based [Strudel](https://strudel.cc) live-coding editor where you audition code variations on the running clock. This repo is at **Milestone 1**: the audition spike, with hard-coded options and no AI.

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # Vitest unit tests
npm run build    # typecheck + production build
```

1. Click **▶ Play**. Browsers only allow audio after a click, so the first mouse click on the page starts the audio context.
2. Select `s("hh*8").gain(0.6)` in the editor and press **⌘K** (macOS) or **Ctrl+K**.
3. With the tray focused, use these keys:

| Key | Action |
| --- | --- |
| `1`–`4` | Hear that option. The editor text does not change. |
| `0` / `Esc` | Back to the original (the editor's real text) |
| `Enter` | Commit the option you're hearing. This is one undo step. |
| `Esc` (on original) | Close the tray |

Each swap logs a `[shaper] swap` line in the browser console with the scheduler's cycle position. `window.__shaper.swapLog` holds the same data.

See [NOTES.md](NOTES.md) for the Strudel internals this relies on, timing measurements, and a manual listening checklist.

## License

AGPL-3.0-or-later, the same license as Strudel, which this app embeds. The full text is in [LICENSE](LICENSE). The complete source of this app is in this repository.
