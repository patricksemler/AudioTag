# 6. Stream scan results to the UI over a Tauri Channel

Date: 2026-05-29

## Status

Accepted

## Context

`scan_paths` read every file and returned one `Vec<Track>`; the UI showed
nothing until the entire scan finished (time-to-first-row ≈ total scan time).
For large libraries that is a long, feature-less wait with no feedback.

## Decision

Add `scan_paths_streamed(paths, channel)` alongside (not replacing) `scan_paths`.
It walks + sorts the file list once, then reads tags in batches of
`SCAN_BATCH` (200) and emits typed events over a **Tauri `Channel<ScanEvent>`**
passed as a command argument:

- `Total { count }` once, before any batch,
- `Batch { tracks }` per chunk, in final sorted order,
- `Progress { done, total }` after each batch,
- `Done` when finished.

Errored files are **folded into batches** as errored `Track`s (not separate
events), exactly as `scan_paths` already returns them, so the two paths stay
equivalent.

Client side: `App` keeps a running accumulator (seeded from the already-loaded
rows) and appends each batch with one `commitRows`, deduping against a `known`
set. Initial selection is set **only on the first batch when the list started
empty**, so streaming never steals keyboard focus mid-scan. A `USE_STREAMING`
flag falls straight back to `scan_paths`.

A Channel (per-operation, typed) is used rather than global `emit`/`listen`,
which would need manual routing to distinguish concurrent operations.

## Consequences

- First rows paint after the first batch (~200 files) instead of after the whole
  scan; the UI stays responsive and shows "Scanning… N of M".
- Concatenating every batch's tracks reproduces `scan_paths(paths)` byte-for-byte
  (same order, same errored rows) — proven by `streamed_scan_matches_blocking`.
- The accumulator is the source of truth during a scan (not `rowsRef`, which
  only updates on render), so batches arriving faster than React re-renders
  cannot drop rows.
- Cancellation and an accessible progress/Cancel UI build on this in the next
  phase; the channel + batch loop already have the natural insertion point.
- `scan_paths` is retained for rollback and small/programmatic scans.
