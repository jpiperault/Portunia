mod commands;
mod connector;
mod connectors;
mod importers;
mod license;
mod lock;
mod monitor;
mod recording;
mod registry;
mod secrets;
mod store;
mod transfer;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // Relancer Termoria ramène la fenêtre déjà ouverte au lieu d'en ouvrir une seconde.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = store::Store::load(data_dir.join("sessions.json"));
            app.manage(commands::AppState::new(
                registry::Registry::with_builtins(),
                store,
                data_dir,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_protocols,
            commands::list_sessions,
            commands::save_session,
            commands::delete_session,
            commands::connect,
            commands::connect_quick,
            commands::term_write,
            commands::term_resize,
            commands::disconnect,
            commands::fs_home,
            commands::fs_list,
            commands::fs_download,
            commands::fs_upload,
            commands::fs_mkdir,
            commands::fs_remove,
            commands::fs_rename,
            commands::list_folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::move_sessions,
            commands::duplicate_session,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::tunnel_list,
            commands::tunnel_start,
            commands::tunnel_stop,
            commands::import_default_path,
            commands::import_preview,
            commands::import_apply,
            commands::export_backup,
            commands::import_backup,
            commands::field_suggestions,
            commands::screen_input,
            commands::license_status,
            commands::license_activate,
            commands::license_remove,
            commands::lock_status,
            commands::lock_set_password,
            commands::lock_disable,
            commands::lock_set_options,
            commands::lock_now,
            commands::unlock,
            commands::unlock_hello,
            commands::recording_default_dir,
            commands::recording_start,
            commands::recording_stop,
            commands::recordings_list,
            commands::recording_read,
            commands::recording_delete,
            commands::monitor_check,
            commands::monitor_alerts_allowed,
            commands::folder_colors,
            commands::set_folder_color,
            commands::fs_download_dir,
            commands::fs_upload_any,
            commands::fs_edit_start,
            commands::fs_edit_stop,
            commands::shells_detect,
            commands::connect_local,
            commands::open_shell_elevated,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de Termoria");
}
