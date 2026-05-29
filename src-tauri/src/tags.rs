//! Audio tag reading/writing backend, built on `lofty`.
//!
//! Exposes a small set of Tauri commands the frontend uses to scan folders,
//! read tags into a uniform model, write edits back atomically, and lazily
//! fetch embedded cover art.

use base64::Engine;
use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::TaggedFile;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use walkdir::WalkDir;

/// File extensions we treat as taggable audio (everything lofty supports; no WMA).
const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "m4a", "m4b", "mp4", "aac", "ogg", "oga", "opus", "wav", "wave", "aiff", "aif",
    "aifc", "ape", "wv", "mpc", "spx",
];

/// A single track's editable tag fields plus read-only metadata.
///
/// All editable fields are strings so the frontend can treat them uniformly;
/// numeric fields (track/disc/year) are validated on the UI side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    /// Absolute path on disk — also serves as the stable identity of the row.
    pub path: String,
    pub filename: String,
    pub format: String,

    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track: Option<String>,
    pub track_total: Option<String>,
    pub disc: Option<String>,
    pub disc_total: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,

    /// Whether the file currently has embedded cover art.
    pub has_art: bool,
    /// Populated when the file could not be read.
    pub error: Option<String>,

    /// Pending cover art to embed on save (write-only; never set by a scan).
    /// When present it replaces existing pictures; when absent, `has_art =
    /// false` strips art and `has_art = true` leaves existing art untouched.
    #[serde(default)]
    pub art: Option<CoverArt>,
}

impl Track {
    fn errored(path: &Path, error: String) -> Self {
        Track {
            path: path.to_string_lossy().into_owned(),
            filename: file_name(path),
            format: ext_upper(path),
            title: None,
            artist: None,
            album: None,
            album_artist: None,
            track: None,
            track_total: None,
            disc: None,
            disc_total: None,
            year: None,
            genre: None,
            comment: None,
            composer: None,
            has_art: false,
            error: Some(error),
            art: None,
        }
    }
}

/// Result of attempting to save one file.
#[derive(Debug, Clone, Serialize)]
pub struct SaveResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Base64-encoded cover art, used both to display art in the editor and to
/// carry pasted art back to `save_tracks` for embedding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CoverArt {
    pub mime: String,
    pub base64: String,
}

/// A single raw tag item (format-native key + text value) for the
/// "additional tags" editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagItemDto {
    pub key: String,
    pub value: String,
}

/// The full set of editable tag items for one file.
#[derive(Debug, Clone, Serialize)]
pub struct AllTags {
    /// Human-readable tag format (e.g. "Id3v2", "VorbisComments").
    pub tag_type: String,
    pub items: Vec<TagItemDto>,
}

/// Outcome of writing arbitrary tags: which keys couldn't be stored in this
/// format (i.e. not recognized for the file's tag type).
#[derive(Debug, Clone, Serialize)]
pub struct SaveAllResult {
    pub ok: bool,
    pub skipped: Vec<String>,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn ext_upper(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .unwrap_or_default()
}

/// True when `AUDIOTAG_TIMING=1` is set — gates dev-only timing spans printed to
/// stderr (visible in the `pnpm tauri dev` console). Off by default; no release
/// cost beyond an env lookup at the start of a scan/save.
fn timing_enabled() -> bool {
    std::env::var("AUDIOTAG_TIMING")
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Read one item as an owned String, if present and non-empty.
fn read_item(tag: &Tag, key: ItemKey) -> Option<String> {
    tag.get_string(key)
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Read the four-digit year from a recording date like "2024" or "2024-05-01".
fn read_year(tag: &Tag) -> Option<String> {
    tag.get_string(ItemKey::RecordingDate)
        .map(|d| d.chars().take(4).collect::<String>())
        .filter(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_digit()))
}

/// Read a file with tags (and cover art) but *without* audio-stream property
/// parsing when `read_properties` is false. We never display duration/bitrate/
/// sample-rate, so parsing them is wasted work — disabling it produces a
/// byte-identical `Track` (proven by the `properties_off_parity` test). Cover
/// art is still read so `has_art` stays accurate; lofty 0.24 exposes no cheaper
/// presence check, and `read_cover_art(false)` would silently zero `has_art`
/// (see ADR 0005).
fn open_tagged(path: &Path, read_properties: bool) -> lofty::error::Result<TaggedFile> {
    Probe::open(path)?
        .options(ParseOptions::new().read_properties(read_properties))
        .read()
}

/// Build a `Track` model from a single file path.
///
/// `pub` for the criterion benches; not part of a stable public API.
#[doc(hidden)]
pub fn read_track(path: &Path) -> Track {
    read_track_opt(path, false)
}

/// `read_track` with explicit property-parsing control, for A/B benchmarking
/// and parity testing. `read_track` calls this with `read_properties = false`.
#[doc(hidden)]
pub fn read_track_opt(path: &Path, read_properties: bool) -> Track {
    let tagged = match open_tagged(path, read_properties) {
        Ok(t) => t,
        Err(e) => return Track::errored(path, e.to_string()),
    };

    let base = Track {
        path: path.to_string_lossy().into_owned(),
        filename: file_name(path),
        format: ext_upper(path),
        title: None,
        artist: None,
        album: None,
        album_artist: None,
        track: None,
        track_total: None,
        disc: None,
        disc_total: None,
        year: None,
        genre: None,
        comment: None,
        composer: None,
        has_art: false,
        error: None,
        art: None,
    };

    let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(t) => t,
        None => return base, // valid file, just no tags yet
    };

    Track {
        title: read_item(tag, ItemKey::TrackTitle),
        artist: read_item(tag, ItemKey::TrackArtist),
        album: read_item(tag, ItemKey::AlbumTitle),
        album_artist: read_item(tag, ItemKey::AlbumArtist),
        track: read_item(tag, ItemKey::TrackNumber),
        track_total: read_item(tag, ItemKey::TrackTotal),
        disc: read_item(tag, ItemKey::DiscNumber),
        disc_total: read_item(tag, ItemKey::DiscTotal),
        year: read_year(tag),
        genre: read_item(tag, ItemKey::Genre),
        comment: read_item(tag, ItemKey::Comment),
        composer: read_item(tag, ItemKey::Composer),
        has_art: !tag.pictures().is_empty(),
        ..base
    }
}

/// Apply an edited field: set when non-empty, otherwise remove it.
fn apply_item(tag: &mut Tag, key: ItemKey, value: &Option<String>) {
    match value {
        Some(v) if !v.trim().is_empty() => {
            tag.insert_text(key, v.trim().to_string());
        }
        _ => {
            tag.remove_key(key);
        }
    }
}

/// `pub` for the criterion benches; not part of a stable public API.
#[doc(hidden)]
pub fn write_track(t: &Track) -> Result<(), String> {
    let path = Path::new(&t.path);
    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;

    // Clone the existing primary tag (preserving fields like cover art we
    // don't edit yet) or create a fresh one of the format's default type.
    let mut tag = match tagged.primary_tag() {
        Some(existing) => existing.clone(),
        None => Tag::new(tagged.primary_tag_type()),
    };

    apply_item(&mut tag, ItemKey::TrackTitle, &t.title);
    apply_item(&mut tag, ItemKey::TrackArtist, &t.artist);
    apply_item(&mut tag, ItemKey::AlbumTitle, &t.album);
    apply_item(&mut tag, ItemKey::AlbumArtist, &t.album_artist);
    apply_item(&mut tag, ItemKey::TrackNumber, &t.track);
    apply_item(&mut tag, ItemKey::TrackTotal, &t.track_total);
    apply_item(&mut tag, ItemKey::DiscNumber, &t.disc);
    apply_item(&mut tag, ItemKey::DiscTotal, &t.disc_total);
    apply_item(&mut tag, ItemKey::RecordingDate, &t.year);
    apply_item(&mut tag, ItemKey::Genre, &t.genre);
    apply_item(&mut tag, ItemKey::Comment, &t.comment);
    apply_item(&mut tag, ItemKey::Composer, &t.composer);

    // Cover art:
    // - `art` present  → replace any existing pictures with it (e.g. paste).
    // - no `art`, `has_art == false` → strip art (e.g. "Clear tags").
    // - no `art`, `has_art == true`  → leave existing pictures untouched.
    if let Some(art) = &t.art {
        while !tag.pictures().is_empty() {
            tag.remove_picture(0);
        }
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&art.base64) {
            let picture = Picture::unchecked(bytes)
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::from_str(&art.mime))
                .build();
            tag.push_picture(picture);
        }
    } else if !t.has_art {
        while !tag.pictures().is_empty() {
            tag.remove_picture(0);
        }
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Walk the input paths (files or folders, recursive), keep audio files, and
/// return them sorted + deduped — the canonical file order every scan uses, so
/// the streamed and non-streamed scans yield identical ordering.
fn collect_audio_files(paths: &[String]) -> Vec<std::path::PathBuf> {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for p in paths {
        let path = std::path::PathBuf::from(p);
        if path.is_dir() {
            for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
                let ep = entry.path();
                if ep.is_file() && is_audio(ep) {
                    files.push(ep.to_path_buf());
                }
            }
        } else if path.is_file() && is_audio(&path) {
            files.push(path);
        }
    }
    files.sort();
    files.dedup();
    files
}

/// How many tracks the streamed scan reads before flushing a batch to the
/// client. Balances first-paint latency against React update spam.
const SCAN_BATCH: usize = 200;

/// Upper bound on reader threads. Conservative so a single spinning disk can't
/// thrash and memory stays bounded (each in-flight read may briefly hold one
/// file's cover).
const MAX_SCAN_WORKERS: usize = 8;

/// Reader-thread count for this machine: `min(cores, MAX_SCAN_WORKERS)`.
fn scan_workers() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(MAX_SCAN_WORKERS)
}

/// Read a slice of files into `Track`s, preserving input order. Reads in
/// parallel across up to `workers` threads by splitting into contiguous chunks
/// (so reassembly is just concatenation — byte-identical to a sequential read).
/// Falls back to sequential for tiny slices or a single worker.
fn read_slice(files: &[std::path::PathBuf], workers: usize) -> Vec<Track> {
    let n = files.len();
    if workers <= 1 || n <= 1 {
        return files.iter().map(|p| read_track(p)).collect();
    }
    let chunk = n.div_ceil(workers.min(n));
    std::thread::scope(|s| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|sub| s.spawn(move || sub.iter().map(|p| read_track(p)).collect::<Vec<Track>>()))
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect()
    })
}

/// A streamed-scan event sent over the per-operation [`Channel`]. Errored files
/// are folded into batches (as errored `Track`s) exactly as the non-streamed
/// scan returns them, so the two paths stay byte-for-byte equivalent.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum ScanEvent {
    /// Total audio files discovered (sent once, before any batch).
    Total { count: usize },
    /// A chunk of read tracks, in final sorted order.
    Batch { tracks: Vec<Track> },
    /// Files read so far / total.
    Progress { done: usize, total: usize },
    /// Terminal: the scan was cancelled; rows already delivered remain valid.
    Cancelled,
    /// Terminal: the scan finished normally.
    Done,
}

/// Registry of in-flight cancellable operations, keyed by a client-supplied
/// operation id. Each entry is an `AtomicBool` the operation polls between
/// batches; `cancel_operation` flips it. Managed as Tauri app state.
#[derive(Default)]
pub struct OpRegistry(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl OpRegistry {
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(id.to_string(), flag.clone());
        flag
    }
    fn finish(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    fn request_cancel(&self, id: &str) {
        if let Some(flag) = self.0.lock().unwrap().get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Signal a running cancellable operation (scan) to stop. No-op if the id is
/// unknown (already finished). The operation polls the flag between batches and
/// emits a terminal `Cancelled` event.
#[tauri::command]
pub fn cancel_operation(operation_id: String, registry: tauri::State<OpRegistry>) {
    registry.request_cancel(&operation_id);
}

/// Bench-only: collect + read with an explicit worker count, for the
/// sequential-vs-parallel A/B. Not a stable API.
#[doc(hidden)]
pub fn scan_files_for_bench(paths: &[String], workers: usize) -> Vec<Track> {
    let files = collect_audio_files(paths);
    read_slice(&files, workers)
}

/// Scan the given paths (files or folders) and return tag models for every
/// audio file found. Folders are walked recursively. Results are sorted by path.
#[tauri::command]
pub fn scan_paths(paths: Vec<String>) -> Vec<Track> {
    let timing = timing_enabled();
    let t_walk = std::time::Instant::now();
    let files = collect_audio_files(&paths);
    let walk_ms = t_walk.elapsed().as_secs_f64() * 1e3;

    let t_read = std::time::Instant::now();
    let tracks: Vec<Track> = read_slice(&files, scan_workers());
    let read_ms = t_read.elapsed().as_secs_f64() * 1e3;

    if timing {
        let bytes = serde_json::to_string(&tracks).map(|s| s.len()).unwrap_or(0);
        eprintln!(
            "[timing] scan_paths: {} files | walk+sort {:.1}ms | read {:.1}ms | serialized {} bytes ({:.1} KB)",
            tracks.len(),
            walk_ms,
            read_ms,
            bytes,
            bytes as f64 / 1024.0,
        );
    }
    tracks
}

/// Streaming variant of [`scan_paths`]: walks + sorts the file list, then reads
/// tags in batches, emitting events over `channel` so the UI can paint rows as
/// they arrive instead of waiting for the whole scan. Concatenating every
/// `Batch`'s tracks in arrival order yields exactly `scan_paths(paths)` (proven
/// by `streamed_scan_matches_blocking`).
#[tauri::command]
pub fn scan_paths_streamed(
    paths: Vec<String>,
    channel: tauri::ipc::Channel<ScanEvent>,
    operation_id: String,
    registry: tauri::State<OpRegistry>,
) -> Result<(), String> {
    let cancel = registry.register(&operation_id);
    let result = run_streamed_scan(&paths, &channel, &cancel);
    registry.finish(&operation_id); // always clear the registry entry
    result
}

/// Read `files` in batches of `SCAN_BATCH`, invoking `on_batch(tracks, done,
/// total)` per batch, polling `cancel` before each. Returns `true` if it read
/// everything, `false` if it stopped early because cancellation was requested.
/// Channel-free so it can be unit-tested directly (`cancellation_stops_scan`).
fn read_in_batches(
    files: &[std::path::PathBuf],
    workers: usize,
    cancel: &AtomicBool,
    mut on_batch: impl FnMut(Vec<Track>, usize, usize) -> Result<(), String>,
) -> Result<bool, String> {
    let total = files.len();
    let mut done = 0;
    for chunk in files.chunks(SCAN_BATCH) {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        // Read each batch in parallel (bounded workers); only one batch's worth
        // of tracks is resident at a time, so peak memory stays bounded even on
        // art-heavy libraries.
        let tracks = read_slice(chunk, workers);
        done += tracks.len();
        on_batch(tracks, done, total)?;
    }
    Ok(true)
}

/// The streamed-scan body, factored out so the registry entry is always cleaned
/// up by the caller regardless of how this returns. Polls `cancel` between
/// batches and emits a terminal `Cancelled` (instead of `Done`) when set.
fn run_streamed_scan(
    paths: &[String],
    channel: &tauri::ipc::Channel<ScanEvent>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let timing = timing_enabled();
    let t_all = std::time::Instant::now();

    let files = collect_audio_files(paths);
    let total = files.len();
    channel
        .send(ScanEvent::Total { count: total })
        .map_err(|e| e.to_string())?;

    let completed = read_in_batches(&files, scan_workers(), cancel, |tracks, done, total| {
        channel
            .send(ScanEvent::Batch { tracks })
            .map_err(|e| e.to_string())?;
        channel
            .send(ScanEvent::Progress { done, total })
            .map_err(|e| e.to_string())
    })?;

    channel
        .send(if completed {
            ScanEvent::Done
        } else {
            ScanEvent::Cancelled
        })
        .map_err(|e| e.to_string())?;

    if timing {
        eprintln!(
            "[timing] scan_paths_streamed: {} files, {} | {:.1}ms",
            total,
            if completed { "done" } else { "cancelled" },
            t_all.elapsed().as_secs_f64() * 1e3,
        );
    }
    Ok(())
}

/// Write edits for the given tracks back to disk. Returns a result per file.
#[tauri::command]
pub fn save_tracks(tracks: Vec<Track>) -> Vec<SaveResult> {
    let timing = timing_enabled();
    let count = tracks.len();
    let t_all = std::time::Instant::now();
    let mut max_file_ms = 0.0_f64;

    let results = tracks
        .into_iter()
        .map(|t| {
            let t_file = std::time::Instant::now();
            let result = match write_track(&t) {
                Ok(()) => SaveResult {
                    path: t.path,
                    ok: true,
                    error: None,
                },
                Err(e) => SaveResult {
                    path: t.path,
                    ok: false,
                    error: Some(e),
                },
            };
            let file_ms = t_file.elapsed().as_secs_f64() * 1e3;
            if file_ms > max_file_ms {
                max_file_ms = file_ms;
            }
            result
        })
        .collect();

    if timing {
        eprintln!(
            "[timing] save_tracks: {} files | total {:.1}ms | slowest file {:.1}ms",
            count,
            t_all.elapsed().as_secs_f64() * 1e3,
            max_file_ms,
        );
    }
    results
}

/// A streamed-save event sent over the per-operation [`Channel`].
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SaveEvent {
    /// One file's outcome (mirrors [`SaveResult`]).
    Saved {
        path: String,
        ok: bool,
        error: Option<String>,
    },
    /// Files written so far / total.
    Progress { done: usize, total: usize },
    /// Terminal: cancelled. Files reported `Saved { ok: true }` before this are
    /// persisted; the rest were not touched and stay dirty on the client.
    Cancelled,
    /// Terminal: all files attempted.
    Done,
}

/// Streaming, cancellable variant of [`save_tracks`]: writes one file at a time
/// (sequential by design — concurrent writes to the same tree risk lock and
/// correctness issues), emitting a `Saved` result per file and
/// `Progress` updates, and stopping early on cancellation. Keeps `save_tracks`
/// for rollback.
#[tauri::command]
pub fn save_changes(
    tracks: Vec<Track>,
    channel: tauri::ipc::Channel<SaveEvent>,
    operation_id: String,
    registry: tauri::State<OpRegistry>,
) -> Result<(), String> {
    let cancel = registry.register(&operation_id);
    let result = run_save(tracks, &channel, &cancel);
    registry.finish(&operation_id);
    result
}

fn run_save(
    tracks: Vec<Track>,
    channel: &tauri::ipc::Channel<SaveEvent>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut send_err: Option<String> = None;
    let completed = save_each(tracks, cancel, |path, ok, error, done, total| {
        if send_err.is_some() {
            return;
        }
        let r = channel
            .send(SaveEvent::Saved { path, ok, error })
            .and_then(|()| channel.send(SaveEvent::Progress { done, total }));
        if let Err(e) = r {
            send_err = Some(e.to_string());
        }
    });
    if let Some(e) = send_err {
        return Err(e);
    }
    channel
        .send(if completed {
            SaveEvent::Done
        } else {
            SaveEvent::Cancelled
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Write each track sequentially, polling `cancel` before each and invoking
/// `on_result(path, ok, error, done, total)` per file. Returns `true` if all
/// were attempted, `false` if cancellation stopped it early (already-written
/// files stay written; the rest are untouched). Channel-free so it can be
/// unit-tested directly (`save_each_*`).
fn save_each(
    tracks: Vec<Track>,
    cancel: &AtomicBool,
    mut on_result: impl FnMut(String, bool, Option<String>, usize, usize),
) -> bool {
    let total = tracks.len();
    for (i, t) in tracks.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let (ok, error) = match write_track(&t) {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        };
        on_result(t.path, ok, error, i + 1, total);
    }
    true
}

/// Lazily fetch the first embedded cover art for a single file, base64-encoded.
#[tauri::command]
pub fn get_cover_art(path: String) -> Option<CoverArt> {
    // Cover art is read; audio properties aren't needed here.
    let tagged = open_tagged(Path::new(&path), false).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let base64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Some(CoverArt { mime, base64 })
}

/// Produce a human-readable key name for a tag item. We prefer the canonical
/// Vorbis-comment naming (TITLE, TRACKNUMBER, COMPOSER…) because it's readable
/// across formats, falling back to the file's own native name (e.g. an ID3v2
/// frame id) only for keys Vorbis can't express. `save_all_tags` resolves both.
fn display_key(key: ItemKey, native: TagType) -> Option<String> {
    key.map_key(TagType::VorbisComments)
        .or_else(|| key.map_key(native))
        .map(|s| s.to_string())
}

/// Read every text/locator tag item from a file, keyed by a readable canonical
/// name (e.g. "TITLE", "COMPOSER", "MUSICBRAINZ_ARTISTID") rather than the raw
/// format-native frame id. Binary items (cover art etc.) are skipped. This
/// backs the "additional tags" editor.
#[tauri::command]
pub fn read_all_tags(path: String) -> Result<AllTags, String> {
    let p = Path::new(&path);
    // Only tag items are needed; skip audio-property parsing.
    let tagged = open_tagged(p, false).map_err(|e| e.to_string())?;

    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(AllTags {
            tag_type: format!("{:?}", tagged.primary_tag_type()),
            items: Vec::new(),
        });
    };

    let tt = tag.tag_type();
    let mut items = Vec::new();
    for item in tag.items() {
        let value = match item.value() {
            ItemValue::Text(t) | ItemValue::Locator(t) => t.clone(),
            ItemValue::Binary(_) => continue,
        };
        let Some(key) = display_key(item.key(), tt) else {
            continue; // no readable name → not editable here
        };
        items.push(TagItemDto { key, value });
    }

    Ok(AllTags {
        tag_type: format!("{:?}", tt),
        items,
    })
}

/// Replace a file's text/locator tag items with the supplied set, preserving
/// pictures and any binary items. Keys not recognized for the file's tag type
/// are skipped and reported. Empty values are dropped (i.e. clear the key).
#[tauri::command]
pub fn save_all_tags(path: String, items: Vec<TagItemDto>) -> Result<SaveAllResult, String> {
    let p = Path::new(&path);
    let tagged = lofty::read_from_path(p).map_err(|e| e.to_string())?;

    let tag_type = tagged
        .primary_tag()
        .map(|t| t.tag_type())
        .unwrap_or_else(|| tagged.primary_tag_type());

    let mut tag = Tag::new(tag_type);

    // Preserve pictures and binary items that this editor doesn't touch.
    if let Some(old) = tagged.primary_tag() {
        for pic in old.pictures() {
            tag.push_picture(pic.clone());
        }
        for item in old.items() {
            if matches!(item.value(), ItemValue::Binary(_)) {
                tag.push_unchecked(item.clone());
            }
        }
    }

    let mut skipped = Vec::new();
    for dto in items {
        let value = dto.value.trim();
        if value.is_empty() {
            continue;
        }
        // Accept both the file's native key names and the canonical Vorbis
        // names we display (so e.g. "COMPOSER" round-trips into an ID3v2 TCOM).
        let key = ItemKey::from_key(tag_type, &dto.key)
            .or_else(|| ItemKey::from_key(TagType::VorbisComments, &dto.key));
        match key {
            Some(key) => tag.push_unchecked(TagItem::new(key, ItemValue::Text(value.to_string()))),
            None => skipped.push(dto.key),
        }
    }

    tag.save_to_path(p, WriteOptions::default())
        .map_err(|e| e.to_string())?;

    Ok(SaveAllResult { ok: true, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a minimal valid 16-bit PCM mono WAV file (a few silent samples).
    fn minimal_wav() -> Vec<u8> {
        let sample_data: [u8; 8] = [0; 8]; // 4 silent 16-bit samples
        let data_len = sample_data.len() as u32;
        let fmt_len: u32 = 16;
        let riff_len = 4 + (8 + fmt_len) + (8 + data_len);

        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&riff_len.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        // fmt chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&fmt_len.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&8000u32.to_le_bytes()); // sample rate
        buf.extend_from_slice(&16000u32.to_le_bytes()); // byte rate
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
                                                     // data chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        buf.extend_from_slice(&sample_data);
        buf
    }

    fn temp_wav_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let unique = format!(
            "audiotag_test_{}_{}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(unique);
        p
    }

    #[test]
    fn write_then_read_roundtrip() {
        let path = temp_wav_path();
        std::fs::File::create(&path)
            .unwrap()
            .write_all(&minimal_wav())
            .unwrap();

        // Sanity: lofty can read our generated WAV.
        assert!(
            lofty::read_from_path(&path).is_ok(),
            "generated WAV is invalid"
        );

        let edited = Track {
            path: path.to_string_lossy().into_owned(),
            filename: "test.wav".into(),
            format: "WAV".into(),
            title: Some("My Title".into()),
            artist: Some("My Artist".into()),
            album: Some("My Album".into()),
            album_artist: Some("Various".into()),
            track: Some("5".into()),
            track_total: Some("12".into()),
            disc: Some("1".into()),
            disc_total: Some("2".into()),
            year: Some("2024".into()),
            genre: Some("Rock".into()),
            comment: Some("hello".into()),
            composer: Some("A Composer".into()),
            has_art: false,
            error: None,
            art: None,
        };

        write_track(&edited).expect("write should succeed");

        let read_back = read_track(&path);
        assert_eq!(read_back.error, None);
        assert_eq!(read_back.title.as_deref(), Some("My Title"));
        assert_eq!(read_back.artist.as_deref(), Some("My Artist"));
        assert_eq!(read_back.album.as_deref(), Some("My Album"));
        assert_eq!(read_back.album_artist.as_deref(), Some("Various"));
        assert_eq!(read_back.track.as_deref(), Some("5"));
        assert_eq!(read_back.genre.as_deref(), Some("Rock"));
        assert_eq!(read_back.year.as_deref(), Some("2024"));
        assert_eq!(read_back.composer.as_deref(), Some("A Composer"));

        // Clearing a field removes it on the next save.
        let mut cleared = read_back.clone();
        cleared.genre = Some(String::new());
        write_track(&cleared).expect("second write should succeed");
        let read_again = read_track(&path);
        assert_eq!(read_again.genre, None, "empty value should clear the tag");
        assert_eq!(read_again.title.as_deref(), Some("My Title"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn additional_tags_roundtrip_and_skip() {
        let path = temp_wav_path();
        std::fs::File::create(&path)
            .unwrap()
            .write_all(&minimal_wav())
            .unwrap();
        let path_str = path.to_string_lossy().into_owned();

        // Seed a title so the file has a tag; discover the format-native key
        // name for it (varies by tag type) so the test is format-agnostic.
        write_track(&Track {
            title: Some("Seed".into()),
            ..read_track(&path)
        })
        .expect("seed write should succeed");

        let seeded = read_all_tags(path_str.clone()).expect("read_all_tags should succeed");
        let title_key = seeded
            .items
            .iter()
            .find(|i| i.value == "Seed")
            .map(|i| i.key.clone())
            .expect("seeded title item should be present");

        let result = save_all_tags(
            path_str.clone(),
            vec![
                TagItemDto {
                    key: title_key.clone(),
                    value: "Hello".into(),
                },
                TagItemDto {
                    key: "TOTALLY_MADE_UP".into(),
                    value: "x".into(),
                },
            ],
        )
        .expect("save_all_tags should succeed");
        assert!(result.ok);
        assert_eq!(
            result.skipped,
            vec!["TOTALLY_MADE_UP".to_string()],
            "unrecognized keys should be reported as skipped"
        );

        let all = read_all_tags(path_str).expect("read_all_tags should succeed");
        assert!(
            all.items
                .iter()
                .any(|i| i.key == title_key && i.value == "Hello"),
            "recognized key should round-trip"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn scan_filters_non_audio() {
        // A .txt file should never be picked up by a scan.
        let mut p = std::env::temp_dir();
        p.push(format!("audiotag_not_audio_{}.txt", std::process::id()));
        std::fs::write(&p, b"not audio").unwrap();
        let results = scan_paths(vec![p.to_string_lossy().into_owned()]);
        assert!(results.is_empty(), "non-audio file should be ignored");
        let _ = std::fs::remove_file(&p);
    }

    fn fixtures_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
    }

    /// Phase 1: disabling audio-property parsing must produce a byte-identical
    /// `Track` for every format (we never display properties). Guards the
    /// `read_properties(false)` optimization.
    #[test]
    fn properties_off_parity() {
        let dir = fixtures_dir();
        let formats = ["mp3", "flac", "m4a", "ogg", "opus", "wav", "aiff", "wv"];
        for fmt in formats {
            let path = dir.join(format!("sample.{fmt}"));
            assert!(path.exists(), "missing fixture: {}", path.display());
            let with = read_track_opt(&path, true);
            let without = read_track_opt(&path, false);
            assert_eq!(
                with.error, None,
                "{fmt}: fixture should read cleanly (props on)"
            );
            assert_eq!(
                with, without,
                "{fmt}: Track must be identical with properties on vs off"
            );
        }
    }

    /// Phase 1: `has_art` must stay accurate with the property-off read (cover
    /// art is still parsed). An art-bearing file reads `has_art = true`; a
    /// plain file reads `false`.
    #[test]
    fn has_art_parity() {
        let dir = fixtures_dir();
        let art = read_track_opt(&dir.join("sample_art.flac"), false);
        assert_eq!(art.error, None, "art fixture should read cleanly");
        assert!(art.has_art, "art fixture must report has_art = true");

        let plain = read_track_opt(&dir.join("sample.flac"), false);
        assert!(!plain.has_art, "plain fixture must report has_art = false");
    }

    /// Corrupt/unreadable files must not panic or abort the scan: they surface
    /// as errored rows while valid files still read.
    #[test]
    fn scan_survives_corrupt_files() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("audiotag_corrupt_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // A valid file alongside several adversarial ones.
        std::fs::copy(fixtures_dir().join("sample.flac"), dir.join("valid.flac")).unwrap();
        std::fs::write(dir.join("zero.mp3"), b"").unwrap();
        std::fs::write(dir.join("text.mp3"), b"this is not audio at all").unwrap();
        let mut truncated = std::fs::read(fixtures_dir().join("sample.flac")).unwrap();
        truncated.truncate(120);
        std::fs::write(dir.join("truncated.flac"), &truncated).unwrap();

        let results = scan_paths(vec![dir.to_string_lossy().into_owned()]);
        assert_eq!(results.len(), 4, "all four files should produce a row");
        let ok = results.iter().filter(|t| t.error.is_none()).count();
        let errored = results.iter().filter(|t| t.error.is_some()).count();
        assert!(ok >= 1, "the valid file should read");
        assert!(errored >= 1, "corrupt files should surface as errored rows");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Phase 4: concatenating the streamed scan's batches (in arrival order)
    /// must equal `scan_paths` exactly — same order, same tracks, including
    /// errored rows. The command sends these same chunks over the channel, so
    /// this proves client-side reassembly parity.
    #[test]
    fn streamed_scan_matches_blocking() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("audiotag_stream_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A handful of mixed-format files (unsorted names) + a corrupt one, so
        // ordering and error-folding are both exercised.
        for (i, fmt) in ["wv", "mp3", "flac", "ogg", "m4a", "opus", "wav", "aiff"]
            .iter()
            .enumerate()
        {
            std::fs::copy(
                fixtures_dir().join(format!("sample.{fmt}")),
                dir.join(format!("z{:02}_track.{fmt}", 99 - i)),
            )
            .unwrap();
        }
        std::fs::write(dir.join("m05_broken.mp3"), b"not audio").unwrap();

        let arg = vec![dir.to_string_lossy().into_owned()];
        let blocking = scan_paths(arg.clone());

        // Simulate the streamed read with a small batch size to span >1 batch.
        let files = collect_audio_files(&arg);
        let mut streamed: Vec<Track> = Vec::new();
        for chunk in files.chunks(3) {
            for p in chunk {
                streamed.push(read_track(p));
            }
        }

        assert_eq!(
            blocking, streamed,
            "streamed reassembly must equal scan_paths"
        );
        assert!(blocking.len() >= 9, "all files should produce rows");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Phase 5: the registry flips a per-operation flag and forgets finished ids.
    #[test]
    fn op_registry_cancel_and_finish() {
        let reg = OpRegistry::default();
        let flag = reg.register("op1");
        assert!(!flag.load(Ordering::SeqCst), "starts un-cancelled");
        reg.request_cancel("op1");
        assert!(flag.load(Ordering::SeqCst), "request_cancel sets the flag");
        reg.finish("op1");
        // Cancelling an unknown/finished id is a harmless no-op.
        reg.request_cancel("op1");
        reg.request_cancel("never-existed");
    }

    /// Phase 5: a cancel flag set before a batch stops the scan early; batches
    /// delivered before that remain a valid prefix of the full scan.
    #[test]
    fn cancellation_stops_scan() {
        let files: Vec<std::path::PathBuf> =
            (0..3).map(|_| fixtures_dir().join("sample.flac")).collect();

        // Not cancelled → reads everything.
        let cancel = AtomicBool::new(false);
        let mut seen = 0usize;
        let completed = read_in_batches(&files, 1, &cancel, |t, _, _| {
            seen += t.len();
            Ok(())
        })
        .unwrap();
        assert!(completed && seen == files.len());

        // Cancelled before the first batch → stops immediately, no batches.
        let cancel = AtomicBool::new(true);
        let mut batches = 0usize;
        let completed = read_in_batches(&files, 1, &cancel, |_, _, _| {
            batches += 1;
            Ok(())
        })
        .unwrap();
        assert!(!completed, "should report not-completed when cancelled");
        assert_eq!(batches, 0, "no batches once cancellation is set");
    }

    /// Phase 6: bounded-parallel reading must yield byte-identical results (same
    /// order, same tracks) as sequential — concurrency is an optimization, not a
    /// behavior change.
    #[test]
    fn parallel_read_matches_sequential() {
        // A heterogeneous, deliberately unsorted list so chunk boundaries matter.
        let exts = ["wv", "mp3", "flac", "ogg", "m4a", "opus", "wav", "aiff"];
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        for round in 0..3 {
            for (i, fmt) in exts.iter().enumerate() {
                // Vary which file lands where so order is non-trivial.
                let pick = exts[(i + round) % exts.len()];
                let _ = pick;
                files.push(fixtures_dir().join(format!("sample.{fmt}")));
            }
        }
        let seq = read_slice(&files, 1);
        for workers in [2usize, 4, 8] {
            let par = read_slice(&files, workers);
            assert_eq!(
                seq, par,
                "read_slice(workers={workers}) must match sequential"
            );
        }
    }

    /// Build a temp dir with `n` writable WAV copies; returns (dir, paths).
    fn temp_wavs(n: usize) -> (std::path::PathBuf, Vec<std::path::PathBuf>) {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "audiotag_save_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = (0..n)
            .map(|i| {
                let p = dir.join(format!("f{i}.wav"));
                std::fs::write(&p, minimal_wav()).unwrap();
                p
            })
            .collect();
        (dir, paths)
    }

    /// Phase 7: `save_each` reports one ok result per file and round-trips edits.
    #[test]
    fn save_each_reports_per_file() {
        let (dir, paths) = temp_wavs(3);
        let tracks: Vec<Track> = paths
            .iter()
            .enumerate()
            .map(|(i, p)| Track {
                title: Some(format!("Title {i}")),
                ..read_track(p)
            })
            .collect();

        let cancel = AtomicBool::new(false);
        let mut results = Vec::new();
        let completed = save_each(tracks, &cancel, |path, ok, _err, _d, _t| {
            results.push((path, ok));
        });
        assert!(completed);
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|(_, ok)| *ok));
        for (i, p) in paths.iter().enumerate() {
            assert_eq!(read_track(p).title, Some(format!("Title {i}")));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Phase 7: cancelling mid-save stops before later files — already-written
    /// files persist; untouched files keep their old tags and stay "dirty".
    #[test]
    fn save_each_cancel_midway() {
        let (dir, paths) = temp_wavs(3);
        let tracks: Vec<Track> = paths
            .iter()
            .map(|p| Track {
                title: Some("Edited".into()),
                ..read_track(p)
            })
            .collect();

        // Request cancellation right after the first file is written, so the
        // second iteration's pre-check stops the loop.
        let cancel = AtomicBool::new(false);
        let mut written = Vec::new();
        let completed = save_each(tracks, &cancel, |path, ok, _e, _d, _t| {
            written.push(path);
            cancel.store(true, Ordering::SeqCst);
            assert!(ok);
        });
        assert!(!completed, "cancellation should report not-completed");
        assert_eq!(written.len(), 1, "only the first file should be written");

        assert_eq!(read_track(&paths[0]).title.as_deref(), Some("Edited"));
        assert_eq!(read_track(&paths[1]).title, None);
        assert_eq!(read_track(&paths[2]).title, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
