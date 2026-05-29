# 9. Cover-art thumbnails in the file grid

Date: 2026-05-29

## Status

Accepted

## Context

The grid gained a fixed leftmost column showing a small preview of each file's
embedded cover. Done naively this is a performance trap:

- Embedded covers are routinely 200 KB–several MB. Shipping full-resolution art
  over the IPC boundary for every row — re-sent on every scroll — would dwarf
  the tag payloads the rest of the app is careful to keep small (ADR 0006/0007).
- The grid is virtualized and its rows are memoized (`GridRow` + `rowsEqual`).
  Threading thumbnail data through row props would re-render rows as art loads,
  defeating the memo that keeps arrow-key/selection cost independent of row
  count.
- The cover column must not disturb the existing column drag/resize/reorder
  maths, which measure pointer positions against the reorderable header.

## Decision

**Downscale in the backend.** A new `get_cover_thumbnails(paths)` command
decodes each file's first picture (via the `image` crate, format sniffed from
the bytes), downscales it to a ≤64 px PNG, and returns base64 keyed by path.
Payloads drop from hundreds of KB to ~1–3 KB. Decoding reuses the bounded
scan-worker pool (ADR 0007): the batch is split into contiguous chunks across
`min(cores, 8)` scoped threads. Files with no/undecodable art are omitted.

**Lazy + batched + cached on the frontend.** `coverThumbs.ts` is a tiny
external store. Each thumbnail cell subscribes *by path* via
`useSyncExternalStore` and requests its thumbnail on mount (i.e. when it scrolls
into view). Requests made in the same tick are coalesced (microtask flush) into
one IPC call. Results are cached for the session, so scrolling never refetches;
an in-flight set prevents duplicate requests. `invalidate(path)` is called when
pasted art is saved to disk so the preview refreshes.

**Column lives outside the GRID_COLUMNS machinery.** The cover column is
rendered as a fixed-width leading cell in the header viewport and in each row,
not as a `GRID_COLUMNS` entry. It is therefore immovable (no reorder/resize/
sort) by construction, and the reorder/resize geometry — which measures against
the reorderable `.grid-header` only — is untouched.

## Consequences

- Subscribing cells re-render in isolation: a thumbnail resolving repaints just
  that one cell, never the row or its siblings, so the `GridRow` memo holds.
- Backend CPU does the decode/resize once per file per session; the result is
  cached. Memory is bounded by the cached thumbnails (~1–3 KB × distinct files
  ever scrolled into view), not by full-res art.
- A pending pasted cover (in memory, not yet saved) is rendered directly so the
  preview is immediate; only the disk-backed path goes through the store.
- New dependency: `image`, restricted to the decoders embedded art actually uses
  (jpeg/png/gif/bmp/webp) plus the PNG encoder, to limit compile time and binary
  size. Adding a format later is a one-line feature addition.
- Rollback is removing the column cells, the store, and the command; the tag
  pipeline is unaffected.
