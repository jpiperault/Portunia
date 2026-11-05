//! Barre de menus native de macOS. Les éléments personnalisés émettent `menu://<id>` vers la fenêtre
//! `main` ; l'interface (main.ts) les relie aux actions existantes. Le module se compile partout, mais
//! `install` n'est appelé que sous `cfg(target_os = "macos")` (lib.rs) : sous Windows, la barre de
//! menus de l'interface web reste seule.
//!
//! Aucun accélérateur n'est déclaré pour les actions que l'interface gère déjà au clavier (⌘⇧N, ⌘⇧F…) :
//! sinon le menu et le gestionnaire de touches les déclencheraient tous les deux.
//! Tests : src-tauri/tests/appmenu.rs.

use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Identifiants des éléments qui émettent `menu://<id>`.
pub const EVENT_IDS: [&str; 5] = [
    "new-session",
    "quick-connect",
    "settings",
    "close-tab",
    "find",
];
const HELP_ID: &str = "help";
const HELP_URL: &str = "https://github.com/jpiperault/Portunia-releases/releases";

/// Éléments personnalisés du menu et leur accélérateur. Source unique : `build` s'en sert, les tests la vérifient.
/// Pas d'accélérateur pour « Nouvelle session » (⌘⇧N) : géré par le gestionnaire de touches de l'interface.
/// ⌘K : connexion rapide (⌘⇧Q est la déconnexion de macOS). ⌘F : le terminal ne traite pas ⌘ sans Maj.
pub const CUSTOM_ITEMS: [(&str, Option<&str>); 6] = [
    ("settings", Some("Cmd+,")),
    ("new-session", None),
    ("quick-connect", Some("Cmd+K")),
    ("find", Some("Cmd+F")),
    ("close-tab", Some("Cmd+W")),
    (HELP_ID, None),
];

/// Accélérateur déclaré pour un élément personnalisé.
pub fn accelerator_of(id: &str) -> Option<&'static str> {
    CUSTOM_ITEMS
        .iter()
        .find(|(item, _)| *item == id)
        .and_then(|(_, accelerator)| *accelerator)
}

fn custom_item<R: Runtime>(app: &AppHandle<R>, id: &str, text: &str) -> tauri::Result<MenuItem<R>> {
    let builder = MenuItemBuilder::with_id(id, text);
    match accelerator_of(id) {
        Some(accelerator) => builder.accelerator(accelerator).build(app),
        None => builder.build(app),
    }
}

/// Nom de l'événement émis pour un identifiant de menu, `None` s'il n'en émet pas.
pub fn event_name(id: &str) -> Option<String> {
    EVENT_IDS.contains(&id).then(|| format!("menu://{id}"))
}

/// Libellés du menu dans la langue de l'interface (même principe que `t!`).
pub struct Labels {
    pub app: &'static str,
    pub about: &'static str,
    pub settings: &'static str,
    pub hide: &'static str,
    pub hide_others: &'static str,
    pub show_all: &'static str,
    pub quit: &'static str,
    pub session: &'static str,
    pub new_session: &'static str,
    pub quick_connect: &'static str,
    pub edit: &'static str,
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub find: &'static str,
    pub window: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
    pub close_tab: &'static str,
    pub help: &'static str,
    pub release_notes: &'static str,
}

pub fn labels(french: bool) -> Labels {
    let pick = |en: &'static str, fr: &'static str| if french { fr } else { en };
    Labels {
        app: "Portunia",
        about: pick("About Portunia", "À propos de Portunia"),
        settings: pick("Settings…", "Réglages…"),
        hide: pick("Hide Portunia", "Masquer Portunia"),
        hide_others: pick("Hide Others", "Masquer les autres"),
        show_all: pick("Show All", "Tout afficher"),
        quit: pick("Quit Portunia", "Quitter Portunia"),
        session: "Session",
        new_session: pick("New Session…", "Nouvelle session…"),
        quick_connect: pick("Quick Connect…", "Connexion rapide…"),
        edit: pick("Edit", "Édition"),
        undo: pick("Undo", "Annuler"),
        redo: pick("Redo", "Rétablir"),
        cut: pick("Cut", "Couper"),
        copy: pick("Copy", "Copier"),
        paste: pick("Paste", "Coller"),
        select_all: pick("Select All", "Tout sélectionner"),
        find: pick("Find in Terminal…", "Rechercher dans le terminal…"),
        window: pick("Window", "Fenêtre"),
        minimize: pick("Minimize", "Réduire"),
        zoom: "Zoom",
        close_tab: pick("Close Tab", "Fermer l'onglet"),
        help: pick("Help", "Aide"),
        release_notes: pick("Release Notes", "Notes de version"),
    }
}

/// Construit la barre de menus complète.
pub fn build<R: Runtime>(app: &AppHandle<R>, french: bool) -> tauri::Result<Menu<R>> {
    let l = labels(french);

    // Accélérateurs : voir CUSTOM_ITEMS.
    let settings = custom_item(app, "settings", l.settings)?;
    let new_session = custom_item(app, "new-session", l.new_session)?;
    let quick_connect = custom_item(app, "quick-connect", l.quick_connect)?;
    let find = custom_item(app, "find", l.find)?;
    let close_tab = custom_item(app, "close-tab", l.close_tab)?;
    let release_notes = custom_item(app, HELP_ID, l.release_notes)?;

    let app_menu = SubmenuBuilder::new(app, l.app)
        .about_with_text(l.about, None)
        .separator()
        .item(&settings)
        .separator()
        .hide_with_text(l.hide)
        .hide_others_with_text(l.hide_others)
        .show_all_with_text(l.show_all)
        .separator()
        .quit_with_text(l.quit)
        .build()?;
    let session_menu = SubmenuBuilder::new(app, l.session)
        .item(&new_session)
        .item(&quick_connect)
        .build()?;
    // Éléments prédéfinis : indispensables pour que ⌘C/V/X/A/Z fonctionnent dans les champs du WKWebView.
    let edit_menu = SubmenuBuilder::new(app, l.edit)
        .undo_with_text(l.undo)
        .redo_with_text(l.redo)
        .separator()
        .cut_with_text(l.cut)
        .copy_with_text(l.copy)
        .paste_with_text(l.paste)
        .select_all_with_text(l.select_all)
        .separator()
        .item(&find)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, l.window)
        .minimize_with_text(l.minimize)
        .maximize_with_text(l.zoom)
        .separator()
        .item(&close_tab)
        .build()?;
    let help_menu = SubmenuBuilder::new(app, l.help)
        .item(&release_notes)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &session_menu,
            &edit_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

/// Installe le menu et relaie ses clics vers l'interface. Langue : celle déjà connue du cœur.
/// Appelé seulement sous macOS : sans l'attribut, Windows signalerait du code mort.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.set_menu(build(app, crate::lang::is_fr())?)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == HELP_ID {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(HELP_URL, None::<&str>);
        } else if let Some(name) = event_name(id) {
            let _ = app.emit_to("main", &name, ());
        }
    });
    Ok(())
}

/// Reconstruit le menu quand l'interface annonce sa langue (le menu est installé avant que l'interface ne la transmette).
#[tauri::command]
pub fn appmenu_refresh(app: AppHandle, lang: String) -> Result<(), String> {
    // Sous Windows la barre de menus de l'interface web reste seule : rien à reconstruire.
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let french = lang.to_ascii_lowercase().starts_with("fr");
    let menu = build(&app, french).map_err(|e| e.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}
