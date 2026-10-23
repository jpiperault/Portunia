// Pas de console en plus de la fenêtre en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    termoria_lib::run()
}
