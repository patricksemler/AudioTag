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
