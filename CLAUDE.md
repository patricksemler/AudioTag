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

## Roadmap (not yet built)

Batch ops (rename↔filename, find/replace, case/cleanup, album-art writing),
undo/redo history, virtualization tuning, online lookup, playback. See README.
