# Sprint 1: Compilation macOS + CI de build

## Meta

- **PRD:** `../spec.md`
- **Sprint:** 1 of 5
- **Depends on:** None
- **Batch:** 1 (sequential)
- **Model:** sonnet
- **Estimated effort:** M

## Objective

Faire compiler Portunia (src-tauri + rdp-helper + frontend) sur macOS sans rien changer au comportement Windows, et poser une CI qui le prouve à chaque push : macOS, Windows et Linux.

## File Boundaries

### Creates (new files)

- `src-tauri/src/platform.rs` : helpers multiplateformes (contrat ci-dessous)
- `src-tauri/tauri.macos.conf.json` : config fusionnée par Tauri sur Mac uniquement
- `.github/workflows/macos-build.yml` : CI de vérification, sans publication

### Modifies (can touch)

- `src-tauri/Cargo.toml` : déplacer `winreg` sous `[target.'cfg(windows)'.dependencies]`, et pour `keyring` déclarer les features par plateforme (`windows-native` sous Windows, `apple-native` sous macOS, `linux-native` ou `sync-secret-service` sous Linux, uniquement si nécessaire pour que `cargo check` passe en local sur le Mac)
- `src-tauri/src/lib.rs` : `mod platform;` et enregistrement de la commande `platform_os`. Ne pas toucher à la migration Termoria, elle ne fait déjà rien hors Windows
- `src-tauri/src/importers.rs` : `home()` → `platform::home_dir()`. Le chemin mRemoteNG par défaut doit rester valide hors Windows (`None` ou un chemin sous `HOME`)
- `src-tauri/src/connectors/local.rs` : uniquement `home()` → `platform::home_dir()`. La détection des shells se fait au S2
- `rdp-helper/src/main.rs` : `C:\Windows\System32\mstscax.dll` (ligne ~195) seulement sous `cfg(windows)`, valeur neutre ailleurs
- `src-tauri/src/lock.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/nettools.rs`, `src-tauri/src/localfs.rs`, `src-tauri/src/connectors/rdp.rs`, `src-tauri/src/commands.rs` : **uniquement** pour corriger une erreur de compilation macOS (gate `cfg`, stub). **Dans `lock.rs` et `vault.rs` (zone sensible) : seulement des gates `cfg` ou des stubs d'erreur, sans changer aucune logique existante. Si autre chose semble nécessaire → STOP et demander.** Si un autre fichier Rust doit être touché pour compiler, le noter dans les Agent Notes (hors liste = à signaler)

### Read-Only (reference but do NOT modify)

- `src-tauri/tauri.conf.json` : **ne pas modifier** (invariant « Config Windows intacte »)
- `.github/workflows/release.yml` : **ne pas modifier** (S5)
- `scripts/build-rdp.mjs` : comprendre comment `portunia-rdp-<triple>` est produit

### Shared Contracts

```rust
// src-tauri/src/platform.rs
pub const OS: &str = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
pub fn home_dir() -> Option<std::path::PathBuf>; // USERPROFILE sous Windows, HOME ailleurs ; None si absent ou vide
#[tauri::command] pub fn platform_os() -> &'static str; // renvoie OS
```

### Consumed Invariants

- Config Windows intacte : `grep -q '"nsis"' src-tauri/tauri.conf.json && ! grep -q '"macOS"' src-tauri/tauri.conf.json`
- Pas de dépendance Windows inconditionnelle (voir INVARIANTS.md)

## Tasks

- [ ] Créer `platform.rs` et ses tests unitaires (`home_dir` avec `HOME`/`USERPROFILE` définis ou vides, `OS` non vide)
- [ ] Cargo : `winreg` sous `cfg(windows)`, features `keyring` par plateforme. Vérifier que `Cargo.lock` reste cohérent (`cargo check` le met à jour)
- [ ] `tauri.macos.conf.json` : `bundle.targets: ["app","dmg"]`, `bundle.resources: []` (pas de conpty), `bundle.macOS.minimumSystemVersion: "11.0"`, `bundle.macOS.signingIdentity: "-"`. Ne mettre ni icône ni entitlements (S5)
- [ ] Corriger toutes les erreurs `cargo check` sur macOS avec des gates `cfg` et des stubs : chaque stub renvoie une erreur explicite, traduite via la macro `t!` existante, jamais un succès silencieux. **Exception** : pas de stub pour les fonctions qui seront réalisées au S2 ou au S4 si elles ont déjà un stub
- [ ] Remplacer les usages de `USERPROFILE` par `platform::home_dir()` dans `importers.rs` et `connectors/local.rs`
- [ ] `macos-build.yml` : déclencheurs `push` sur `feat/macos-**` et `main`, plus `workflow_dispatch`. Trois tâches :
  - `macos` (`macos-latest`) : `npm ci`, `node scripts/build-rdp.mjs`, `cargo test` pour src-tauri et rdp-helper, `npm run build`, `npm run tauri build -- --no-bundle`
  - `windows` (`windows-latest`) : `npm ci`, `cargo test` (les deux crates), `npm run build`
  - Cache Rust avec `Swatinem/rust-cache` comme `release.yml` (reprendre le même SHA épinglé). **Aucun secret utilisé.**

## Acceptance Criteria

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` passe en local sur le Mac
- [ ] `cargo test` des deux crates passe en local sur le Mac
- [ ] `npm run build` passe
- [ ] Le workflow est syntaxiquement valide (`npx --yes @action-validator/cli .github/workflows/macos-build.yml` si disponible, sinon passer le YAML dans `python3 -c 'import yaml,sys;yaml.safe_load(open(sys.argv[1]))'`)
- [ ] Les tâches `macos` et `windows` de la CI sont vertes. **Si la CI est indisponible : marquer BLOCKED, jamais PASS**
- [ ] Les invariants « Config Windows intacte » et « Pas de dépendance Windows inconditionnelle » passent

## Verification

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `cargo test --manifest-path rdp-helper/Cargo.toml`
- [ ] `npm run build`
- [ ] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- Environnement : Mac Apple Silicon. `cargo check`, `cargo test` et `npm run tauri dev` tournent en local. Ajouter les deux cibles avec `rustup target add aarch64-apple-darwin x86_64-apple-darwin`. Pas de Windows en local : la régression Windows n'est vérifiée que par la tâche CI `windows` (pousser la branche `feat/macos-s1`).
- `app_data_dir()` (lib.rs:87) donne déjà `~/Library/Application Support/fr.portunia.app` sur Mac : ne rien changer.
- Stubs existants à garder tels quels : Hello (`lock.rs:315-348`), DPAPI (`vault.rs:160-200`), ICMP (`nettools.rs:122`), PuTTY (`importers.rs:323`), attribut caché (`localfs.rs:74-81`), presse-papiers RDP (`rdp-helper/src/main.rs:513-531`).
- `tauri.macos.conf.json` est fusionné (JSON Merge Patch) par-dessus `tauri.conf.json` quand on compile sur macOS. C'est ce qui garantit que la config Windows ne bouge pas.
- Ne pas modifier `release.yml` : publier pour Mac est l'objet du S5.

## Agent Notes (filled during execution)

- Assigned to:
- Started:
- Completed:
- Decisions made:
- Assumptions:
- Issues found:
