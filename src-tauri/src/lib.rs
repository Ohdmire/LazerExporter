mod exporter;
mod maintenance;
mod collection_sync;
mod state;
mod lazer_realm;
mod platform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(exporter::ExportCancel::default())
        .manage(std::sync::Arc::new(state::CachedLibrary::default()))
        .invoke_handler(tauri::generate_handler![
            platform::detect_lazer,
            platform::set_lazer_data_dir,
            platform::read_cover,
            lazer_realm::list_library,
            exporter::export_sets,
            exporter::export_skins,
            exporter::export_replays,
            exporter::cancel_export,
            maintenance::get_lazer_disk_usage,
            maintenance::dedupe_lazer_files,
            maintenance::cancel_dedupe,
            collection_sync::load_collection_page,
            collection_sync::sync_collections,
            collection_sync::export_collection_copy,
            collection_sync::export_selected_sets,
            collection_sync::delete_stable_collections,
            collection_sync::discard_collection_changes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
