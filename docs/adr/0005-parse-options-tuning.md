# 5. Skip audio-property parsing on reads; keep cover-art parsing for `has_art`

Date: 2026-05-29

## Status

Accepted

## Context

`read_track` (and the read-only commands `get_cover_art`, `read_all_tags`) used
`lofty::read_from_path`, which parses everything: tag items, **audio stream
properties** (duration / bitrate / sample-rate), and **embedded cover art**.

Two facts from the Phase 0 baseline (`bench/BASELINE.md`):

1. The UI displays **no** audio properties (`Track` has no duration/bitrate
   fields; the grid has no such column). Parsing them is pure waste.
2. Reading a file with a large embedded cover costs ~8–19× a no-art read,
   because lofty materializes the picture bytes during the read — even though we
   only need a boolean `has_art`.

lofty 0.24's `ParseOptions` exposes `read_properties(bool)` and
`read_cover_art(bool)`.

## Decision

- **Read with `read_properties(false)`** in `read_track`/`get_cover_art`/
  `read_all_tags` (via a shared `open_tagged(path, read_properties)` helper).
  The write paths (`write_track`, `save_all_tags`) keep parsing everything —
  data safety over speed (PLAN.md §5.1/§13).
- **Keep `read_cover_art(true)`.** Disabling it would make lofty seek past the
  picture block entirely, which is faster — but `tag.pictures()` would then be
  empty for *every* file, silently zeroing `has_art`. lofty 0.24 offers **no
  cheaper presence check** (no "picture count without bytes"). A wrong `has_art`
  would regress the editor's art display and the clear/paste/save art semantics
  (PLAN.md §11/§13), so we do not take it.

## Consequences

- Byte-identical `Track` output, proven by the `properties_off_parity` test
  across all eight encodable formats, and `has_art_parity` for art presence.
- Measurable read speedup where property parsing is expensive: **m4a ~−53%,
  ogg ~−36%, opus ~−31%, wv ~−13%**; neutral for mp3/flac/wav/aiff (property
  parsing there is already trivial). Net win on mixed libraries with no
  downside.
- Art-bearing files see only a marginal delta from props-off (cover
  materialization dominates). Bounding the **peak memory** of art-heavy scans is
  therefore deferred to the streaming + bounded-concurrency phases (PLAN.md
  H3/§5.2/§5.3), which cap how many covers are resident at once rather than
  changing per-file cost.
- `read_track`/`write_track`/`read_track_opt` are `pub` + `#[doc(hidden)]` for
  the criterion benches; not a stable public API.
