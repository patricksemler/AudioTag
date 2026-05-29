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
- Resizable tag-editor sidebar — drag the divider between the grid and the
  editor (or focus it and use the arrow keys) to set its width.
- The toolbar now shows the name of the file currently in focus.
- Drag and drop files or folders onto the window to open them.
- The app remembers the files/folders opened last and restores them on launch.
- Single-click a cell in the file grid to edit that tag inline — including
  empty cells.
- Dedicated, left-most **File** column showing each file's name.
- Resizable grid columns: drag the grip on a column header's right edge (or
  focus it and use the arrow keys) to change its width.
- Sortable columns: click a column header to sort by it; click again to
  reverse. Track and Year sort numerically.
- Reorder grid columns by dragging a column header (or focus one and use
  Cmd/Ctrl+Shift+←/→); the column lifts out and the others shift to make room.
- Double-click a column's resize grip to auto-fit it to its widest value.
- Right-click a file for a context menu: copy, paste, and clear tags, remove
  files from the list (without deleting them from disk), and open an
  **additional-tags** editor for viewing and editing any tag in the file —
  including adding your own — beyond the common fields shown in the side panel.
- Downloadable macOS (universal) and Windows installers, produced by a local
  build script (`scripts/release.sh`) — macOS built natively, Windows
  cross-compiled in a container — and published to GitHub Releases.
- Undo/redo for tag edits (Cmd/Ctrl+Z and Shift+Z / Ctrl+Y).
- Copy and paste tags between files with Cmd/Ctrl+C and Cmd/Ctrl+V (in addition
  to the right-click menu). Copying also captures the cover art, which is
  embedded into the target files on the next save.

### Changed

- Replaced emoji UI glyphs with [lucide](https://lucide.dev) icons for
  consistent cross-platform rendering.
- Track and disc numbers are now shown as a compact "Track _n_ of _n_" row in
  the tag editor instead of four stacked fields.
- The additional-tags editor now lists keys by their readable standard names
  (e.g. `TITLE`, `COMPOSER`) instead of raw format-native frame ids like `TIT2`.
- "Clear tags" now also removes embedded cover art.
- The tag editor no longer shows a redundant filename header or a collapse
  button (the focused file's name still appears in the toolbar), giving the
  cover art and fields more room.

### Fixed

- Clicking a field's label in the tag editor no longer moves the cursor into
  that field; editing now starts only when the input itself is clicked.
- Disabled the webview's native right-click menu (reload/inspect) so it no
  longer appears over the app.
- The window no longer rubber-bands or pans when scrolling with a touchpad.
- Fixed the focus outline on tag-editor inputs clipping against their container.
- The file grid no longer draws a heavy blue box around the whole list when
  focused; keyboard focus is now shown on the active row instead.
- The window no longer briefly flashes a blank white screen while launching;
  it stays hidden until the UI has rendered.
