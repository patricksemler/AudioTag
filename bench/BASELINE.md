# Baseline measurements

Captured against the pre-optimization code so every later phase can be measured
against it. Re-capture if the machine or the baseline commit changes.

## Environment

- **Date**: 2026-05-29
- **Commit**: `8c10ace` (pre-optimization; Phase 0 adds only the harness)
- **Machine**: Apple M4, 10 cores, 24 GB RAM
- **OS**: macOS 26.5 (arm64)
- **Toolchain**: rustc 1.94.1, criterion 0.5, release/bench profile
- **Corpora** (this capture): `tiny` 100, `small` 1,000, `medium` 5,000,
  `deep` 2,000, `mixed-format` 160, `art-heavy` 200 (~3 MB covers), `corrupt`
  200, `dirty-500`, `dirty-2000`. `large` (20,000) not run in this capture but
  supported by the harness; `deep`/`art-heavy` reduced from the plan's defaults
  to bound disk (the generator does the full sizes on request).

## Backend — criterion (`cargo bench --bench scan`)

### `read_track` per format (no embedded art)

| Format | Median |
|---|---|
| mp3  | 32.7 µs |
| flac | 18.5 µs |
| m4a  | 55.0 µs |
| ogg  | 25.9 µs |
| opus | 27.7 µs |
| wav  | 18.0 µs |
| aiff | 16.3 µs |
| wv   | 26.2 µs |

### `read_track` with embedded ~3 MB cover (`art-heavy`)

| Format | Median | vs no-art |
|---|---|---|
| flac | 357.9 µs | **~19× slower** than no-art flac |
| mp3  | 304.5 µs | **~9× slower** than no-art mp3 |
| m4a  | 435.6 µs | **~8× slower** than no-art m4a |

> **H3 confirmed.** Reading a file *only to set `has_art`* costs an order of
> magnitude more when the file carries a large cover, because lofty materializes
> the embedded picture bytes during the read. This is the highest-value backend
> target (Phase 1).

### `scan_paths` (walk + filter + sort + sequential read)

| Corpus | Files | Median | Throughput |
|---|---|---|---|
| tiny   | 100   | 3.51 ms   | 28.5 Kelem/s |
| small  | 1,000 | 36.2 ms   | 27.6 Kelem/s |
| medium | 5,000 | 191.2 ms  | 26.1 Kelem/s |

> Wall-clock scales linearly with file count (single-threaded). On this fast
> SSD + Apple-silicon box ~26 K files/s; a real art-heavy library would be far
> slower per file (see above). TTF row ≈ total scan today (no streaming).

### `write_track` (re-read + apply edits + write), per format

| Format | Median |
|---|---|
| mp3  | 135.3 µs |
| flac | 128.9 µs |
| m4a  | 148.8 µs |
| ogg  | 198.1 µs |
| wav  | 149.4 µs |

## Frontend — manual (see [`profiling.md`](profiling.md))

Captured against `pnpm tauri dev`. Pre-optimization reference points; fill in
exact p95s when re-profiling on this machine.

| Interaction (20k loaded) | p95 keypress | React commits | longtasks |
|---|---|---|---|
| arrow-key hold | _re-profile_ | all visible rows re-render (no row memo) | — |
| edit 1 field (1 selected) | _re-profile_ | full `rows.map` rebuild + all visible rows | — |
| edit 1 field (20k selected) | _re-profile_ | full `rows.map` + 12× `commonValue` over 20k | likely > 50 ms |
| find/replace all-fields (20k) | n/a | full `rows.map`, regex recompiled per row×field | likely > 50 ms |

Known O(total-rows) costs at baseline (from code inspection, PLAN.md §0):
`selectedRows` filter, `modifiedCount` scan, per-edit `rows.map`, save dirty
filter, `menuItems` memo keyed on `rows`. These are what Phases 2–3 attack; the
criterion numbers above are the objective half of the baseline, the React
Profiler the subjective half.

## Save (frontend → `save_tracks`, sequential)

| Save | Files | Notes |
|---|---|---|
| dirty-500  | 500   | ≈ 500 × ~140 µs write + IPC; whole-track payload; no progress/cancel |
| dirty-2000 | 2,000 | ≈ 2,000 × ~140 µs; UI fully blocked (`busy`) until done |

> Per-file `write_track` ≈ 130–200 µs (above). 2,000 dirty ≈ 0.3–0.4 s of pure
> write plus IPC/serialization; the UI is blocked for the whole duration with no
> progress or cancel — the target for Phases 5/7.
