# 4. Arbitrary tag editing via lofty's generic tag

Date: 2026-05-28

## Status

Accepted

## Context

The side panel edits a curated set of ~12 common fields. Users also need to
view and edit *any* tag in a file, and add their own, via an "additional tags"
editor reached from the right-click menu.

`lofty`'s generic `Tag` (ADR 0002) represents tags as a set of `TagItem`s keyed
by a fixed `ItemKey` enum (~100 variants: MusicBrainz IDs, ReplayGain, BPM,
mood, lyrics, conductor, ISRC, …). `ItemKey` has **no** `Unknown(String)`
variant, so a generic `Tag` cannot hold a key it doesn't recognize. Truly
free-form keys (e.g. ID3v2 `TXXX` frames, arbitrary Vorbis comments) would
require dropping to format-specific tag types and handling each format
separately.

## Decision

Implement the additional-tags editor on top of the generic `Tag`:

- **Read** (`read_all_tags`): iterate `tag.items()` and expose each item by its
  **format-native key string** via `ItemKey::map_key(tag_type)` (e.g. `TITLE`
  for Vorbis, `TIT2` for ID3v2). Binary items (cover art) are skipped.
- **Write** (`save_all_tags`): rebuild the tag, preserving pictures and binary
  items, then re-insert the supplied text items. Each key is resolved with
  `ItemKey::from_key(tag_type, key)`. Keys the format doesn't recognize are
  **skipped and reported** to the UI rather than written.

## Consequences

- Works uniformly across every supported format with no per-format code.
- Exposes the full set of standard tags lofty understands — far beyond the
  panel's curated fields.
- Adding a key the file's format genuinely can't represent isn't silently lost:
  the UI lists skipped keys after saving.
- Limitation: format-specific free-form keys (ID3v2 `TXXX`, unknown Vorbis
  comments) are not yet writable. Revisit by working with format-specific tag
  types behind the same command surface if there's demand.
