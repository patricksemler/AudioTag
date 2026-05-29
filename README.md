# AudioTag

AudioTag is a free, open-source audio **tag editor** for Windows and macOS. It
lets you view and edit the metadata embedded in your music files — title,
artist, album, track numbers, year, genre, cover art and more — across many
files at once, with a fast keyboard-driven interface that works well with
screen readers.

It aims to give you the editing power of tools like Mp3tag in a lighter,
friendlier, no-cost package.

## What it does

- **Edit one file or thousands.** Open a folder (scanned recursively), pick
  individual files, or drag them straight onto the window, then edit them in a
  spreadsheet-style grid — double-click a cell to edit it in place. Files stream
  into the grid as they're read, so large folders start showing rows right away
  (with progress, and a Cancel button to stop early). AudioTag reopens whatever
  you had loaded last time.
- **Edit many files at once.** Select multiple tracks and change a field for all
  of them together. Fields that differ across the selection show as
  *Multiple values* so you never overwrite data by accident.
- **Find & replace** text across a single field or every field in your
  selection.
- **Copy, paste and clear tags** between files from a right-click menu, and dig
  into the full tag list — adding your own custom tags — with the additional-tags
  editor.
- **See your cover art.** Embedded album artwork is shown for the selected
  track.
- **Edit safely.** Changes are staged in the app — nothing touches your files
  until you hit **Save**, and **Revert** undoes anything unsaved.
- **Works with the formats you actually have:** MP3, FLAC, M4A/MP4, AAC, OGG,
  Opus, WAV, AIFF, APE, WavPack, Musepack and Speex.
- **Built to be accessible:** full keyboard operation, screen-reader-friendly
  semantics, light and dark themes, and respect for your reduced-motion setting.

## Install

Download the installer for your platform from the
[**Releases**](https://github.com/patricksemler/AudioTag/releases) page, then run
it. macOS builds are universal (Apple Silicon and Intel).

These are currently unsigned development builds, so your operating system may
show a warning the first time you open the app.

## Build from source

If you would rather build it yourself, you'll need
[Rust](https://rustup.rs), [Node.js](https://nodejs.org) with
[pnpm](https://pnpm.io), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install        # install dependencies
pnpm tauri dev      # run the app locally
pnpm tauri build    # produce an installer for your platform
```

## Built with

[Tauri](https://tauri.app) (Rust) for the native shell, React + TypeScript for
the interface, and [lofty](https://github.com/Serial-ATA/lofty-rs) for reading
and writing tags.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Notable
design decisions are recorded in [`docs/adr/`](docs/adr/).

## License

[MIT](LICENSE) — free to use, modify, and distribute.
