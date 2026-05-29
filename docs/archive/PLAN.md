# AudioTag Deep Optimization Plan

> Status: planning document. **No code changes are authorized by this file.** It
> exists so a coding agent can execute the work PR-by-PR, in order, each PR
> gated on measurement. Every recommendation carries a suspected bottleneck, a
> measurement strategy, expected user impact, an implementation approach, risks,
> a rollback plan, and acceptance criteria. Optimizations that cannot clear that
> bar are listed in §19 "Do Not Do Yet".

This plan was written after reading the full source: `src-tauri/src/tags.rs`
(597 lines), `src/App.tsx` (781 lines), `src/components/FileGrid.tsx` (671
lines), `TagEditor.tsx`, `api.ts`, `types.ts`, `fields.ts`, `session.rs`,
`lib.rs`, `Cargo.toml`, `package.json`, `.github/workflows/ci.yml`, and the
ADRs. File:line references throughout point at the real code as it stands.

---

## 0. Key facts established by code inspection

These ground the rest of the plan; they are not hypotheses.

| Fact | Evidence | Consequence |
|---|---|---|
| Scan returns one blocking `Vec<Track>` | [`scan_paths`](src-tauri/src/tags.rs:274) collects then returns | No first-row paint until the *entire* scan finishes; no progress; no cancel. |
| Scan is single-threaded | `files.iter().map(read_track).collect()` [tags.rs:294](src-tauri/src/tags.rs:294) | Wall-clock scales linearly with file count × per-file parse cost. |
| Audio properties are parsed but never shown | `lofty::read_from_path` [tags.rs:158](src-tauri/src/tags.rs:158); UI shows no duration/bitrate (see [`Track`](src/types.ts:2), [`GRID_COLUMNS`](src/fields.ts:42)) | Wasted parse work per file. |
| `has_art` materializes picture bytes | `!tag.pictures().is_empty()` [tags.rs:202](src-tauri/src/tags.rs:202) | Embedded art (2–8 MB each) is decoded into RAM during scan just to set a boolean. |
| Save re-reads every file from disk | `lofty::read_from_path(path)` in [`write_track`](src-tauri/src/tags.rs:221) | Extra read IO per dirty file; needed for tag preservation but worth confirming. |
| Save sends the **whole** `Track` for every dirty row | [`saveTracks(dirty.map(...))`](src/App.tsx:496) → [`save_tracks`](src-tauri/src/tags.rs:299) | IPC payload carries unchanged fields; save is sequential, no progress, no cancel. |
| Front-end edits are O(total rows) | `setRows(prev => prev.map(...))` in [`updateField`](src/App.tsx:243), [`editCell`](src/App.tsx:257), [`pasteTags`](src/App.tsx:391), [`clearTags`](src/App.tsx:412), [`findReplace`](src/App.tsx:454) | Every keystroke rebuilds the entire rows array. |
| Derived state is O(total rows) | [`selectedRows`](src/App.tsx:149), [`modifiedCount`](src/App.tsx:150), dirty filter in [`save`](src/App.tsx:491) | Recomputed on every rows/selection change. |
| `originals` duplicates every row | `useRef<Map<string, Track>>` [App.tsx:81](src/App.tsx:81), filled with `{ ...a }` [App.tsx:163](src/App.tsx:163) | ~2× row memory. |
| `commonValue` scans the whole selection per field | [TagEditor.tsx:22](src/components/TagEditor.tsx:22), called 12× per render [TagEditor.tsx:87](src/components/TagEditor.tsx:87) | Typing with a large multi-select is O(selection × fields) per keystroke. |
| Find/replace recompiles the regex per row×field | `new RegExp(...)` inside [`replaceAllCount`](src/App.tsx:48), called in the row loop [App.tsx:462](src/App.tsx:462) | Redundant compile cost; whole op is synchronous. |
| Cover art crosses IPC as base64 | [`CoverArt`](src-tauri/src/tags.rs:93), [`get_cover_art`](src-tauri/src/tags.rs:319), rendered as a `data:` URL [TagEditor.tsx:59](src/components/TagEditor.tsx:59) | 33% size inflation + large JS strings; acceptable for one image at a time. |
| The grid has no memoized row/cell component | rows mapped inline in [`FileGrid`](src/components/FileGrid.tsx:546) | Every visible row+cell re-renders on any `rows`/`selected`/`focusIndex` change. |
| **Existing bench corpus is 100% `.wav`** | `bench-data/{tiny=100, small=1000, large=20000}` all `track_*.wav` | WAV under-represents real cost (trivial tags, no art); benchmarking only on it would hide the biggest wins. **Must fix in Phase 0.** |
| No Rust tests for scan ordering/concurrency/cancel; no criterion benches | [tags.rs tests](src-tauri/src/tags.rs:425) cover roundtrip/skip/filter only | Need parity + ordering + cancellation tests before changing scan/save. |
| No frontend test infra | `package.json` has no test runner | Frontend logic (dirty set, mixed values, FR count) is untested. |
| CI does not run `cargo test` | [ci.yml](.github/workflows/ci.yml) runs fmt/clippy/build only | Correctness regressions in Rust would not be caught. |

---

## 1. Optimization Goals

### User-facing goals
- **Faster time to first visible row** when scanning a folder (today: ∞ until the whole scan completes).
- **Lower total scan time** for 1k/10k/20k libraries.
- **Less UI freezing** during scan, save, and find/replace.
- **Less typing lag** in the tag editor, especially with a large multi-selection.
- **Smoother keyboard navigation** in the grid (arrow-key hold).
- **Faster bulk edits / paste / clear** across many selected rows.
- **Faster find/replace** across many fields/files.
- **Faster, cancellable, progress-reporting save** for hundreds/thousands of dirty files.
- **Lower memory** with huge libraries and with embedded cover art.
- **Reliable progress + cancel** feedback for long scans and saves.
- **Zero tag corruption** and **zero accessibility regression** — non-negotiable.

### Target metrics
These are *targets to validate against the baseline*, not guarantees. Numbers in
parentheses are provisional goals to confirm/adjust after Phase 0 measures the
real baseline on the mixed-format and art-heavy corpora.

| Metric | How measured | Target |
|---|---|---|
| Time to first visible row (10k mixed) | `performance.now()` from invoke→first row painted | < 300 ms (today ≈ full scan time) |
| Total scan time (10k mixed) | Rust `Instant` around walk+read | ≥ 2× faster after concurrency (vs sequential baseline) |
| Total scan time (10k, properties off) | Rust `Instant` | measurably lower than properties-on, else don't land |
| p95 keypress latency in tag editor (20k loaded, 1 selected) | `PerformanceObserver` `event` timing | < 16 ms |
| p95 keypress latency (20k loaded, 20k selected) | same | < 50 ms |
| React commits per arrow-key move | React DevTools Profiler | ≤ 2 (old focused row + new focused row), independent of total rows |
| Memory after loading 20k (no art) | OS RSS of webview + backend | track baseline; target ≤ baseline (no regression) and ideally lower via lighter `originals` |
| Peak backend RSS during art-heavy scan (1k × 2–8 MB) | `/usr/bin/time -l` on macOS | bounded (does not scale with Σ art bytes) once `has_art` stops materializing pictures |
| Save time (1,000 dirty) | Rust `Instant` + wall clock | improved or equal with progress + cancel; never slower than baseline |
| Long tasks > 50 ms during scan/edit/save | `PerformanceObserver({type:'longtask'})` | none > 50 ms on the main thread during streamed scan |
| Find/replace duration (all fields, 20k) | `performance.now()` around `findReplace` | no single main-thread block > 50 ms (chunked if needed) |
| Cancellation latency (scan/save) | time from cancel click → "Cancelled" message | < 200 ms |

---

## 2. Current Architecture Summary

Data flow, with the cost at each step:

1. **User chooses files/folders** — `pickFolder`/`pickFiles` ([api.ts:6](src/api.ts:6)) or drag-drop / session restore ([App.tsx:211](src/App.tsx:211), [App.tsx:198](src/App.tsx:198)). *Cost: negligible.*
2. **Frontend calls Tauri** — `scanPaths(paths)` → `invoke("scan_paths")` ([api.ts:33](src/api.ts:33)). *Cost: one round-trip; result awaited whole.*
3. **Rust walks folders, filters audio** — `WalkDir` + `is_audio` ([tags.rs:281](src-tauri/src/tags.rs:281)). *Cost: disk IO (directory entries), extension checks per entry.*
4. **Rust reads tags via lofty** — `read_track` → `read_from_path` ([tags.rs:157](src-tauri/src/tags.rs:157)). *Cost: tag parsing **+ audio-property parsing (unused) + picture materialization (for `has_art`)**, sequential.*
5. **Rust serializes `Vec<Track>`** — serde_json over the whole vector. *Cost: serialization CPU + one big payload; first byte not sent until last track read.*
6. **React stores rows + originals + staged state** — `rows`, `originals` map, `selected`, undo/redo stacks ([App.tsx:64](src/App.tsx:64)–[App.tsx:107](src/App.tsx:107)). *Cost: full-array build; originals duplicate; up to 200 array snapshots.*
7. **Grid renders virtualized rows** — TanStack Virtual, overscan 12 ([FileGrid.tsx:295](src/components/FileGrid.tsx:295)). *Cost: DOM limited to visible rows; but **all visible rows re-render** on state change (no memo).*
8. **Tag editor shows selected/mixed values** — `commonValue` per field over `selectedRows` ([TagEditor.tsx:22](src/components/TagEditor.tsx:22)). *Cost: O(selection × 12) per render; cover art fetched lazily for the single selection.*
9. **Save sends dirty tracks** — `dirty.map(r => ({...r}))` whole tracks ([App.tsx:496](src/App.tsx:496)). *Cost: O(total) dirty scan + whole-track IPC payload.*
10. **Rust re-reads + writes tags** — `write_track` re-reads, clones primary tag, applies fields, writes ([tags.rs:219](src-tauri/src/tags.rs:219)), sequential. *Cost: read IO + write IO per file; clone of tag; no progress/cancel.*
11. **Cover art loads lazily for the selected file** — `get_cover_art` base64 → data URL ([TagEditor.tsx:50](src/components/TagEditor.tsx:50)). *Cost: one read + base64 per selection change; correctly cancelled via the effect's `cancelled` flag.*

---

## 3. Performance Hypotheses (prioritized)

Each: why it might be slow · where · how to measure · "good enough" · who it affects.

### H1 — Scan returns one giant blocking payload (no streaming) — **HIGH**
- **Why**: `scan_paths` reads every file before returning ([tags.rs:294](src-tauri/src/tags.rs:294)); the UI shows nothing until then.
- **Where**: [tags.rs:274](src-tauri/src/tags.rs:274), [App.tsx:160](src/App.tsx:160).
- **Measure**: time from `invoke` to first painted row vs to full completion (`performance.now()`), on 10k mixed.
- **Good enough**: first rows visible < 300 ms regardless of library size.
- **Affects**: large libraries most; medium noticeably.

### H2 — Audio properties parsed but never used — **HIGH (verify API)**
- **Why**: `read_from_path` parses stream properties (duration/bitrate/sample rate) the UI never displays.
- **Where**: [tags.rs:158](src-tauri/src/tags.rs:158).
- **Measure**: criterion bench `read_track` vs a `read_properties(false)` variant on mixed/large/medium files.
- **Good enough**: measurable per-file reduction with byte-identical `Track` output; else don't land.
- **Affects**: large files (FLAC/long MP3) most; both small & large libraries.

### H3 — `has_art` materializes embedded picture bytes — **HIGH (memory)**
- **Why**: `tag.pictures()` returns already-parsed pictures; lofty decodes embedded art into memory during read. Setting a boolean shouldn't require holding MBs.
- **Where**: [tags.rs:202](src-tauri/src/tags.rs:202).
- **Measure**: peak backend RSS (`/usr/bin/time -l`) scanning the `art-heavy` corpus; compare to a variant that detects art presence without retaining bytes.
- **Good enough**: peak RSS during scan does **not** scale with Σ embedded-art bytes.
- **Affects**: art-heavy libraries; large libraries with art.

### H4 — Front-end mutations are O(total rows) — **HIGH**
- **Why**: every edit rebuilds the entire `rows` array; derived `selectedRows`/`modifiedCount` re-scan all rows.
- **Where**: [App.tsx:243](src/App.tsx:243), [App.tsx:149](src/App.tsx:149)–[App.tsx:150](src/App.tsx:150), [App.tsx:491](src/App.tsx:491).
- **Measure**: React Profiler commit time per keystroke at 1k/10k/20k loaded; `PerformanceObserver` event latency.
- **Good enough**: keypress p95 < 16 ms (single selection) / < 50 ms (full selection).
- **Affects**: large libraries; both editing and selection.

### H5 — `commonValue` scans the whole selection per field — **HIGH for multi-select**
- **Why**: 12 fields × O(selection) per render; with select-all + typing, each keystroke is O(selection × 12) twice (App map + editor recompute).
- **Where**: [TagEditor.tsx:22](src/components/TagEditor.tsx:22).
- **Measure**: Profiler commit time while typing with 20k selected.
- **Good enough**: keypress p95 < 50 ms at 20k selected.
- **Affects**: bulk editing.

### H6 — All visible grid rows/cells re-render on any state change — **MEDIUM**
- **Why**: no memoized `GridRow`/`GridCell`; rows mapped inline.
- **Where**: [FileGrid.tsx:546](src/components/FileGrid.tsx:546).
- **Measure**: Profiler "why did this render" + commit count on arrow-key move.
- **Good enough**: arrow move re-renders ≤ 2 rows (old/new), not all ~30 visible.
- **Affects**: keyboard nav smoothness; typing (App state churn re-renders grid).

### H7 — Save is sequential, whole-track, no progress/cancel — **MEDIUM/HIGH**
- **Why**: `save_tracks` writes one file at a time; payload carries unchanged fields; UI is fully blocked (`busy`).
- **Where**: [tags.rs:299](src-tauri/src/tags.rs:299), [App.tsx:490](src/App.tsx:490).
- **Measure**: Rust `Instant` per file + total; wall clock for 100/1,000/2,000 dirty.
- **Good enough**: progress visible; cancel < 200 ms; never slower than baseline.
- **Affects**: large dirty saves.

### H8 — Find/replace recompiles regex per row×field and blocks — **MEDIUM**
- **Why**: `new RegExp` inside the per-row loop ([App.tsx:54](src/App.tsx:54) called from [App.tsx:462](src/App.tsx:462)); whole pass synchronous.
- **Measure**: `performance.now()` around `findReplace` on 20k all-fields; longtask observer.
- **Good enough**: no main-thread block > 50 ms; identical replacement results.
- **Affects**: large find/replace.

### H9 — `originals` map doubles row memory; undo holds 200 array snapshots — **MEDIUM (memory)**
- **Why**: full `Track` clone per row ([App.tsx:163](src/App.tsx:163)); undo stack up to 200 × N-element arrays ([App.tsx:121](src/App.tsx:121)).
- **Measure**: heap snapshot after loading 20k and after 200 edits.
- **Good enough**: memory tracked; no unbounded growth; consider lighter diff model only if measured pain.
- **Affects**: huge libraries.

### H10 — Path sort/dedup at 10k+ — **LOW**
- **Why**: `files.sort(); files.dedup()` ([tags.rs:292](src-tauri/src/tags.rs:292)) sorts PathBufs (string compares).
- **Measure**: Rust `Instant` around sort/dedup at 20k.
- **Good enough**: < a few ms; almost certainly already fine — verify, don't pre-optimize.
- **Affects**: large libraries (likely negligible).

### H11 — Corrupt/unreadable files must not block or crash the scan — **CORRECTNESS**
- **Why**: `read_track` already returns `Track::errored` ([tags.rs:160](src-tauri/src/tags.rs:160)); confirm this survives streaming + concurrency.
- **Measure**: scan the `corrupt` corpus; assert no panic, errored rows present.
- **Affects**: mixed real-world folders.

---

## 4. Baseline Measurement Plan (Phase 0 — do this first)

**No behavior changes.** Build the harness, capture the baseline, commit the
numbers. Everything after Phase 0 is measured against this.

### 4.1 Artifacts to create
- `bench/BASELINE.md` — the captured baseline table (filled in by running the harness). Template in §4.5.
- `bench/README.md` — how to run everything below.
- `scripts/gen-corpus.sh` — generates corpora into `bench-data/` (git-ignored).
- `src-tauri/benches/scan.rs` — criterion benches (added behind a `[[bench]]` in `Cargo.toml` + `criterion` dev-dependency).
- `bench/profiling.md` — manual frontend profiling procedure (DevTools/Profiler/PerformanceObserver snippets).
- `.gitignore`: add `bench-data/` (currently **not** ignored — it's an untracked dir; add the rule so generated corpora never get committed).

### 4.2 Corpus generator (`scripts/gen-corpus.sh`)
The existing `bench-data/` is **WAV-only**, which hides the real costs (WAV tag
parsing is trivial and these files carry no art). The generator must produce
**format-diverse and art-bearing** corpora. Approach:

- Require `ffmpeg` (document it); generate short (1–2 s) silent audio in each
  real format from a single source, then write tags with a tiny Rust helper
  (an `xtask`) or `ffmpeg -metadata`. Prefer a Rust `xtask` using the project's
  own `lofty` so fixtures match what the app parses.
- Corpora (each a top-level dir under `bench-data/`):
  - `tiny` — 100 files (keep existing, but **regenerate mixed-format**).
  - `small` — 1,000 files, mixed format.
  - `medium` — 5,000 files, mixed format.
  - `large` — 20,000 files, mixed format (replace the WAV-only set).
  - `deep` — 5,000 files spread over a deep nested tree (e.g. 4 levels, ~20 dirs/level).
  - `mixed-format` — even split mp3/flac/m4a/ogg/opus/wav/aiff/ape/wv (every `AUDIO_EXTS` entry, [tags.rs:17](src-tauri/src/tags.rs:17)).
  - `art-heavy` — 1,000 files each with a 2–8 MB embedded cover (JPEG of random noise to defeat compression).
  - `corrupt` — ~200 files: truncated audio, zero-byte files, `.mp3` containing text, an unsupported `.wma`, a read-only file, a Unicode-named file, a very long filename.
  - `dirty-save` — `dirty-500` and `dirty-2000`: valid files used by the save benchmark (the harness mutates tags then times the save).
- The script must be **idempotent** and print total size; warn before generating `large`/`art-heavy` (multi-GB).

### 4.3 Backend instrumentation
- Add `Instant` spans (behind a `cfg!(debug_assertions)` or an env flag `AUDIOTAG_TIMING=1`) around: walk, per-file read, sort/dedup, serialize (measure payload bytes via the serialized length), and per-file/total write. Emit via `eprintln!` or `tracing` so they appear in `pnpm tauri dev` console.
- Optional: add `tracing` + `tracing-subscriber` (dev-only) for span timing. Keep it optional to avoid a release dependency.
- Criterion benches in `src-tauri/benches/scan.rs`:
  - `read_track` over each format fixture (properties on).
  - `read_track` properties-off variant (added in Phase 1) for A/B.
  - `scan_paths` over `small`/`medium` (sequential baseline).
  - `has_art` materializing vs presence-only variant (Phase 1).
  - `write_track` over `dirty-500` fixtures.
  - Run: `cargo bench --manifest-path src-tauri/Cargo.toml`.

### 4.4 Frontend instrumentation (`bench/profiling.md`)
- **Time to first row / total**: wrap `scanPaths` call site with `performance.now()`; log first-row paint via a `useEffect` that fires when `rows.length` goes 0→>0.
- **Keypress latency**: `PerformanceObserver({entryTypes:['event']})` filtering `input`/`keydown`; record p95.
- **Long tasks**: `PerformanceObserver({entryTypes:['longtask']})`; log any > 50 ms with the active interaction.
- **React commits**: React DevTools Profiler — record an arrow-key hold, a single-field edit, and a typing burst with full selection; capture commit count + duration + "why rendered".
- **IPC payload size**: log `JSON.stringify(result).length` after each `scan_paths`/`save_tracks` (dev-only) — proxy for transfer cost.
- **Memory**: macOS Activity Monitor / `/usr/bin/time -l scripts/...`; DevTools heap snapshots after load and after 100 selection changes (cover-art memory).

### 4.5 `bench/BASELINE.md` template (fill by running the harness)

```
## Baseline — <date>, <machine>, <OS>, <commit>

Corpus  | TTF row | Total scan | IPC bytes | Backend peak RSS | Notes
tiny    |         |            |           |                  |
small   |         |            |           |                  |
medium  |         |            |           |                  |
large   |         |            |           |                  |
deep    |         |            |           |                  |
mixed   |         |            |           |                  |
art     |         |            |           |                  |

Interaction (20k loaded)        | p95 keypress | commits | longtasks
arrow-key hold                  |              |         |
edit 1 field (1 selected)       |              |         |
edit 1 field (20k selected)     |              |         |
find/replace all-fields (20k)   |              |         |

Save        | files | total | per-file p95 | cancel latency
dirty-500   |       |       |              |
dirty-2000  |       |       |              |
```

### 4.6 Before/after PR template addition
Add to `.github/PULL_REQUEST_TEMPLATE.md` (create if absent) a **Performance**
section required for perf PRs: corpus used, machine, before/after numbers for the
relevant metric, and a one-line "why this is faster".

**Phase 0 acceptance**: harness runs end-to-end; `bench/BASELINE.md` populated;
`bench-data/` git-ignored; `cargo bench` runs; no app behavior changed; CI green.

---

## 5. Backend Optimization Plan (`src-tauri/src/tags.rs`)

Things to inspect (and what was found):
- Unnecessary `clone()` — `existing.clone()` of the whole tag in `write_track` ([tags.rs:226](src-tauri/src/tags.rs:226)); `to_string_lossy().into_owned()` repeated. Mostly necessary; do not micro-optimize without a measurement.
- Parsing fields never used — **audio properties** (§5.1).
- Holding cover-art bytes when only `has_art` is needed (§5.3 below; this is the H3 memory issue).
- Sequential reads (§5.2).
- Sorting once (`files.sort(); files.dedup()` already single-pass — fine).
- Repeated extension checks — `is_audio` lowercases per call ([tags.rs:138](src-tauri/src/tags.rs:138)); negligible, leave it.
- Weak error categorization — errors are stringified ([tags.rs:160](src-tauri/src/tags.rs:160)); good enough, but streaming should keep them per-file.
- Save re-reading & preserving additional tags — `write_track` clones the primary tag to preserve pictures/unknown frames ([tags.rs:225](src-tauri/src/tags.rs:225)); **this is correct and must be preserved** (data safety > speed).

### 5.1 Disable unused audio-property parsing — **Phase 1**
- **Investigate** the exact lofty 0.24 API: replace `lofty::read_from_path(path)`
  with `Probe::open(path)?.options(ParseOptions::new().read_properties(false)).read()`
  (confirm method names against the pinned `lofty 0.24.0` in `Cargo.lock`). Apply
  in **both** `read_track` ([tags.rs:158](src-tauri/src/tags.rs:158)) and any
  read where only tags are needed.
- **Do not** change `write_track`'s read (it must preserve everything) unless a
  bench proves it safe.
- **Prove parity**: a test that reads every format fixture with properties on vs
  off and asserts the resulting `Track` (all displayed fields + `has_art`) is
  byte-identical.
- **Acceptance**: identical `Track` output across all formats; measurable read
  speedup on medium/large; no format regression. Land only if the bench shows a
  real win.
- **Risks**: a format whose tag lives in a stream-properties-dependent code path
  (unlikely for tags). **Mitigation/rollback**: feature-flag via a const or keep
  the call swap behind a one-line revert; parity test guards correctness.

### 5.2 Bound scan concurrency — **Phase 6 (only if Phase 4 streaming hasn't already met targets)**
- **Rules**: never one-thread-per-file; cap workers at e.g. `min(available_parallelism, 8)`; preserve final **sorted** order (sort the path list first, read in parallel, reassemble by index); preserve per-file errors; keep memory bounded (art materialization must already be fixed per §5.3, else parallelism multiplies peak RSS).
- **Implementation**: use a bounded pool — `std::thread` + a work queue, or add `rayon` (`files.par_iter().map(read_track)` with a configured thread pool) only if a dependency is acceptable; prefer a small hand-rolled pool to avoid a new dep, decide in the PR. Reassemble results in input order so output equals the sequential scan exactly.
- **Measure**: compare sequential vs 2/4/8 workers on `medium`/`large`/`art-heavy`; record total time and peak RSS. Include a note on HDD vs SSD: on a single spinning disk, high concurrency can thrash and *hurt*; SSDs benefit. Default conservative (e.g. 4) and make the cap an internal const.
- **Acceptance**: faster on the corpus; memory bounded; output **identical** to sequential (ordering test); cancellation still works.
- **Risks**: memory explosion (mitigated by §5.3 + cap), ordering drift (mitigated by index reassembly + test), oversubscription on HDD (mitigated by conservative default). **Rollback**: set worker cap to 1 (reverts to sequential).

### 5.3 Streaming scan path — **Phase 4** (see also §6)
- **Plan**: new command `scan_paths_streamed(paths, channel, operationId)`:
  1. walk + filter + sort/dedup the path list (cheap),
  2. emit `{type:"total", count}`,
  3. read tags, emitting `{type:"batch", tracks:[...]}` every 100–500 files,
  4. emit `{type:"progress", done, total}` with batches,
  5. emit `{type:"error", path, message}` inline (or fold errored tracks into batches as today),
  6. check a cancellation flag (keyed by `operationId`) between files/batches; emit `{type:"cancelled"}` and stop,
  7. emit `{type:"done"}`.
- **Transport**: Tauri 2 **Channel** (`tauri::ipc::Channel<ScanEvent>`) passed as a command arg — preferred over global events for backpressure-free, typed, per-operation streaming.
- **Decisions**:
  - **Sort before streaming** (sort the path list up front) so batches arrive in final order; the client appends without re-sorting. Client-side re-sort only when the user changes the sort column (already handled by [`sortBy`](src/App.tsx:277)).
  - **Batch size** 100–500 (tune in the PR; start 200) to balance first-paint latency vs React update spam.
  - **Avoid React update spam**: the client reducer appends a whole batch in one `setRows`, not per-file (see §7); optionally throttle to one append per animation frame.
  - **Selection behavior**: keep the existing "select first row when the list was empty" ([App.tsx:168](src/App.tsx:168)) — fire it when the *first* batch arrives, not on every batch, so focus isn't stolen as batches stream (accessibility, §12).
  - **Duplicate paths**: dedup happens server-side (path list) **and** the client keeps its existing "already loaded" guard ([App.tsx:161](src/App.tsx:161)).
  - **Cancel**: `cancel_operation(operationId)` flips a shared `AtomicBool` in a `Mutex<HashMap<String, Arc<AtomicBool>>>` registry in app state.
- **Acceptance**: first rows appear much earlier; UI responsive (no >50 ms longtask); final result **identical** to old `scan_paths`; old command retained for rollback.
- **Risks**: streaming race conditions, focus steal, partial-list edge cases. **Mitigation**: keep `scan_paths` as the fallback; feature-flag the streamed path in the client; tests for the reducer (§14). **Rollback**: client flag flips back to `scan_paths`.

### 5.4 Save optimization — **Phase 7** (see also §6)
- **Findings**: frontend sends whole tracks ([App.tsx:496](src/App.tsx:496)); backend re-reads (necessary for preservation) and writes the full set of edited fields via `apply_item`; lofty write preserves pictures/unknown frames because `write_track` starts from the cloned existing tag — **this is the safety property to keep**.
- **Plan** (incremental, safety-first):
  - **Save progress + cancel**: `save_changes(tracks, channel, operationId)` emitting `{type:"saved", path, ok, error}` per file and `{type:"progress"}`; check the cancel flag between files. Keep `save_tracks` for rollback.
  - **Changeset payload (optional, only if IPC bytes prove costly)**: send only changed fields per dirty row instead of the whole `Track`. **Risk**: easy to get wrong (which fields, art semantics). Only do this if Phase 0 shows the save payload is a real bottleneck; otherwise keep whole-track (it's simpler and already correct).
  - **Bounded parallel writes**: **do not** parallelize writes by default — concurrent writes to the same directory/file system raise lock and correctness risk. Only consider after measuring, with a small cap, and never two writers on one path. Default sequential.
- **Acceptance**: identical saved metadata (roundtrip tests per format); per-file errors preserved; **cancelled save leaves already-saved rows clean and unsaved rows dirty** (the client clears `modified` only for paths the backend reported `ok`, exactly as [App.tsx:500](src/App.tsx:500) already does per-result — this must hold under streaming/cancel).
- **Risks**: partial-save inconsistency, art double-write. **Mitigation**: per-file result drives dirty clearing; tests for cancel-midway. **Rollback**: revert to `save_tracks`.

---

## 6. IPC / Data Transfer Optimization Plan (`src/api.ts` + commands)

Findings: large `scan_paths` return; whole-track save payload; base64 cover art;
no events/progress/cancel.

**Target API model (introduced incrementally, old commands kept until proven):**

| Command / event | Request | Response / event | When called | Cancellation | Errors | Rollback |
|---|---|---|---|---|---|---|
| `scan_paths` (keep) | `paths: string[]` | `Track[]` | fallback / small folders | n/a | errored `Track` rows | — |
| `scan_paths_streamed` (Phase 4) | `paths, channel, operationId` | `ScanEvent` stream (`total`/`batch`/`progress`/`error`/`cancelled`/`done`) | default scan | `cancel_operation(id)` | `error` events + errored rows | client flag → `scan_paths` |
| `cancel_operation` (Phase 5) | `operationId` | `()` | cancel button | — | non-fatal | no-op if id gone |
| `save_tracks` (keep) | `tracks: Track[]` | `SaveResult[]` | fallback | n/a | per-file `ok/error` | — |
| `save_changes` (Phase 7) | `tracks, channel, operationId` | `{saved}`/`{progress}`/`{cancelled}`/`{done}` | default save | `cancel_operation(id)` | per-file events | client flag → `save_tracks` |
| `get_cover_art` (keep) | `path` | `CoverArt` (base64) | single selection | effect `cancelled` flag | null | — |
| `cover://<path>` protocol (Phase 8, **only if measured**) | URL | raw bytes + mime | `<img src>` | browser-native | 404 | revert to base64 |

**Decisions:**
- **Keep JSON batches** for scan results (no binary protocol — see §19). Batching alone solves first-paint.
- **Use Tauri Channels** for streaming (typed, per-operation) rather than global `emit`/`listen` (which would need manual operation routing).
- **Cover art**: keep base64 for now (one image at a time; correctly cancelled). Move to a custom `cover://` protocol **only** if Phase 0/8 shows base64 latency/memory is a real problem.
- **No binary IPC** until measured.

---

## 7. Frontend State Optimization Plan (`src/App.tsx`)

Findings (all O(total rows)): per-edit `rows.map` ([App.tsx:243](src/App.tsx:243)); `selectedRows` filter ([App.tsx:149](src/App.tsx:149)); `modifiedCount` scan ([App.tsx:150](src/App.tsx:150)); save dirty filter ([App.tsx:491](src/App.tsx:491)); `originals` full duplicate ([App.tsx:163](src/App.tsx:163)); `menuItems` useMemo depends on `rows` ([App.tsx:662](src/App.tsx:662)) so it recomputes on every edit.

### Scalable state model (introduce incrementally — **Phase 3**, no library)
Keep React `useState`/`useRef` (no Redux/Zustand — see §19). Target shape:

- `trackIds: string[]` — order for the grid/virtualizer.
- `tracksById: Map<string, Row>` — the data.
- `selectedIds: Set<string>` — already a Set; keep.
- `dirtyIds: Set<string>` — **new**: maintained incrementally so `modifiedCount = dirtyIds.size` is O(1) and save iterates only dirty.
- `originalsById: Map<string, Track>` — keep, but consider a lighter diff model later (§9 / Phase 9).
- `errorsById` — derivable from rows; optional.
- `coverArtCache` — only if §11 measures repeated-selection cost.
- `operationState` — scan/save progress + cancel id (Phase 5).
- `sort` / `colOrder` / `colWidths` — already local to FileGrid (fine).

> **Pragmatic note**: a full normalized rewrite is large and risky. The cheapest
> high-value win is to **maintain `dirtyIds` incrementally** and **derive
> `selectedRows`/`modifiedCount` from sets**, *without* necessarily replacing the
> `rows: Row[]` array (the virtualizer wants an ordered array anyway). Do the
> minimum that makes the complexity targets below hold. Only go fully normalized
> (Map + id list) if Profiler still shows the array `map` dominating after
> memoizing rows (§8) and after these set-based derivations.

### Required complexity per state-change path
| Action | Today | Target |
|---|---|---|
| Select one row | O(1) (Set) ✓ | O(1) keep |
| `selectedRows` derivation | O(total) | O(selection) |
| `modifiedCount` | O(total) | O(1) via `dirtyIds.size` |
| Edit one field (1 row inline) | O(total) `map` | O(1)–O(visible) update; only that row + editor re-render |
| Edit one field (N selected) | O(total) `map` | O(selected) |
| Save dirty | O(total) filter | O(dirty) via `dirtyIds` |
| Revert | O(total) `map` | O(dirty or selection) |
| Find/replace | O(total × fields) | may stay O(targets × fields) but chunked if it blocks (§10) |

- **Unstable callbacks/props**: most handlers already use `useCallback`. `menuItems` should depend on the targeted row only (look it up via `tracksById`/find by id) rather than the whole `rows` array, so it doesn't recompute on every edit. Audit all props passed to `FileGrid`/`TagEditor` for stability when memoizing (§8).
- **Acceptance**: Profiler shows edit/selection commit time flat as library grows from 1k→20k; `modifiedCount` O(1); save touches only dirty.
- **Risks**: dirty-set drift (a path edited then reverted must leave `dirtyIds`). **Mitigation**: a single `recomputeDirty(id)` helper called from every mutation, asserted by frontend unit tests (§14). **Rollback**: revert to array scans (they're correct, just slow).

---

## 8. React Rendering / Grid Optimization Plan (`FileGrid.tsx`) — **Phase 2**

Virtualization limits DOM nodes but **not** re-renders. Today every visible row
and cell re-renders on any `rows`/`selected`/`focusIndex` change because rows are
mapped inline ([FileGrid.tsx:546](src/components/FileGrid.tsx:546)).

Inspect / fix:
- **Extract a memoized `GridRow`** (`React.memo`) taking: `row`, `isSelected`, `isFocused`, `colOrder`/`renderCols`, `colWidths`, `editingKey|null`, `draft` (only when editing this row), and stable callbacks. Custom comparator keyed on `row` identity + `isSelected` + `isFocused` + whether this row is the one being edited.
- **Consider a memoized `GridCell`** only if the Profiler shows cell churn dominates within a row; a memoized row may suffice.
- **Stabilize callbacks**: `handleRowClick`, `handleCellMouseDown`, `beginEdit`, context-menu handler — wrap so identity is stable across renders (today they're recreated each render but that's only cheap because rows aren't memoized; once memoized, stable identity is required or memo breaks). Pass row **index**/**id** via data attributes or `useCallback` factories keyed by id.
- **Avoid new objects in hot rows**: the inline `style={{...transform...}}` object ([FileGrid.tsx:568](src/components/FileGrid.tsx:568)) is recreated per render — fine for unmemoized, but when memoizing, ensure the comparator ignores it or compute it from primitives the comparator already checks (`vi.start`).
- **Stable column metadata**: `GRID_COLUMNS`/`renderCols`/`colWidths` are derived in the parent; pass them through and include in the comparator (they change rarely — resize/reorder).
- **Stable row keys**: already `row.id` (path) ✓.
- **Focus stability during streaming**: when batches append (§5.3), `aria-activedescendant` ([FileGrid.tsx:538](src/components/FileGrid.tsx:538)) and `focusIndex` must not jump; only set initial selection on the first batch.

**Acceptance**:
- Arrow-key move re-renders only the previously- and newly-focused/selected rows (verify in Profiler), independent of total rows.
- Editing one cell re-renders only that row (and the TagEditor area).
- No focus or screen-reader regression; virtualized grid stays accessible.

**Risks**: a broken comparator drops a needed re-render (stale selection highlight). **Mitigation**: comparator unit-reasoned + visual check + a11y pass. **Rollback**: remove `React.memo` (returns to current behavior).

---

## 9. TagEditor Optimization Plan (`TagEditor.tsx`) — **Phase 3**

Findings: `commonValue` runs per field over the whole selection ([TagEditor.tsx:22](src/components/TagEditor.tsx:22), 12 calls per render at [TagEditor.tsx:87](src/components/TagEditor.tsx:87)); cover-art effect is already correctly guarded against stale responses via primitives + `cancelled` ([TagEditor.tsx:50](src/components/TagEditor.tsx:50)–[TagEditor.tsx:83](src/components/TagEditor.tsx:83)) — **preserve this**.

Plan:
- **Compute mixed values once per render** in a single pass: one `useMemo` over `selectedRows` that returns `Record<field, string | MIXED>` (one O(selection × fields) pass instead of 12 separate passes that each early-exit). Memo keyed on a cheap signature (e.g. `selectedRows.length` + a hash, or the `selectedIds` set + a dirty counter) — but beware: if `selectedRows` identity churns on every edit (it does today, [App.tsx:149](src/App.tsx:149)), the memo never hits. Fixing §7's derivation (stable `selectedRows` when selection unchanged) is a prerequisite.
- **Avoid recomputing across all tracks**: `commonValue` already only scans the selection (not all rows) — good. The cost is the multi-select case; the single-pass memo + §7 stabilization addresses it.
- **Huge multi-select typing**: if Profiler still shows stalls when typing with 20k selected, wrap the `onFieldChange` state update in `useTransition` (React 19 is available, [package.json](package.json)) or chunk the update — but only if measured. Keep the field-type contract (strings) unchanged.
- **Preserve lazy art loading** and the stale-response guard exactly.

**Acceptance**: typing smooth with 20k loaded (single selection p95 < 16 ms; full selection < 50 ms); mixed-value display correct; cover art updates only for the current single selection; no stale image flashes.
**Risks**: memo invalidation bugs showing stale field values. **Mitigation**: frontend unit tests for the mixed-value pass (§14). **Rollback**: revert to per-field `commonValue`.

---

## 10. Bulk Edit / Find-Replace Optimization Plan — **Phase 3/9**

Findings: regex recompiled per row×field ([App.tsx:54](src/App.tsx:54) inside the loop at [App.tsx:462](src/App.tsx:462)); whole pass synchronous; paste/clear also O(total) maps.

Plan:
- **Precompile the regex once** before the loop (compile `new RegExp(escapeRegExp(find), flags)` in `findReplace` and pass it in, or hoist `replaceAllCount` to accept a compiled `RegExp`).
- **Only touch rows/fields that actually change** — the code already skips untouched rows (`touched` flag) but still allocates the regex per field; precompiling fixes the main waste. Only `setRows` rebuilds the array (unavoidable with the array model; cheaper once §7 lands).
- **Update `dirtyIds` incrementally** as part of §7 instead of relying on `modified` flags scanned later.
- **Count replacements without extra passes** — already counted inline ✓.
- **Chunk only if measured**: if Phase 0 shows find/replace on 20k all-fields blocks > 50 ms, chunk with `setTimeout`/`requestIdleCallback` batches (process N rows per tick, show progress) or move the pure string work to a Web Worker (Phase 9). Do **not** add a worker speculatively.
- **Preserve exact semantics**: same replacement results, same numeric-field exclusion ([App.tsx:447](src/App.tsx:447)), undo still records one step ([App.tsx:451](src/App.tsx:451)).

**Acceptance**: identical results; no UI freeze > 50 ms on the large corpus; dirty tracking correct; undo/revert intact.
**Risks**: chunking changes undo granularity or interleaves with edits. **Mitigation**: snapshot rows before chunked run; disable editing during the run; tests on FR count. **Rollback**: revert to synchronous single pass.

---

## 11. Cover Art Optimization Plan — **Phase 8 (only if measured)**

**Preserve the existing rule: never load all cover art during scan.** (Today scan
sets only `has_art`; art is fetched lazily for the single selection — keep this.)

Findings: base64 over IPC ([get_cover_art](src-tauri/src/tags.rs:319)); rendered as `data:` URL ([TagEditor.tsx:59](src/components/TagEditor.tsx:59)); the effect cancels stale fetches ([TagEditor.tsx:68](src/components/TagEditor.tsx:68)); **`has_art` currently materializes picture bytes during scan** (H3 — fix in Phase 1 alongside §5.3 backend).

Possible improvements (each gated on measurement):
- **Fix `has_art` materialization (Phase 1, high value)**: detect art presence without retaining the decoded bytes. Investigate whether lofty exposes a cheaper presence check; if not, the win comes from concurrency/streaming bounding peak RSS, and from not cloning picture data into the `Track` (we never do — `Track` has no art bytes, good). The real cost is lofty decoding pictures during `read`. Document the finding in an ADR if a parse-option exists.
- **Keep one-image-at-a-time** behavior.
- **Custom `cover://` protocol or raw-bytes IPC** to avoid base64's 33% inflation — only if heap snapshots show base64 strings are a memory/latency problem.
- **Blob URL with explicit `URL.revokeObjectURL`** if switching off data URLs — must revoke on selection change/unmount to avoid leaks.
- **Small LRU cache** (e.g. last 8 covers) only if Phase 0 shows repeated-selection fetch latency hurts — and only with bounded total bytes + eviction, else it reintroduces the memory problem.

**Acceptance**: scan loads no art bytes into the `Track` model (already true); selecting a track shows its art; memory does **not** climb after 100 selection changes (heap snapshot); no jank from huge covers.
**Risks**: blob-URL leaks, stale image flash. **Mitigation**: revoke on cleanup; keep the existing `cancelled` guard; cap any cache. **Rollback**: revert to base64 data URL.

---

## 12. Accessibility Requirements (definition of done for every UI PR)

The grid uses the `aria-activedescendant` single-tab-stop pattern ([FileGrid.tsx:538](src/components/FileGrid.tsx:538)) with `role="grid"`, `aria-multiselectable`, `aria-rowcount`, per-row `aria-selected`/`aria-rowindex`. The status bar has a `role="status" aria-live="polite"` region ([StatusBar.tsx](src/components/StatusBar.tsx)). Modals (`AdditionalTags`) use `role="dialog" aria-modal`. **None of this may regress.**

Audit every optimization against:
- Keyboard navigation (arrow/Page/Home/End/Space/Enter, [FileGrid.tsx:309](src/components/FileGrid.tsx:309)).
- Focus retention — esp. **no focus steal when streamed batches arrive** (§5.3): set initial selection only on the first batch; never reset `focusIndex` on append.
- `aria-activedescendant` / `aria-selected` / row & column roles stay correct after memoization (§8).
- Inline edit Enter/Escape ([FileGrid.tsx:639](src/components/FileGrid.tsx:639)).
- Screen-reader behavior with virtualized rows (only visible rows in DOM — verify activedescendant target exists when focused).
- **Live region for scan/save progress + cancel** (Phase 5): announce "Scanning… N of M", "Saved N of M", "Cancelled" via the existing `aria-live` region; provide a **Cancel** button with a clear label, keyboard-reachable, not focus-trapping.
- Reduced motion (respected per README) and high contrast — don't add motion in progress UI without `prefers-reduced-motion`.
- No focus trap in editors/dialogs.

**Per-UI-PR manual a11y script** (run before merge):
1. Keyboard-only: open folder → arrow through grid → Space multi-select → Enter into editor → edit → Escape.
2. Cmd/Ctrl+A select-all → edit a field → verify "Multiple values" semantics announced.
3. Edit a cell inline → Enter commits → Escape cancels.
4. Trigger a scan → confirm progress announced and Cancel reachable by keyboard.
5. Trigger a save of many files → confirm progress announced; Cancel reachable.
6. **VoiceOver (macOS)** smoke: grid rows announce index/selected; editor fields announce labels.
7. **Narrator/NVDA (Windows)** smoke if available.

---

## 13. Reliability / Data Safety Requirements

Performance never precedes data safety. The write path clones the existing tag to
preserve pictures and unknown frames ([tags.rs:225](src-tauri/src/tags.rs:225)) and
`save_all_tags` explicitly re-pushes pictures + binary items ([tags.rs:392](src-tauri/src/tags.rs:392)) — **preserve both**.

| Risk | Detect | Action | Test |
|---|---|---|---|
| Write path loses unknown/extra tags | roundtrip read after write | preserve (current behavior) | per-format roundtrip + additional-tags roundtrip (extend [existing test](src-tauri/src/tags.rs:531)) |
| Atomicity on partial save failure | per-file `SaveResult` | report per file; don't clear dirty for failures (current [App.tsx:500](src/App.tsx:500)) | cancel-midway test (Phase 7) |
| Corrupt/unreadable files | `read_track` → errored row | skip, show error icon ([FileGrid.tsx:615](src/components/FileGrid.tsx:615)) | `corrupt` corpus scan test (no panic) |
| Unsupported formats | `is_audio` filter | ignore (current) | [scan_filters_non_audio](src-tauri/src/tags.rs:588) |
| Path casing (Win/macOS) | n/a | keep path as identity; dedup is exact-match — document that case-variant paths aren't deduped | note in ADR |
| Symlinks in recursive scan | WalkDir default (no follow) | keep default (avoid cycles) | deep-corpus test |
| Duplicate paths | server sort+dedup + client guard | dedup ([tags.rs:293](src-tauri/src/tags.rs:293), [App.tsx:161](src/App.tsx:161)) | streaming dedup test |
| File modified externally after scan | none today | acceptable for v1; write overwrites — document | — |
| Permissions / read-only files | write error per file | report ([SaveResult](src-tauri/src/tags.rs:84)) | read-only file in `corrupt` corpus |
| File locks (Windows) | write error | report per file | manual |
| Network/cloud folders | none | works but slow; concurrency cap helps | manual note |
| Unicode filenames | `to_string_lossy` | works | Unicode file in corpus |
| Very long Windows paths | OS limit | document; no special handling v1 | manual |

**Rule for Phases 4–7**: any change to scan/save must keep all current data-safety
properties; ordering and per-file error semantics are part of acceptance.

---

## 14. Testing Plan

### Rust (extend `src-tauri/src/tags.rs` tests + add benches)
- Keep passing: [roundtrip](src-tauri/src/tags.rs:472), [additional-tags](src-tauri/src/tags.rs:531), [filter](src-tauri/src/tags.rs:588).
- **Scan parity**: streamed scan output == `scan_paths` output (same order, same tracks) on a fixture tree.
- **Properties-off parity** (Phase 1): `Track` identical with properties on vs off, per format.
- **`has_art` parity** (Phase 1): boolean unchanged with the cheaper detection.
- **Corrupt/unsupported**: scan the corrupt set → no panic, errored rows present, valid rows still read.
- **Concurrency ordering** (Phase 6): parallel scan output == sequential output (byte-identical order).
- **Cancellation** (Phase 5/7): cancel mid-scan/mid-save → consistent state (already-saved clean, rest dirty; partial scan list valid).
- **Save result semantics** (Phase 7): per-file ok/error preserved; cancel-midway leaves correct dirty set.
- Provide **multi-format fixtures** (tiny valid files per format) checked into `src-tauri/tests/fixtures/` (small, not the big corpus).

### Frontend (propose Vitest + React Testing Library as a **separate infra PR** — none exists today)
- Dirty-set logic (edit → dirty, revert → clean) — pure-function tests.
- `selectedRows` / mixed-value derivation correctness.
- Find/replace count + result correctness (incl. match-case, all-fields exclusion of numerics).
- Streaming reducer: batches append in order, dedup, first-batch selection only.
- Cancellation state transitions (busy → cancelled → idle; dirty set intact).

### Manual
- Open tiny/small/large/art-heavy; edit one row; edit many; save many; cancel scan; cancel save; fetch cover art repeatedly; screen-reader smoke; keyboard-only smoke (the §12 script).

### Required verification commands (run for every PR as applicable)
```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
cd src-tauri && cargo fmt --check
cd src-tauri && cargo check
cd src-tauri && cargo clippy -- -D warnings
cd src-tauri && cargo test
cd src-tauri && cargo bench        # perf PRs
pnpm tauri dev                     # manual smoke
```

---

## 15. CI / Release Optimization (`.github/workflows/ci.yml`)

Findings: CI runs changelog-guard, frontend (lint/typecheck/build), and Rust
(**fmt + clippy + build only — no `cargo test`**).

Plan:
- **Add `cargo test`** to the Rust matrix job (catches correctness regressions; the whole plan depends on tests gating scan/save changes).
- Keep fmt + clippy (`-D warnings` already ✓).
- **Tiny benchmark smoke** (optional, opt-in): a fast `cargo bench` on the `tiny` corpus (or a `--quick` criterion run) on a label/`workflow_dispatch`, **not** every commit (full benches are slow and noisy on shared runners).
- **PR template** (§4.6): require before/after numbers for perf-labeled PRs.
- **Release notes**: `scripts/release.sh` + `CHANGELOG` must call out user-visible perf changes ("faster folder opening", "scan now shows files as they load", "cancel a scan/save").
- Platform coverage already spans macOS + Windows ✓; add the same `cargo test` there.

**Acceptance**: CI fails on a Rust test regression; benches runnable on demand; perf PRs carry numbers.

---

## 16. Documentation Requirements (per PR — definition of done)

- **CHANGELOG.md** `[Unreleased]` entry for any user-facing change (CI enforces for `src/`+`src-tauri/src/` per [ci.yml](.github/workflows/ci.yml)). Use `[skip changelog]` only for pure internal/bench/CI work.
- **README.md** only when capabilities change (e.g. "files appear as they load", "cancel scans/saves").
- **CLAUDE.md** when commands/layout/conventions change (e.g. new `bench/` dir, `cargo bench`, corpus generator, new commands).
- **docs/adr/** — new numbered MADR for each notable decision:
  - `0005-streaming-scan-ipc.md` (channels + batch model),
  - `0006-bounded-scan-concurrency.md` (if landed),
  - `0007-cover-art-transport.md` (if changed from base64),
  - `0008-frontend-state-model.md` (dirty set / derivation change).

---

## 17. Risk Register

| Risk | Likelihood | Impact | Mitigation | Test |
|---|---|---|---|---|
| Tag corruption on write | Low | Critical | preserve clone-existing-tag path; no write-path changes without parity bench | per-format roundtrip |
| Losing staged edits | Low | High | structural changes already `clearHistory`; don't change staging semantics | manual + reducer tests |
| Wrong dirty tracking after set refactor | Medium | High | single `recomputeDirty` helper; tests | dirty-set unit tests |
| Save clears dirty for failed files | Low | High | clear only on per-file `ok` (current) | cancel-midway test |
| Parallel scan memory explosion | Medium | High | fix `has_art` materialization first; worker cap; measure RSS | art-heavy RSS bench |
| Parallel write file-lock issues | Medium | High | keep writes sequential by default | — |
| Output ordering changes (stream/concurrency) | Medium | Medium | sort path list first; reassemble by index; parity test | ordering test |
| Stale cover-art display | Low | Medium | keep effect `cancelled` guard | manual |
| base64/blob memory leak | Low | Medium | data URLs GC'd; if blob, revoke on cleanup | heap snapshot |
| Streaming scan race conditions | Medium | Medium | batch append in one setState; first-batch-only selection | reducer tests |
| Cancellation leaves inconsistent UI | Medium | Medium | explicit state machine; clear busy on cancelled/done | state-transition tests |
| Accessibility regression | Medium | High | §12 manual script every UI PR | VO/NVDA smoke |
| Keyboard focus regression (memo/stream) | Medium | High | no focus reset on append; comparator preserves focus props | keyboard smoke |
| Screen-reader regression | Medium | High | keep activedescendant + live regions | VO/NVDA |
| Windows path issues | Low | Medium | keep path identity; document long-path/casing | manual |
| macOS sandbox/path permissions | Low | Medium | report per-file write errors | read-only file test |
| Cloud/network folder weirdness | Low | Low | concurrency cap; document | manual |
| Benchmark overfitting (WAV-only) | **High (current)** | High | **regenerate corpora mixed-format + art-heavy in Phase 0** | corpus diversity check |
| Adding too much complexity | Medium | Medium | §19 guardrails; smallest change that hits targets | review |

---

## 18. Phased Roadmap

Each phase is one (or a few) PR(s). **Do not start a phase until the prior
phase's acceptance holds and numbers are recorded.** Phases 1–3 are low-risk and
independently valuable; 4–8 build on the harness.

### Phase 0 — Benchmark harness (no behavior change)
- **Goal**: measurable baseline; mixed-format + art-heavy corpora.
- **Files**: `scripts/gen-corpus.sh`, `bench/BASELINE.md`, `bench/README.md`, `bench/profiling.md`, `src-tauri/benches/scan.rs`, `src-tauri/Cargo.toml` (criterion dev-dep + `[[bench]]`), `.gitignore` (add `bench-data/`), `.github/PULL_REQUEST_TEMPLATE.md`.
- **Steps**: build generator; regenerate corpora mixed-format; add criterion benches; add backend timing behind `AUDIOTAG_TIMING`; document frontend profiling; capture and commit `BASELINE.md`.
- **Tests/bench**: `cargo bench` runs; harness produces numbers.
- **Acceptance**: §4.6; CI green; no app change.
- **Rollback**: delete harness (no runtime impact).
- **Docs**: CLAUDE.md (new `bench/`, `cargo bench`); CHANGELOG `[skip changelog]`.

### Phase 1 — Backend parse optimization (properties-off + `has_art` audit)
- **Goal**: drop unused audio-property parsing; stop holding art bytes for `has_art`.
- **Files**: `src-tauri/src/tags.rs`, benches, tests, ADR if a parse-option is used.
- **Steps**: confirm lofty 0.24 `ParseOptions::read_properties(false)` (and any picture-skip option); apply in `read_track`; add parity tests; A/B bench.
- **Bench/tests**: properties-off parity, `has_art` parity, per-format roundtrip; criterion before/after.
- **Acceptance**: identical `Track` output; measurable read speedup and/or bounded RSS; else **don't land**.
- **Rollback**: one-line revert to `read_from_path`.
- **Docs**: CHANGELOG (if user-facing scan speedup), ADR if applicable.

### Phase 2 — Frontend render optimization (memoize grid)
- **Goal**: arrow-key move and single-cell edit re-render ≤ 2 rows.
- **Files**: `src/components/FileGrid.tsx` (extract `GridRow`/maybe `GridCell`), `src/App.tsx` (stabilize props/callbacks, `menuItems` dep on targeted row).
- **Steps**: extract `React.memo` row; custom comparator; stabilize callbacks; verify in Profiler.
- **Tests/bench**: Profiler commit count before/after; §12 a11y script.
- **Acceptance**: §8; no a11y/focus regression.
- **Rollback**: remove `React.memo`.
- **Docs**: CHANGELOG `[skip changelog]` (internal) unless perceptible.

### Phase 3 — Dirty set + cheaper derived state + TagEditor mixed-value pass
- **Goal**: `modifiedCount` O(1); `selectedRows` O(selection); save O(dirty); single mixed-value pass; precompiled find/replace regex.
- **Files**: `src/App.tsx`, `src/components/TagEditor.tsx`.
- **Steps**: add `dirtyIds`, maintain incrementally; derive count/selection from sets; precompile FR regex; single-pass mixed values.
- **Tests/bench**: frontend unit tests (dirty set, mixed values, FR count) — may require the test-infra PR (§14) first; Profiler typing latency at 20k.
- **Acceptance**: §7 complexity table holds; §9 typing targets; identical behavior.
- **Rollback**: revert to array scans.
- **Docs**: CHANGELOG `[skip changelog]`; ADR `0008` if state model shifts notably.

### Phase 4 — Streaming scan results
- **Goal**: first rows < 300 ms; responsive during scan.
- **Files**: `src-tauri/src/tags.rs` (+ `scan_paths_streamed`, channel types), `src/api.ts`, `src/App.tsx` (streaming reducer + feature flag), ADR `0005`.
- **Steps**: per §5.3/§6; keep `scan_paths`; client flag.
- **Tests/bench**: scan parity (stream==batch); reducer tests; first-row timing.
- **Acceptance**: §5.3.
- **Rollback**: flip client flag to `scan_paths`.
- **Docs**: CHANGELOG (user-facing), README, ADR `0005`.

### Phase 5 — Progress + cancellation
- **Goal**: scan/save progress announced; cancel < 200 ms.
- **Files**: `src-tauri/src/tags.rs`/`lib.rs` (`cancel_operation`, operation registry), `src/App.tsx` (operation state + Cancel UI), `StatusBar`/`Toolbar`.
- **Steps**: AtomicBool registry; emit progress; Cancel button (a11y per §12); live-region announcements.
- **Tests/bench**: cancellation state-transition tests; cancel-latency manual.
- **Acceptance**: §12 + cancel latency target; consistent state on cancel.
- **Rollback**: hide Cancel UI; ignore cancel flag.
- **Docs**: CHANGELOG, README.

### Phase 6 — Bounded concurrency experiment (only if §4 justifies)
- **Goal**: faster scan with bounded memory.
- **Files**: `src-tauri/src/tags.rs`, benches.
- **Steps**: per §5.2; A/B 1/2/4/8 workers on medium/large/art-heavy.
- **Tests/bench**: ordering parity; RSS bench.
- **Acceptance**: §5.2; land only if a clear win with bounded RSS.
- **Rollback**: worker cap = 1.
- **Docs**: ADR `0006`, CHANGELOG if user-facing.

### Phase 7 — Save changeset/progress optimization
- **Goal**: responsive, cancellable save; smaller payload if measured.
- **Files**: `src-tauri/src/tags.rs` (`save_changes`), `src/api.ts`, `src/App.tsx`.
- **Steps**: per §5.4; sequential writes default; per-file events; keep `save_tracks`.
- **Tests/bench**: roundtrip parity; cancel-midway dirty-set test.
- **Acceptance**: §5.4.
- **Rollback**: revert to `save_tracks`.
- **Docs**: CHANGELOG, README.

### Phase 8 — Cover-art transport/memory (only if measured)
- **Goal**: bounded cover-art memory; no jank on huge covers.
- **Files**: `src-tauri/src/tags.rs`/`lib.rs` (protocol), `src/components/TagEditor.tsx`.
- **Steps**: per §11; protocol or blob-URL only if heap snapshots justify.
- **Tests/bench**: 100-selection heap snapshot.
- **Acceptance**: §11.
- **Rollback**: revert to base64.
- **Docs**: ADR `0007`, CHANGELOG if user-facing.

### Phase 9 — Optional deeper refactors (only if still needed)
- Normalized state (Map + id list) if §7's minimal approach didn't hit targets.
- Web Worker for huge find/replace (if §10 still blocks).
- Lighter `originals`/diff model (if §9 memory is a measured problem).
- Additional CI/perf tooling.
- Each: own PR, own measurement, own acceptance.

---

## 19. Do Not Do Yet (avoid unless benchmarks force it)

- Full rewrite.
- Replacing Tauri or React.
- Adding Redux/Zustand/MobX (use `useState`/`useRef` + sets/maps).
- Binary IPC protocol (keep JSON batches).
- Eager cover-art loading during scan (**never**).
- Unbounded parallel scan or unbounded parallel save.
- Changing tag write semantics or dropping unknown-tag preservation.
- Changing supported formats casually.
- Persistent database / on-disk index.
- Adding an image-processing dependency.
- Changing numeric fields from strings (UI-side validation contract).
- Large UI redesign.
- Accessibility shortcuts (a11y is definition-of-done).
- Optimizing CSS before render/backend bottlenecks are measured.

---

## 20. Execution Notes for the Coding Agent

- Start with **Phase 0**; you cannot justify any later phase without `bench/BASELINE.md`.
- The **single most important Phase-0 correction**: the committed `bench-data/`
  is WAV-only — regenerate mixed-format + art-heavy, or every later measurement
  understates the real wins (and risks benchmark overfitting, §17).
- Land Phases 1–3 first: they are low-risk, independently shippable, and likely
  the highest user-felt improvement per unit risk (parse cost, render churn,
  O(n) edits).
- For every PR: run the §14 command block; update docs per §16; for perf PRs fill
  the §4.6 before/after numbers; run the §12 a11y script for any UI change.
- Treat data safety (§13) and accessibility (§12) as hard gates — a perf win that
  regresses either does not merge.
```

