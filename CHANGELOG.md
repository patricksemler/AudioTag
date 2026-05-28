# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial v0: Tauri 2 + React/TypeScript app skeleton.
- Open folders (recursive) and individual audio files via native dialogs.
- Accessible, virtualized file grid with keyboard navigation and multi-select.
- Tag editor panel supporting single- and multi-file editing with mixed-value
  handling.
- Tag read/write across all `lofty`-supported formats (no WMA) via a Rust
  backend (`scan_paths`, `save_tracks`, `get_cover_art` commands).
- Embedded cover-art preview.
- Staged edits with Save / Revert; Cmd/Ctrl+S shortcut.
- Light/dark theming and reduced-motion support.
- Batch **find & replace** across a single field or all text fields, with an
  optional match-case toggle; operates on the selection, or every loaded file
  when nothing is selected (numeric fields excluded from the all-fields scope).
- Collapsible tag-editor sidebar, so the file grid can use the full width.
- The toolbar now shows the name of the file currently in focus.
- Downloadable macOS (universal) and Windows installers, produced by a local
  build script (`scripts/release.sh`) — macOS built natively, Windows
  cross-compiled in a container — and published to GitHub Releases.

### Changed

- Replaced emoji UI glyphs with [lucide](https://lucide.dev) icons for
  consistent cross-platform rendering.
- Track and disc numbers are now shown as a compact "Track _n_ of _n_" row in
  the tag editor instead of four stacked fields.
