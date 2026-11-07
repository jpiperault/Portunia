// Logo de Portunia et informations de version dans portunia-assistance.exe (barre de titre,
// barre des tâches, Explorateur). L'icône a l'identifiant 1, chargé par ui.rs.
fn main() {
    println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../src-tauri/icons/icon.ico");
        res.set("ProductName", "Portunia Assistance");
        res.set("FileDescription", "Portunia Assistance");
        res.set("CompanyName", "Portunia");
        res.compile().expect("ressources Windows (icône)");
    }
}
