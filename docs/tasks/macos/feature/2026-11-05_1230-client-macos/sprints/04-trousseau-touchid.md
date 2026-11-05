# Sprint 4: Trousseau et Touch ID

## Meta

- **PRD:** `../spec.md`
- **Sprint:** 4 of 5
- **Depends on:** Sprint 1, Sprint 3
- **Batch:** 3 (sequential)
- **Model:** sonnet
- **Estimated effort:** M
- **Zone sensible :** toute incertitude → **STOP et demander à l'utilisateur**

## Objective

Stocker les secrets dans le Trousseau macOS et déverrouiller le coffre par Touch ID, avec le même modèle de menace que Windows Hello + DPAPI. Aucun repli silencieux.

## File Boundaries

### Creates (new files)

- `src-tauri/src/biometric_mac.rs` : Touch ID (LAContext) et enveloppe de la clé du coffre dans le Trousseau, sous `cfg(target_os = "macos")`

### Modifies (can touch)

- `src-tauri/Cargo.toml` : sous `[target.'cfg(target_os = "macos")'.dependencies]`, ajouter `security-framework` (Trousseau) et `objc2-local-authentication` + `objc2` + `block2` (LAContext). Dépendances **approuvées** par l'utilisateur. Prendre les versions stables actuelles. Aucune autre dépendance
- `src-tauri/src/lock.rs` : généraliser `hello` → `biometric` (Hello sous Windows, Touch ID sous macOS). Ajouter le champ `biometric` facultatif dans `lock.json`
- `src-tauri/src/vault.rs` : enveloppe de la clé, avec DPAPI sous Windows (inchangé) et le Trousseau sous macOS
- `src-tauri/src/secrets.rs` : rien à changer en principe (keyring en `apple-native` depuis le S1). Vérifier le service `"Termoria"` et la clé `{session_id}/{key}`, et ajouter un test
- `src-tauri/src/commands.rs` : commande `biometric_kind`, et garder `hello_*` comme alias. Le handle de fenêtre (`:928-931`) n'est utile que sous Windows
- `src-tauri/src/lib.rs` : `mod biometric_mac;` (cfg), enregistrement de `biometric_kind`
- `src/security.ts` : interface Touch ID sur Mac (`:101,116,153`), libellés selon `biometric_kind`
- `src/importexport.ts` : « Trousseau macOS » à la place de « Gestionnaire d'identification Windows » (`:63`)

### Read-Only (reference but do NOT modify)

- `src/platform.ts` (S3) : `IS_MAC`
- `src-tauri/src/platform.rs` (S1)

### Shared Contracts

- `biometric_kind() -> Option<&'static str>` : `"hello"` | `"touchid"` | `None` (pas de capteur ou pas configuré)
- `lock.json` : `biometric?: "hello" | "touchid"`. Absent = comportement actuel (Hello si la clé DPAPI est présente)
- Trousseau, enveloppe de la clé : service `"fr.portunia.app.vaultkey"`, compte `"vault"`. Ne pas réutiliser le service `"Termoria"`, qui reste réservé aux secrets des sessions

### Consumed Invariants

- Pas de secret en log (verify : voir INVARIANTS.md)
- Pas de dépendance Windows inconditionnelle

## Tasks

- [ ] **Touch ID** : `LAContext::canEvaluatePolicy(DeviceOwnerAuthenticationWithBiometrics)` → `biometric_kind`. `evaluatePolicy` est appelé avec un texte localisé (« Déverrouiller le coffre Portunia »). La réponse asynchrone est convertie en `Result<(), BiometricError>` via un canal. **Le seul chemin qui renvoie la clé est `Ok(())`** : annulation, échec, verrouillage ou erreur inconnue donnent `Err`
- [ ] **Activation** : quand l'utilisateur active Touch ID (coffre déjà ouvert par mot de passe), on écrit la clé dérivée dans le Trousseau (`set_generic_password`, accessible seulement quand l'appareil est déverrouillé si `security-framework` le permet sans Team ID, sinon on le documente), puis on met `biometric: "touchid"` dans `lock.json`
- [ ] **Déverrouillage** : `evaluatePolicy`, puis en cas de `Ok` lecture de la clé dans le Trousseau, puis ouverture du coffre. En cas de `Err`, on revient à l'écran mot de passe avec un message traduit
- [ ] **Désactivation, changement de mot de passe, réinitialisation du coffre** : supprimer l'élément du Trousseau et remettre `biometric` à null. Le changement de mot de passe réécrit l'enveloppe si Touch ID reste actif, comme pour Hello aujourd'hui
- [ ] Windows : comportement Hello + DPAPI **strictement inchangé**. Les tests `cfg(windows)` existants (`lock.rs:430`, `vault.rs:274`) restent verts
- [ ] La clé ne transite qu'en `Zeroizing<Vec<u8>>` (ou l'équivalent déjà utilisé dans `vault.rs`), jamais dans un `format!`, `log`, `println!` ni dans un message d'erreur
- [ ] Tests unitaires : machine d'états biométrique avec un faux `Authenticator` (trait), vérifiant que tout `Err` ne renvoie jamais de clé, que la désactivation supprime l'élément et que `lock.json` sans champ `biometric` se lit comme avant
- [ ] Interface `security.ts` : « Touch ID » et icône empreinte sur Mac, « Windows Hello » sous Windows, option masquée si `biometric_kind` vaut null
- [ ] Note dans les Agent Notes : avec une signature ad-hoc, macOS peut redemander l'accès au Trousseau après une mise à jour (ACL liée au hash de la signature). Comportement attendu et documenté, il sera résolu avec le Developer ID

## Acceptance Criteria

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passe en local sur le Mac, y compris les tests de la machine d'états avec le faux authentificateur
- [ ] La commande de l'invariant « Pas de secret en log » renvoie 0
- [ ] `npm run build` passe
- [ ] Les tâches `macos` et `windows` de la CI sont vertes (ou BLOCKED si la CI est indisponible)
- [ ] Revue `security-reviewer` sans constat CRITICAL ni HIGH

## Verification

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `npm run build`
- [ ] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- Aujourd'hui (`lock.rs:315-348`, `vault.rs:160-200`), la clé du coffre est dérivée du mot de passe (PBKDF2 600k), puis enveloppée par DPAPI quand Hello est activé. Au déverrouillage, Windows Hello vérifie l'utilisateur, puis DPAPI rend la clé.
- Modèle Mac retenu (même niveau) : la clé est rangée dans le Trousseau de session, protégée par l'ACL de l'application, et LAContext vérifie la présence de l'utilisateur. La liaison biométrique forte (`SecAccessControl` + `kSecUseDataProtectionKeychain`) demande un entitlement `keychain-access-groups`, donc un Team ID Apple. **Hors périmètre**, à prévoir quand le compte Apple existera.
- Secrets de session : `secrets.rs`, keyring `apple-native` (S1), service `"Termoria"`, clé `{session_id}/{key}`.
- **Zone STOP** : toute ambiguïté sur la crypto, le cycle de vie de la clé ou l'API LAContext → demander avant d'implémenter.

## Agent Notes (filled during execution)

- Assigned to:
- Started:
- Completed:
- Decisions made:
- Assumptions:
- Issues found:
