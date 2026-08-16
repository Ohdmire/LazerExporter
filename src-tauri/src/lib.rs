mod exporter;
mod lazer_realm;
mod platform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(exporter::ExportCancel::default())
        .invoke_handler(tauri::generate_handler![
            platform::detect_lazer,
            platform::set_lazer_data_dir,
            platform::read_cover,
            lazer_realm::list_library,
            exporter::export_sets,
            exporter::export_skins,
            exporter::export_replays,
            exporter::cancel_export,
        ])
        .setup(|_app| {
            platform::init_config();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
