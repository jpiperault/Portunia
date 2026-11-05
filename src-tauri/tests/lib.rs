//! Contrat de câblage de src/lib.rs : `run()` ouvre une fenêtre et ne se teste pas sans interface ;
//! on vérifie donc dans le source que le menu natif n'est installé que sous macOS.

const LIB: &str = include_str!("../src/lib.rs");

#[test]
fn native_menu_is_installed_on_macos_only() {
    let install = LIB
        .find("appmenu::install(")
        .expect("le menu natif doit être installé dans setup");
    let guard = LIB[..install]
        .rfind("#[cfg(target_os = \"macos\")]")
        .expect("garde cfg(macos) absente");
    // La garde doit précéder immédiatement l'appel (seulement des espaces et un retour à la ligne entre les deux).
    let between = &LIB[guard + "#[cfg(target_os = \"macos\")]".len()..install];
    assert!(
        between.trim().is_empty(),
        "la garde macOS ne protège pas l'appel : {between:?}"
    );
}

#[test]
fn appmenu_module_and_refresh_command_are_registered() {
    assert!(LIB.contains("mod appmenu;"));
    assert!(LIB.contains("appmenu::appmenu_refresh,"));
    // Le module de langue reste déclaré avant, appmenu s'en sert via crate::lang.
    assert!(LIB.find("mod lang;").unwrap() < LIB.find("mod appmenu;").unwrap());
}
