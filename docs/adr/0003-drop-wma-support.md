# 3. Do not support WMA/ASF

Date: 2026-05-28

## Status

Accepted

## Context

The goal was "support every common audio format." However, `lofty` (ADR 0002)
does not support WMA (the ASF container). Adding it would require a separate
crate or a custom ASF tag parser/writer.

## Decision

**Do not support WMA.** WMA is legacy and effectively Windows-only, and modern
consumer libraries rarely contain it. The cost of a bespoke ASF implementation
is not justified for v0 (or likely ever).

## Consequences

- WMA files are simply ignored during folder scans.
- If real demand emerges, this can be revisited by integrating a dedicated ASF
  library behind the existing `Track` model.
