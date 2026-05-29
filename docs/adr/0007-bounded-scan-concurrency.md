# 7. Read tags with bounded parallelism

Date: 2026-05-29

## Status

Accepted

## Context

After streaming (ADR 0006) gave fast time-to-first-row, total scan time was
still single-threaded — `scan_paths` and the streamed scan read files one at a
time. Tag parsing is largely CPU-bound, so multiple cores should help, but
PLAN.md §5.2 warns against unbounded parallelism (HDD thrashing, and peak memory
multiplying when art-bearing files are read concurrently).

## Decision

Read in bounded parallel via `read_slice(files, workers)`:

- `workers = min(available_parallelism, 8)` (`MAX_SCAN_WORKERS`), conservative
  so a single spinning disk can't thrash.
- Order-preserving by construction: the slice is split into **contiguous**
  chunks, each read on its own scoped thread, and the per-chunk `Vec`s are
  concatenated — so the result is byte-identical to a sequential read (no
  index-reassembly bookkeeping). Proven by `parallel_read_matches_sequential`.
- The streamed scan reads **one batch at a time** in parallel, so at most one
  `SCAN_BATCH` (200) of tracks — and at most `workers` embedded covers — are
  resident at once. Peak memory does not scale with library size or Σ art bytes.
- Cancellation still checked between batches; per-file errors still surface as
  errored `Track`s (each thread calls the same `read_track`).

## Consequences

Measured on Apple M4 (10 cores, SSD), `scan_parallel` bench, w1 → w8:

- `medium` (5,000 mixed): 140 ms → 85 ms (**~1.6×**)
- `art-heavy` (200 × ~3 MB cover): 122 ms → 59 ms (**~2.1×**)

A clear win with bounded memory and identical output, so it ships on by default.

- Rollback is trivial: `MAX_SCAN_WORKERS = 1` (or `read_slice`'s `workers <= 1`
  guard) reverts to sequential.
- Diminishing returns past ~4 workers (I/O / memory-bandwidth bound, not 10×
  CPU), hence the cap. On a single HDD, high concurrency could hurt; the
  conservative cap and contiguous chunking keep it reasonable, and the cap is a
  one-line change if a real-world HDD regression is reported.
