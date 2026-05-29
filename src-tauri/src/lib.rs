mod session;
// `pub` so the criterion benches (a separate crate) can reach `read_track`,
// `write_track`, and `scan_paths`. Not part of a stable public API.
pub mod tags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(tags::OpRegistry::default())
        .invoke_handler(tauri::generate_handler![
            tags::scan_paths,
            tags::scan_paths_streamed,
            tags::cancel_operation,
            tags::save_tracks,
            tags::get_cover_art,
            tags::read_all_tags,
            tags::save_all_tags,
            session::load_session,
            session::save_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
