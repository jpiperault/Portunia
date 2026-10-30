//! Langue des messages du cœur : celle de l'interface, transmise au démarrage
//! (commande `set_language`). Anglais par défaut. Chaque texte est écrit dans les
//! deux langues côte à côte : `t!("English", "Français")`.

use std::sync::atomic::{AtomicBool, Ordering};

static FRENCH: AtomicBool = AtomicBool::new(false);

pub fn is_fr() -> bool {
    FRENCH.load(Ordering::Relaxed)
}

/// Code envoyé aux bastions Heimdia (en-tête Accept-Language).
pub fn code() -> &'static str {
    if is_fr() {
        "fr"
    } else {
        "en"
    }
}

#[tauri::command]
pub fn set_language(lang: String) {
    FRENCH.store(lang.to_ascii_lowercase().starts_with("fr"), Ordering::Relaxed);
}

/// `t!("English", "Français")` : le texte dans la langue de l'interface (seul l'argument
/// choisi est évalué, `format!` marche donc dans les deux).
#[macro_export]
macro_rules! t {
    ($en:expr, $fr:expr $(,)?) => {
        if $crate::lang::is_fr() { $fr } else { $en }
    };
}
