//! Helpers multiplateformes : système courant et dossier personnel.

use std::ffi::OsString;
use std::path::PathBuf;

pub const OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

#[cfg(windows)]
const HOME_VAR: &str = "USERPROFILE";
#[cfg(not(windows))]
const HOME_VAR: &str = "HOME";

/// Dossier personnel : USERPROFILE sous Windows, HOME ailleurs. `None` si absent ou vide.
pub fn home_dir() -> Option<PathBuf> {
    home_from(std::env::var_os(HOME_VAR))
}

fn home_from(value: Option<OsString>) -> Option<PathBuf> {
    value.filter(|v| !v.is_empty()).map(PathBuf::from)
}

#[tauri::command]
pub fn platform_os() -> &'static str {
    OS
}

#[cfg(test)]
mod tests {
    use super::*;

    // On teste la logique pure : modifier HOME rendrait instables les autres tests qui le lisent en parallèle.

    #[test]
    fn os_is_known_value() {
        assert!(["windows", "macos", "linux"].contains(&OS));
        assert_eq!(platform_os(), OS);
    }

    #[test]
    fn home_from_reads_value() {
        assert_eq!(home_from(Some("/tmp/portunia-home".into())), Some(PathBuf::from("/tmp/portunia-home")));
    }

    #[test]
    fn home_from_none_when_empty() {
        assert_eq!(home_from(Some(OsString::new())), None);
    }

    #[test]
    fn home_from_none_when_unset() {
        assert_eq!(home_from(None), None);
    }

    #[test]
    fn home_dir_matches_environment() {
        assert_eq!(home_dir(), home_from(std::env::var_os(HOME_VAR)));
    }
}
