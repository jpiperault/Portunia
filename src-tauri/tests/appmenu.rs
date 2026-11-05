//! Tests de src/appmenu.rs. Le module est inclus tel quel (le crate est un binaire sans API publique) ;
//! `lang` est une doublure minimale de `crate::lang`, dont appmenu n'utilise que `is_fr()`.

#[allow(dead_code)]
mod lang {
    pub fn is_fr() -> bool {
        false
    }
}

#[allow(dead_code)]
#[path = "../src/appmenu.rs"]
mod appmenu;

use appmenu::{accelerator_of, event_name, labels, CUSTOM_ITEMS, EVENT_IDS};

#[test]
fn menu_carries_cmd_k_f_w_and_comma() {
    assert_eq!(accelerator_of("quick-connect"), Some("Cmd+K"));
    assert_eq!(accelerator_of("find"), Some("Cmd+F"));
    assert_eq!(accelerator_of("close-tab"), Some("Cmd+W"));
    assert_eq!(accelerator_of("settings"), Some("Cmd+,"));
    // Gérés par le gestionnaire de touches de l'interface : un accélérateur de menu les déclencherait deux fois.
    assert_eq!(accelerator_of("new-session"), None);
    assert_eq!(accelerator_of("inconnu"), None);
}

#[test]
fn no_accelerator_uses_shift_so_cmd_shift_q_stays_with_macos() {
    for (id, accelerator) in CUSTOM_ITEMS {
        if let Some(a) = accelerator {
            assert!(!a.to_lowercase().contains("shift"), "{id} : {a}");
            assert_ne!(a, "Cmd+Q");
        }
    }
}

#[test]
fn every_event_id_has_a_menu_item() {
    for id in EVENT_IDS {
        assert!(CUSTOM_ITEMS.iter().any(|(item, _)| *item == id), "{id}");
    }
}

#[test]
fn only_known_ids_emit_an_event() {
    for id in [
        "new-session",
        "quick-connect",
        "settings",
        "close-tab",
        "find",
    ] {
        assert_eq!(
            event_name(id).as_deref(),
            Some(format!("menu://{id}").as_str())
        );
    }
    assert_eq!(EVENT_IDS.len(), 5);
    // « help » ouvre une page et les éléments prédéfinis (quit, copy…) sont gérés par le système.
    for id in ["help", "quit", "copy", ""] {
        assert_eq!(event_name(id), None);
    }
}

#[test]
fn labels_follow_the_language() {
    assert_eq!(labels(false).close_tab, "Close Tab");
    assert_eq!(labels(true).close_tab, "Fermer l'onglet");
    assert_eq!(labels(true).edit, "Édition");
    assert_eq!(labels(true).settings, "Réglages…");
    assert_eq!(labels(false).quit, "Quit Portunia");
}

#[test]
fn every_label_is_filled_in_both_languages() {
    for french in [false, true] {
        let l = labels(french);
        let all = [
            l.app,
            l.about,
            l.settings,
            l.hide,
            l.hide_others,
            l.show_all,
            l.quit,
            l.session,
            l.new_session,
            l.quick_connect,
            l.edit,
            l.undo,
            l.redo,
            l.cut,
            l.copy,
            l.paste,
            l.select_all,
            l.find,
            l.window,
            l.minimize,
            l.zoom,
            l.close_tab,
            l.help,
            l.release_notes,
        ];
        assert!(all.iter().all(|s| !s.is_empty()));
    }
}
