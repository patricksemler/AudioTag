# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A fixed cover-art preview column at the left of the file grid. Thumbnails are
  downscaled in the backend and fetched lazily (only for on-screen rows, batched
  and cached) so the column stays cheap even for very large libraries.
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
- Undo/redo for tag edits (Cmd/Ctrl+Z and Shift+Z / Ctrl+Y). Undo history is
  kept across saves, so you can undo an already-saved edit; the restored values
  are marked unsaved again and written back on the next Save.
- Copy and paste tags between files with Cmd/Ctrl+C and Cmd/Ctrl+V (in addition
  to the right-click menu). Copying also captures the cover art, which is
  embedded into the target files on the next save.

### Changed

- Dragging files or folders over the window now outlines the drop target (the
  file grid, or the whole workspace when empty) with a dashed accent border
  instead of dimming the whole app behind a centered card.
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
- Files now appear in the grid **as they load** — a folder scan streams rows in
  batches and shows "Scanning… N of M" progress, instead of a blank wait until
  the entire folder finishes. A **Cancel** button stops a long scan, keeping the
  files loaded so far.
- Saving many files now shows "Saving N of M" progress and can be **cancelled** —
  files already written stay saved; the rest keep their unsaved marker.
- Folder scanning is faster: reads now skip parsing audio-stream properties
  (duration/bitrate) that the app never displays — up to ~50% less per-file
  parse time on compressed formats (m4a/ogg/opus) — and files are read with
  bounded parallelism (~1.6× faster on mixed libraries, ~2× on art-heavy ones).
  Tag data and ordering are unchanged.
- The file grid and tag editor stay responsive with very large libraries:
  grid rows are memoized (keyboard navigation and inline edits re-render only
  the affected rows), selection-derived state is computed proportional to the
  selection rather than the whole list, the tag editor computes mixed values in
  a single pass, and find/replace compiles its pattern once.
- The window now behaves like a native app instead of a web page: text can
  only be selected inside editable fields (no more highlighting button, header,
  or grid text, and no Ctrl/Cmd+A selecting the whole UI), and the I-beam
  cursor only appears over text fields.
- Suppressed browser-only gestures the webview inherited — reload, print,
  in-engine zoom/pinch (Ctrl/Cmd with +/-/0 and Ctrl+scroll), history
  back/forward, and HTML drag of images/elements. OS-level file drag-and-drop
  and column reordering are unaffected.
- Starting an inline cell edit now collapses a multi-row selection to the row
  being edited, so an active "select all" (Ctrl/Cmd+A) highlight clears instead
  of lingering behind the editor.
- Opening an inline cell editor now selects the whole value, so it can be
  overwritten immediately (click within the field to place the caret instead).
- Pressing Enter in an inline cell editor now commits the edit and drops
  straight into editing the same column on the next row (spreadsheet-style),
  skipping unreadable files and stopping at the last row.

### Fixed

- Committing an inline cell edit without changing the value no longer records a
  no-op undo step, which had made the first Undo appear to do nothing (a second
  Undo was needed to reach the actual edit).
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
- Selected rows now keep their highlight in the floating column that follows the
  cursor while dragging a column header to reorder it.
