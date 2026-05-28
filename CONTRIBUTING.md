# Contributing to AudioTag

Thanks for your interest! AudioTag is MIT-licensed and welcomes contributions.

## Development setup

1. Install [Rust](https://rustup.rs), [Node](https://nodejs.org) +
   [pnpm](https://pnpm.io), and the
   [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.
2. `pnpm install`
3. `pnpm tauri dev`

## Project layout

```
src/                 React + TypeScript UI
  components/         UI components (grid, tag editor, toolbar, status bar)
  api.ts             Typed wrappers around Tauri commands
src-tauri/src/
  lib.rs             Tauri app setup + command registration
  tags.rs            Tag scanning / reading / writing (lofty)
docs/adr/            Architecture Decision Records (MADR format)
```

## Workflow

We use **GitHub Flow**:

1. Branch off `main`: `feat/…`, `fix/…`, `docs/…`, or `chore/…`.
2. Make focused commits using
   [Conventional Commits](https://www.conventionalcommits.org)
   (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
3. Open a PR into `main`. CI must pass (build on both OSes, lint, typecheck).
4. Squash-merge keeps `main` history linear.

Keep PRs small and focused (ideally < ~400 lines changed).

## Quality bar

- **Frontend:** `pnpm typecheck` and `pnpm lint` must pass.
- **Backend:** `cargo fmt`, `cargo clippy`, and `cargo check` must pass
  (run inside `src-tauri/`).
- **Accessibility is a definition-of-done item.** New UI must be fully
  keyboard-operable and screen-reader friendly (test with VoiceOver on macOS
  or NVDA on Windows).

## Architecture decisions

Significant decisions are recorded as ADRs in [`docs/adr/`](docs/adr/) using
the [MADR](https://github.com/adr/madr) format. Add a new numbered file when
making a notable architectural choice.
