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
```

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
undo/redo history, virtualization tuning, online lookup, playback. Batch
find/replace is implemented. See README.
