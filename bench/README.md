# AudioTag benchmark harness

This directory holds the performance-measurement harness that gates the
optimization work in [`PLAN.md`](../PLAN.md). **Every perf change is measured
against the baseline captured here before it lands.**

## What's here

- [`BASELINE.md`](BASELINE.md) — the captured baseline numbers (machine, OS,
  commit, corpus). Re-captured when the hardware or baseline shifts.
- [`profiling.md`](profiling.md) — the manual frontend profiling procedure
  (DevTools / React Profiler / `PerformanceObserver` snippets).
- The corpus generator lives at [`../scripts/gen-corpus.sh`](../scripts/gen-corpus.sh).
- The Rust benches live at [`../src-tauri/benches/scan.rs`](../src-tauri/benches/scan.rs).

## 1. Generate corpora

The corpora live under `bench-data/` (git-ignored). They are **format-diverse**
and one is **art-bearing** — the old WAV-only set hid the real per-file parse
cost (see PLAN.md §4.2). Requires `ffmpeg`.

```bash
scripts/gen-corpus.sh                 # everything except large + art-heavy
scripts/gen-corpus.sh large art-heavy # the multi-GB corpora, on demand
FORCE=1 scripts/gen-corpus.sh small   # regenerate one corpus
```

Corpora and default sizes (override with env vars, e.g. `MEDIUM=2000`):

| Corpus | Files | Shape |
|---|---|---|
| `tiny` | 100 | mixed format, shallow tree |
| `small` | 1,000 | mixed format |
| `medium` | 5,000 | mixed format |
| `large` | 20,000 | mixed format (multi-GB; opt-in) |
| `deep` | 5,000 | 4-level nested tree |
| `mixed-format` | 160 | 20 files × 8 formats (every encodable ext) |
| `art-heavy` | 1,000 | ~3 MB embedded cover each (multi-GB; opt-in) |
| `corrupt` | 200 | truncated / zero-byte / text-as-mp3 / `.wma` / read-only / unicode / long-name + valid files |
| `dirty-500`, `dirty-2000` | 500 / 2,000 | valid files the save bench mutates |

Formats covered: `mp3 flac m4a ogg opus wav aiff wv`. `ape`, `mpc`, `spx` are
omitted (ffmpeg has no encoder); lofty still reads/writes them in the app.

## 2. Backend benchmarks (criterion)

```bash
cargo bench --manifest-path src-tauri/Cargo.toml
# or a quick subset:
cargo bench --manifest-path src-tauri/Cargo.toml -- read_track_per_format
```

Bench groups (in `scan.rs`): `read_track_per_format`, `read_track_art`,
`scan_paths` (tiny/small/medium/large), `write_track`. Missing corpora are
skipped with a note, so a fresh checkout still runs.

## 3. Backend timing spans

Set `AUDIOTAG_TIMING=1` to print per-stage timing to stderr (visible in the
`pnpm tauri dev` console) from `scan_paths` (walk / sort+dedup / read /
serialized bytes) and `save_tracks` (total / slowest file):

```bash
AUDIOTAG_TIMING=1 pnpm tauri dev
```

## 4. Frontend profiling

See [`profiling.md`](profiling.md) for time-to-first-row, keypress latency,
long-task, React-commit, IPC-payload, and memory procedures.

## 5. Capturing a baseline

1. Generate corpora (§1).
2. `cargo bench` (§2) — record per-format read, scan, write numbers.
3. Run the app with `AUDIOTAG_TIMING=1` and the frontend snippets (§3–4),
   exercising each corpus + interaction.
4. Fill the table in [`BASELINE.md`](BASELINE.md).
