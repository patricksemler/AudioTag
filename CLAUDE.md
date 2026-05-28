# AudioTag — notes for AI assistants

AudioTag is a free, MIT-licensed, cross-platform (Windows + macOS) audio tag
editor. Tauri 2 (Rust) backend + React/TypeScript frontend. Tagging via `lofty`.

## Commands

```bash
pnpm install              # install frontend deps
pnpm tauri dev            # run the desktop app
pnpm build                # typecheck (tsc) + vite build the frontend
pnpm typecheck            # tsc --noEmit
pnpm lint                 # eslint (includes jsx-a11y)
cd src-tauri && cargo check     # compile-check Rust
cd src-tauri && cargo clippy    # lint Rust
cd src-tauri && cargo fmt       # format Rust

scripts/release.sh              # build installers locally (mac native + win container)
UPLOAD=1 scripts/release.sh     # …and publish to a GitHub Release
```

Releases are built locally, not in CI: macOS natively, Windows cross-compiled
in a Linux container (`build/windows.Dockerfile`, NSIS only — WiX/MSI can't
cross-compile). Run on a Mac to get the macOS build.

## Layout

- `src/` — React UI. `components/` holds Grid/TagEditor/Toolbar/StatusBar.
  `api.ts` wraps Tauri `invoke`. `types.ts` mirrors the Rust `Track` struct.
  `fields.ts` is the single source of truth for editable fields + columns.
- `src-tauri/src/tags.rs` — all tag logic and the Tauri commands.
- `src-tauri/src/lib.rs` — app setup + command registration.

## Conventions

- GitHub Flow; Conventional Commits; PRs into `main`.
- **Accessibility is a definition-of-done item** for any UI change (keyboard +
  screen reader). Target WCAG 2.2 AA.
- WMA/ASF is intentionally unsupported (lofty can't write it).
- Editable tag fields are strings end-to-end; numeric validation is UI-side.

## Keep docs in sync (definition of done)

Every change must leave the Markdown docs accurate — this is part of "done",
not a follow-up:

- **CHANGELOG.md** — add an entry under `## [Unreleased]` (Keep a Changelog:
  Added / Changed / Fixed / Removed) for any user-facing change. CI enforces
  this: PRs that touch `src/` or `src-tauri/src/` must also update
  `CHANGELOG.md`. For genuinely non-user-facing work (formatting, internal
  refactors, CI tweaks), put `[skip changelog]` in the PR title.
- **README.md** — update when capabilities, supported formats, or
  install/build steps change. Keep it user-facing (what it is / does / how to
  get it), not a status log.
- **docs/adr/** — add a new numbered MADR file for notable architectural
  decisions.
- **This file (CLAUDE.md)** — update when commands, layout, or conventions
  change.

## Roadmap (not yet built)

Remaining batch ops (rename↔filename, case/cleanup, album-art writing),
undo/redo history, virtualization tuning, online lookup, playback. Done so far:
batch find/replace, drag-and-drop + session restore, inline grid editing, and a
right-click menu with copy/paste/clear/remove plus an additional-tags editor.
See README.

Note: the additional-tags editor operates on lofty's generic `Tag`, so it can
edit/add any of lofty's recognized keys (keyed by their format-native names).
Truly free-form keys a format doesn't recognize are reported as skipped on save
rather than written. See `docs/adr/0004-arbitrary-tag-editing.md`.
