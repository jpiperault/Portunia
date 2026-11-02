#[macro_use]
mod lang;
mod gate;
mod commands;
mod connector;
mod connectors;
mod containers;
mod credentials;
mod importers;
mod keys;
mod license;
mod localfs;
mod lock;
mod monitor;
mod nettools;
mod notes;
mod recording;
mod registry;
mod secrets;
mod serverstats;
mod store;
mod tls;
mod transfer;
mod vault;

use tauri::Manager;

/// Le logiciel s'appelait Termoria : au premier lancement de Portunia, ses données (sessions,
/// coffre, réglages de l'interface dans EBWebView) sont copiées vers les nouveaux dossiers.
/// L'ancien dossier reste en place, comme copie de secours.
#[cfg(not(debug_assertions))]
fn migrate_from_termoria() {
    fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let target = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_dir(&entry.path(), &target)?;
            } else {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }
    for var in ["APPDATA", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(var).map(std::path::PathBuf::from) else { continue };
        let (old, new) = (base.join("fr.termoria.app"), base.join("fr.portunia.app"));
        if !old.is_dir() || new.exists() {
            continue;
        }
        // Copie dans un dossier temporaire puis renommage : une copie interrompue ne laisse
        // pas un dossier à moitié rempli que Portunia prendrait pour le sien.
        let partial = base.join("fr.portunia.app.migration");
        let _ = std::fs::remove_dir_all(&partial);
        if copy_dir(&old, &partial).is_ok() {
            let _ = std::fs::rename(&partial, &new);
        } else {
            let _ = std::fs::remove_dir_all(&partial);
        }
    }
}

pub fn run() {
    #[cfg(not(debug_assertions))]
    migrate_from_termoria();
    let builder = tauri::Builder::default();
    // Relancer Portunia ramène la fenêtre déjà ouverte au lieu d'en ouvrir une seconde.
    // Versions publiées seulement : une version de développement peut tourner à côté.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            // Développement : dossier de données séparé (PORTUNIA_DATA_DIR) pour ne jamais
            // toucher aux vraies données d'une Portunia installée pendant les essais.
            #[cfg(debug_assertions)]
            let data_dir = std::env::var_os("PORTUNIA_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(data_dir);
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
            lang::set_language,
            commands::list_protocols,
            commands::list_sessions,
            commands::save_session,
            commands::delete_session,
            commands::connect,
            commands::connect_quick,
            gate::gate_list,
            gate::gate_probe,
            gate::gate_login,
            gate::gate_logout,
            gate::gate_remove,
            gate::gate_servers,
            gate::gate_admin,
            gate::gate_journal_csv,
            gate::gate_export,
            gate::gate_rdp_replay,
            gate::gate_assist,
            gate::gate_assist_status,
            gate::gate_rdp_replay_seek,
            gate::gate_rdp_replay_close,
            gate::gate_connect,
            gate::qr_svg,
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
            localfs::local_home,
            localfs::local_list,
            localfs::local_mkdir,
            localfs::local_rename,
            localfs::local_reveal,
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
            commands::ssh_keys_list,
            commands::ssh_key_default_comment,
            commands::ssh_key_generate,
            commands::ssh_key_install,
            commands::note_get,
            commands::note_set,
            commands::notes_list,
            commands::net_cancel,
            commands::net_resolve,
            commands::net_ping,
            commands::net_traceroute,
            commands::net_ports,
            commands::net_wake,
            commands::credentials_list,
            commands::credential_save,
            commands::credential_delete,
            commands::server_stats,
            commands::multi_exec,
            commands::containers_list,
            commands::container_action,
            commands::container_command,
            commands::connect_with,
            commands::confirm_answer,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de Portunia");
}
