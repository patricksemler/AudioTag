# AudioTag

A free, open-source, cross-platform (Windows + macOS) audio **tag editor** —
Mp3tag-class power with a friendlier, accessible UX.

> Status: **v0 (early)** — manual + (soon) batch tagging. No online lookup or
> playback yet (both on the roadmap).

## Features (v0)

- Open folders (recursive) or individual files.
- Spreadsheet-style file grid: keyboard-navigable, multi-select.
- Tag editor for the selection — edit many files at once with mixed-value
  (`Multiple values`) handling.
- Reads/writes **MP3, FLAC, M4A/MP4, AAC, OGG, Opus, WAV, AIFF, APE, WavPack,
  MPC, Speex** (everything [`lofty`](https://github.com/Serial-ATA/lofty-rs)
  supports). WMA is intentionally out of scope.
- Embedded cover-art preview.
- Staged edits with **Save** / **Revert** (nothing is written until you save).
- Accessible by design: full keyboard operation, screen-reader semantics,
  light/dark themes, respects reduced-motion.

## Tech

- **[Tauri 2](https://tauri.app)** (Rust core) + **React + TypeScript** UI.
- **[lofty](https://github.com/Serial-ATA/lofty-rs)** for tag read/write.

## Develop

Prerequisites: [Rust](https://rustup.rs), [Node](https://nodejs.org) +
[pnpm](https://pnpm.io), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev      # run the desktop app in dev mode
pnpm build          # typecheck + build the frontend
pnpm tauri build    # produce a distributable installer
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture decisions live in
[`docs/adr/`](docs/adr/).

## License

[MIT](LICENSE).
