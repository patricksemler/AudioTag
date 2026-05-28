//! Lightweight session persistence.
//!
//! Remembers the file/folder paths the user last opened so the app can
//! restore them on the next launch. Stored as a small JSON file in the
//! platform app-config directory; failures are non-fatal (we just start empty).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Session {
    /// Source paths (files or folders) the user opened, in order.
    paths: Vec<String>,
}

fn session_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

/// Return the previously persisted source paths, or an empty list if none /
/// the file is missing or unreadable.
#[tauri::command]
pub fn load_session(app: tauri::AppHandle) -> Vec<String> {
    let Ok(path) = session_file(&app) else {
        return Vec::new();
    };
    let Ok(data) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Session>(&data)
        .map(|s| s.paths)
        .unwrap_or_default()
}

/// Persist the given source paths for restoration on the next launch.
#[tauri::command]
pub fn save_session(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    let path = session_file(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&Session { paths }).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}
