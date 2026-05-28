# 2. Use lofty for tag reading and writing

Date: 2026-05-28

## Status

Accepted

## Context

We need to read and write metadata across many audio formats from the Rust
backend, with a single consistent API.

## Decision

Use the **[`lofty`](https://github.com/Serial-ATA/lofty-rs)** crate (v0.24).

- One library covers MP3 (ID3v1/v2), FLAC, M4A/MP4, AAC, OGG Vorbis, Opus,
  WAV, AIFF, APE, WavPack, MPC, and Speex.
- It exposes a format-agnostic `Tag` + `ItemKey` model, so the app can treat
  all formats uniformly.

We map our editable fields to `ItemKey` variants and read/write everything as
strings, keeping the frontend model simple.

## Consequences

- **WMA/ASF is not supported by lofty** — see ADR 0003.
- Year is stored/read via `ItemKey::RecordingDate` (we take the leading 4
  digits) rather than a dedicated year accessor.
- Saving clones the existing primary tag (preserving fields we don't edit, such
  as cover art) and writes it back with `WriteOptions::default()`.
