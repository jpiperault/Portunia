//! Détection des shells Unix (macOS, Linux) : `$SHELL`, `/etc/shells` et les shells Homebrew.
//! La logique est en fonctions pures (texte et prédicats en entrée) pour être testée sans toucher
//! à l'environnement du processus.

use std::path::{Path, PathBuf};

/// Dossiers préférés, par ordre : Homebrew (Apple Silicon), Homebrew (Intel), puis le système.
const PREFERRED_DIRS: [&str; 4] = ["/opt/homebrew/bin", "/usr/local/bin", "/bin", "/usr/bin"];

/// Shells ajoutés s'ils existent, même absents de `/etc/shells` (Homebrew ne les y inscrit pas).
const COMMON_SHELLS: [&str; 3] = ["zsh", "bash", "fish"];

/// Chemins absolus de `/etc/shells` : commentaires, lignes vides et chemins relatifs ignorés.
pub fn parse_etc_shells(text: &str) -> Vec<PathBuf> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| l.starts_with('/'))
        .map(PathBuf::from)
        .collect()
}

fn dir_rank(path: &Path) -> usize {
    let dir = path.parent().and_then(Path::to_str).unwrap_or("");
    PREFERRED_DIRS
        .iter()
        .position(|d| *d == dir)
        .unwrap_or(PREFERRED_DIRS.len())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Un seul chemin par nom de fichier : celui de `exact` s'il est présent, sinon le mieux classé
/// (Homebrew d'abord). L'ordre de première apparition des noms est conservé.
pub fn dedupe_by_name(paths: Vec<PathBuf>, exact: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for path in paths {
        let name = file_name(&path);
        match out.iter().position(|p| file_name(p) == name) {
            None => out.push(path),
            Some(i) => {
                let current = &out[i];
                let is_exact = |p: &Path| exact == Some(p);
                let better =
                    !is_exact(current) && (is_exact(&path) || dir_rank(&path) < dir_rank(current));
                if better {
                    out[i] = path;
                }
            }
        }
    }
    out
}

/// Shell par défaut : `$SHELL` s'il est un chemin absolu inscrit dans `/etc/shells` (commentaires
/// ignorés) et utilisable ; sinon `/bin/zsh` s'il existe, puis `/bin/sh`. Une variable
/// d'environnement détournée ne peut donc pas faire lancer un programme quelconque.
///
/// Un `$SHELL` absent de `/etc/shells` (par exemple un shell Homebrew non inscrit) est ignoré
/// volontairement : l'utilisateur peut l'ajouter à `/etc/shells` pour qu'il redevienne le défaut.
/// Il reste proposé dans la liste s'il fait partie des shells courants (`select_shells`).
pub fn default_shell(
    shell_env: Option<&str>,
    etc_shells: &str,
    usable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let listed = parse_etc_shells(etc_shells);
    shell_env
        .map(str::trim)
        .filter(|s| s.starts_with('/'))
        .map(PathBuf::from)
        .filter(|p| listed.contains(p) && usable(p))
        .or_else(|| {
            ["/bin/zsh", "/bin/sh"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| usable(p))
        })
}

/// Shells à proposer : `$SHELL` en premier (c'est le shell par défaut), puis `/etc/shells` et les
/// shells courants de Homebrew. `usable` dit si un chemin existe et est exécutable.
pub fn select_shells(
    shell_env: Option<&str>,
    etc_shells: &str,
    usable: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let default = default_shell(shell_env, etc_shells, &usable);
    let mut candidates: Vec<PathBuf> = default.iter().cloned().collect();
    candidates.extend(parse_etc_shells(etc_shells));
    for dir in PREFERRED_DIRS {
        candidates.extend(COMMON_SHELLS.iter().map(|name| Path::new(dir).join(name)));
    }
    let candidates = candidates.into_iter().filter(|p| usable(p)).collect();
    dedupe_by_name(candidates, default.as_deref())
}

/// Arguments pour lancer le shell en shell de connexion. Seuls zsh, bash et fish acceptent `-l` ;
/// pour un autre shell on n'invente pas d'option (il démarre en shell interactif simple).
pub fn login_args(shell: &Path) -> Vec<String> {
    match file_name(shell).as_str() {
        "zsh" | "bash" | "fish" => vec!["-l".into()],
        _ => Vec::new(),
    }
}

/// Variables d'environnement imposées au PTY. `LANG` est hérité, sinon UTF-8 par défaut
/// (sans lui zsh affiche mal les accents).
pub fn pty_env(lang: Option<String>) -> Vec<(&'static str, String)> {
    let lang = lang
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| "en_US.UTF-8".into());
    vec![
        ("TERM", "xterm-256color".into()),
        ("COLORTERM", "truecolor".into()),
        ("LANG", lang),
    ]
}

/// Existe, est un fichier et porte un bit d'exécution.
pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Lit l'environnement réel et `/etc/shells`.
pub fn detect_paths() -> Vec<PathBuf> {
    let etc = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    select_shells(std::env::var("SHELL").ok().as_deref(), &etc, is_executable)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ETC: &str =
        "# List of acceptable shells\n\n/bin/bash\n  /bin/zsh  \n/bin/sh # le shell POSIX\nrelatif/sh\n/bin/bash\n";

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn parse_ignore_commentaires_vides_et_relatifs() {
        assert_eq!(
            parse_etc_shells(ETC),
            paths(&["/bin/bash", "/bin/zsh", "/bin/sh", "/bin/bash"])
        );
        assert!(parse_etc_shells("# rien\n\n   \n").is_empty());
    }

    #[test]
    fn dedoublonne_en_preferant_homebrew() {
        let list = paths(&[
            "/bin/zsh",
            "/usr/local/bin/zsh",
            "/opt/homebrew/bin/zsh",
            "/bin/bash",
        ]);
        assert_eq!(
            dedupe_by_name(list, None),
            paths(&["/opt/homebrew/bin/zsh", "/bin/bash"])
        );
        let usr = paths(&["/usr/bin/fish", "/usr/local/bin/fish", "/bin/fish"]);
        assert_eq!(dedupe_by_name(usr, None), paths(&["/usr/local/bin/fish"]));
    }

    #[test]
    fn le_chemin_de_shell_est_conserve() {
        let list = paths(&["/bin/zsh", "/opt/homebrew/bin/zsh"]);
        assert_eq!(
            dedupe_by_name(list, Some(Path::new("/bin/zsh"))),
            paths(&["/bin/zsh"])
        );
    }

    #[test]
    fn shell_par_defaut_en_premier_et_inexistants_ignores() {
        let existing = ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"];
        let usable = |p: &Path| existing.contains(&p.to_str().unwrap());
        let shells = select_shells(
            Some("/bin/zsh"),
            "/bin/bash\n/bin/zsh\n/bin/inexistant\n",
            usable,
        );
        assert_eq!(
            shells,
            paths(&["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"])
        );
    }

    #[test]
    fn shell_env_invalide_est_ignore() {
        let usable = |p: &Path| p == Path::new("/bin/bash");
        assert_eq!(
            select_shells(Some("zsh"), "/bin/bash\n", usable),
            paths(&["/bin/bash"])
        );
        assert_eq!(select_shells(None, "", usable), paths(&["/bin/bash"]));
    }

    #[test]
    fn shell_liste_dans_etc_shells_accepte() {
        let usable = |_: &Path| true;
        let etc = "/bin/zsh\n/opt/homebrew/bin/fish\n";
        assert_eq!(
            default_shell(Some("/opt/homebrew/bin/fish"), etc, usable),
            Some(PathBuf::from("/opt/homebrew/bin/fish"))
        );
    }

    #[test]
    fn shell_non_liste_refuse_repli_sur_zsh_puis_sh() {
        let etc = "/bin/bash\n/bin/zsh\n";
        let all = |_: &Path| true;
        assert_eq!(
            default_shell(Some("/tmp/evil-shell"), etc, all),
            Some(PathBuf::from("/bin/zsh"))
        );
        let sh_only = |p: &Path| p == Path::new("/bin/sh");
        assert_eq!(
            default_shell(Some("/tmp/evil-shell"), etc, sh_only),
            Some(PathBuf::from("/bin/sh"))
        );
        let nothing = |_: &Path| false;
        assert_eq!(default_shell(Some("/tmp/evil-shell"), etc, nothing), None);
    }

    #[test]
    fn commentaires_de_etc_shells_ignores_pour_le_controle() {
        let etc = "# /tmp/evil-shell\n/bin/zsh # /tmp/autre\n";
        let usable = |_: &Path| true;
        assert_eq!(
            default_shell(Some("/tmp/evil-shell"), etc, usable),
            Some(PathBuf::from("/bin/zsh")),
            "un shell seulement cité en commentaire n'est pas listé"
        );
        assert_eq!(
            default_shell(Some("/tmp/autre"), etc, usable),
            Some(PathBuf::from("/bin/zsh"))
        );
    }

    #[test]
    fn shell_env_absent_ou_relatif_repli() {
        let usable = |_: &Path| true;
        assert_eq!(
            default_shell(None, "/bin/bash\n", usable),
            Some(PathBuf::from("/bin/zsh"))
        );
        assert_eq!(
            default_shell(Some("bash"), "bash\n", usable),
            Some(PathBuf::from("/bin/zsh"))
        );
        assert_eq!(
            default_shell(Some("  "), "", usable),
            Some(PathBuf::from("/bin/zsh"))
        );
    }

    #[test]
    fn shell_non_liste_ne_passe_pas_en_tete_de_select_shells() {
        let existing = ["/tmp/evil-shell", "/bin/zsh", "/bin/bash"];
        let usable = |p: &Path| existing.contains(&p.to_str().unwrap());
        let shells = select_shells(Some("/tmp/evil-shell"), "/bin/bash\n/bin/zsh\n", usable);
        assert_eq!(shells, paths(&["/bin/zsh", "/bin/bash"]));
    }

    #[test]
    fn arguments_de_connexion() {
        assert_eq!(login_args(Path::new("/bin/zsh")), ["-l"]);
        assert_eq!(login_args(Path::new("/opt/homebrew/bin/fish")), ["-l"]);
        assert!(login_args(Path::new("/bin/sh")).is_empty());
    }

    #[test]
    fn environnement_du_pty() {
        let env = pty_env(None);
        assert!(env.contains(&("TERM", "xterm-256color".into())));
        assert!(env.contains(&("COLORTERM", "truecolor".into())));
        assert!(env.contains(&("LANG", "en_US.UTF-8".into())));
        assert!(pty_env(Some("fr_FR.UTF-8".into())).contains(&("LANG", "fr_FR.UTF-8".into())));
        assert!(pty_env(Some("  ".into())).contains(&("LANG", "en_US.UTF-8".into())));
    }
}
