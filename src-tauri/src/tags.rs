//! Audio tag reading/writing backend, built on `lofty`.
//!
//! Exposes a small set of Tauri commands the frontend uses to scan folders,
//! read tags into a uniform model, write edits back atomically, and lazily
//! fetch embedded cover art.

use base64::Engine;
use lofty::config::WriteOptions;
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag};
use serde::{Deserialize, Serialize};
use std::path::Path;
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Base64-encoded cover art for display in the tag editor panel.
#[derive(Debug, Clone, Serialize)]
pub struct CoverArt {
    pub mime: String,
    pub base64: String,
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

/// Build a `Track` model from a single file path.
fn read_track(path: &Path) -> Track {
    let tagged = match lofty::read_from_path(path) {
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

fn write_track(t: &Track) -> Result<(), String> {
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

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Scan the given paths (files or folders) and return tag models for every
/// audio file found. Folders are walked recursively. Results are sorted by path.
#[tauri::command]
pub fn scan_paths(paths: Vec<String>) -> Vec<Track> {
    let mut files: Vec<std::path::PathBuf> = Vec::new();

    for p in paths {
        let path = std::path::PathBuf::from(&p);
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
    files.iter().map(|p| read_track(p)).collect()
}

/// Write edits for the given tracks back to disk. Returns a result per file.
#[tauri::command]
pub fn save_tracks(tracks: Vec<Track>) -> Vec<SaveResult> {
    tracks
        .into_iter()
        .map(|t| match write_track(&t) {
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
        })
        .collect()
}

/// Lazily fetch the first embedded cover art for a single file, base64-encoded.
#[tauri::command]
pub fn get_cover_art(path: String) -> Option<CoverArt> {
    let tagged = lofty::read_from_path(&path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let base64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Some(CoverArt { mime, base64 })
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
    fn scan_filters_non_audio() {
        // A .txt file should never be picked up by a scan.
        let mut p = std::env::temp_dir();
        p.push(format!("audiotag_not_audio_{}.txt", std::process::id()));
        std::fs::write(&p, b"not audio").unwrap();
        let results = scan_paths(vec![p.to_string_lossy().into_owned()]);
        assert!(results.is_empty(), "non-audio file should be ignored");
        let _ = std::fs::remove_file(&p);
    }
}
