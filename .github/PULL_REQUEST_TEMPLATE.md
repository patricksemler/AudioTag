<!-- Conventional Commit style title, e.g. "feat: …", "fix: …", "perf: …".
     Add [skip changelog] to the title only for non-user-facing changes
     (internal refactors, CI, benches). -->

## What & why

<!-- What does this change do, and why? -->

## Definition of done

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm build` pass
- [ ] `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` pass
- [ ] **CHANGELOG.md** updated under `[Unreleased]` (or `[skip changelog]` in the title)
- [ ] **README / CLAUDE.md / ADR** updated if capabilities, commands, or decisions changed
- [ ] **Accessibility** checked for any UI change (keyboard + screen reader)
- [ ] **Data safety** preserved (no tag-write regression)

## Performance (required for perf PRs)

<!-- Delete this section for non-perf PRs. -->

- **Corpus / machine**: <!-- e.g. medium (5k mixed), Apple M4 -->
- **Before → after**:

  | Metric | Before | After |
  |---|---|---|
  |  |  |  |

- **Why it's faster** (one line): <!-- the mechanism, not just the number -->
- [ ] Numbers recorded in `bench/BASELINE.md` if this shifts the baseline
