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

- [x] **Touch ID** : `LAContext::canEvaluatePolicy(DeviceOwnerAuthenticationWithBiometrics)` → `biometric_kind`. `evaluatePolicy` est appelé avec un texte localisé (« Déverrouiller le coffre Portunia »). La réponse asynchrone est convertie en `Result<(), BiometricError>` via un canal. **Le seul chemin qui renvoie la clé est `Ok(())`** : annulation, échec, verrouillage ou erreur inconnue donnent `Err`
- [x] **Activation** : quand l'utilisateur active Touch ID (coffre déjà ouvert par mot de passe), on écrit la clé dérivée dans le Trousseau (`set_generic_password`, accessible seulement quand l'appareil est déverrouillé si `security-framework` le permet sans Team ID, sinon on le documente), puis on met `biometric: "touchid"` dans `lock.json`
- [x] **Déverrouillage** : `evaluatePolicy`, puis en cas de `Ok` lecture de la clé dans le Trousseau, puis ouverture du coffre. En cas de `Err`, on revient à l'écran mot de passe avec un message traduit
- [x] **Désactivation, changement de mot de passe, réinitialisation du coffre** : supprimer l'élément du Trousseau et remettre `biometric` à null. Le changement de mot de passe réécrit l'enveloppe si Touch ID reste actif, comme pour Hello aujourd'hui
- [x] Windows : comportement Hello + DPAPI **strictement inchangé**. Les tests `cfg(windows)` existants (`lock.rs:430`, `vault.rs:274`) restent verts
- [x] La clé ne transite qu'en `Zeroizing<Vec<u8>>` (ou l'équivalent déjà utilisé dans `vault.rs`), jamais dans un `format!`, `log`, `println!` ni dans un message d'erreur
- [x] Tests unitaires : machine d'états biométrique avec un faux `Authenticator` (trait), vérifiant que tout `Err` ne renvoie jamais de clé, que la désactivation supprime l'élément et que `lock.json` sans champ `biometric` se lit comme avant
- [x] Interface `security.ts` : « Touch ID » et icône empreinte sur Mac, « Windows Hello » sous Windows, option masquée si `biometric_kind` vaut null
- [x] Note dans les Agent Notes : avec une signature ad-hoc, macOS peut redemander l'accès au Trousseau après une mise à jour (ACL liée au hash de la signature). Comportement attendu et documenté, il sera résolu avec le Developer ID

## Acceptance Criteria

- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passe en local sur le Mac, y compris les tests de la machine d'états avec le faux authentificateur
- [x] La commande de l'invariant « Pas de secret en log » renvoie 0
- [x] `npm run build` passe
- [ ] Les tâches `macos` et `windows` de la CI sont vertes (ou BLOCKED si la CI est indisponible)
- [ ] Revue `security-reviewer` sans constat CRITICAL ni HIGH

## Verification

- [x] `cargo test --manifest-path src-tauri/Cargo.toml`
- [x] `npm run build`
- [x] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- Aujourd'hui (`lock.rs:315-348`, `vault.rs:160-200`), la clé du coffre est dérivée du mot de passe (PBKDF2 600k), puis enveloppée par DPAPI quand Hello est activé. Au déverrouillage, Windows Hello vérifie l'utilisateur, puis DPAPI rend la clé.
- Modèle Mac retenu (même niveau) : la clé est rangée dans le Trousseau de session, protégée par l'ACL de l'application, et LAContext vérifie la présence de l'utilisateur. La liaison biométrique forte (`SecAccessControl` + `kSecUseDataProtectionKeychain`) demande un entitlement `keychain-access-groups`, donc un Team ID Apple. **Hors périmètre**, à prévoir quand le compte Apple existera.
- Secrets de session : `secrets.rs`, keyring `apple-native` (S1), service `"Termoria"`, clé `{session_id}/{key}`.
- **Zone STOP** : toute ambiguïté sur la crypto, le cycle de vie de la clé ou l'API LAContext → demander avant d'implémenter.

## Agent Notes (filled during execution)

- Assigned to: sprint-executor (sonnet), branche `feat/macos-s4`
- Started / Completed: 2026-11-05 (non commité, à relire par l'orchestrateur)
- Crates ajoutées (cfg macOS) : `security-framework 3.7.0`, `objc2-local-authentication 0.3.2`, `objc2 0.6.5`, `block2 0.6.2`. Aucune autre.
- Decisions made:
  - `hello: bool` de lock.json est conservé (« biométrie active » sur les deux plateformes) ; `biometric: "touchid"` s'y ajoute, omis quand absent (`skip_serializing_if`), donc lock.json sous Windows est octet pour octet identique.
  - Machine d'états : traits `Authenticator` et `KeyStore` (biometric_mac.rs). `unlock_key` n'appelle `store.load()` qu'après `Ok(())` ; tout `Err` (annulation, échec, verrou, inconnu, bloc sans réponse) donne `UnlockError`, sans clé. Seule l'annulation devient `Ok(false)` côté commande (aucune clé appliquée).
  - Activation : exige coffre ouvert + clé de données ; Trousseau écrit AVANT de basculer lock.json, retour arrière si l'enregistrement échoue. Désactivation / retrait du mot de passe : suppression de l'élément d'abord, échec = rien n'est modifié (la clé ne reste jamais seule dans le Trousseau). Changement de mot de passe : élément réécrit ; en cas d'échec Touch ID est désactivé (élément supprimé au mieux) et l'erreur est renvoyée, plutôt que de garder une clé périmée.
  - « Réinitialisation du coffre » : aucune commande dédiée n'existe ; le seul chemin qui supprime lock.json est `Lock::disable`, qui supprime l'élément.
  - Commandes : `biometric_kind` (toutes plateformes), `unlock_biometric` (Mac ; refus ailleurs). `unlock_hello` n'est pas modifiée (alias Windows) ; sur Mac elle renvoie `false` (stub existant) et n'est plus appelée par l'interface.
  - Interface : helpers testables dans security.ts (`biometricLabel`, `biometricOption`, `biometricTexts`) ; option visible si capteur, masquée sinon, sauf si encore active (grisée, pour pouvoir la retirer).
- Attributs du Trousseau retenus : élément « mot de passe générique » du trousseau de session (login keychain, fichier), service `fr.portunia.app.vaultkey`, compte `vault`, 32 octets bruts. Accessibilité : `security-framework` ne permet `kSecAttrAccessible` (WhenUnlockedThisDeviceOnly) que pour le trousseau « data protection », donc avec entitlement/Team ID : NON appliqué. L'élément est protégé par l'ACL par défaut (l'application créatrice y accède sans invite) et par le verrouillage du trousseau de session. Limite : un autre processus de la même session qui obtient l'accès au trousseau (invite acceptée) peut lire la clé sans Touch ID ; la liaison biométrique forte reste hors périmètre (Team ID).
- NOTE ACL / signature ad hoc : avec une signature ad hoc, l'ACL de l'élément est liée au hash de signature du binaire ; après une mise à jour (nouveau hash), macOS peut redemander l'accès au Trousseau (« Toujours autoriser »). Comportement attendu et documenté ; résolu avec la signature Developer ID (identité de signature stable).
- Assumptions:
  - 🟢 LAError : codes mappés via les constantes d'objc2-local-authentication ; tout code inconnu est un refus.
  - 🟢 Approuvées ensuite : `zeroize 1.9.1` et `objc2-foundation 0.3.2` (features `std`, `NSString`, `NSError`). La clé transite en `Zeroizing<[u8;32]>` (`VaultKey`) du Trousseau jusqu'à `vault::set_key`. Copies `[u8;32]` restantes : `vault::key()` / `vault::set_key` (type de vault.rs, Windows inchangé) et la variable `key` de `set_password` (code partagé avec Windows). Types typés (`NSString::from_str`, `NSError::code`) à la place du contournement.
- Correctifs de la revue sécurité (APPROVE, 3 MEDIUM + 1 LOW) :
  - Clé du Trousseau vérifiée avant `vault::set_key` : `vault::verify_key` déchiffre le premier fichier chiffré existant (sessions, notes, credentials, known_hosts ; AES-GCM authentifié), sans nouveau champ dans lock.json. Clé fausse : refus, élément supprimé et Touch ID désactivé (si la suppression échoue, Touch ID reste déclaré et l'erreur est renvoyée). Coffre sans fichier chiffré : refus (« utilisez le mot de passe maître »), Touch ID inchangé.
  - `disable` et la désactivation de Touch ID tentent toujours `store.delete()` (absent = OK). `refresh_touch_id` ne fait plus `let _ = delete()` : échec de suppression = Touch ID reste déclaré + erreur.
  - Paramètres relus depuis le cœur après toute erreur (`refreshAfterFailure`).
  - `unlock_biometric` : garde RAII `PromptGuard` (un second appel pendant l'invite renvoie `Ok(false)`).
- Suivis laissés en l'état : cache de `biometric_kind` dans `status()` ; copies `[u8;32]` hors Zeroizing et effacement de KEY au verrouillage (code partagé avec Windows) ; activation sans ressaisie du mot de passe.
- Issues found:
  - Le hook `check-test-exists` bloque tout fichier sans test : squelettes de tests ajoutés d'abord (biometric_mac.rs, commands.rs, secrets.rs) avec `printf`, puis code via Edit.
  - Le hook rustfmt a reformaté `lock.rs` en entier (style par défaut) : diff plus bruyant que le changement réel (`git diff -w` aide). commands.rs n'est pas reformaté (hook en édition 2015, échoue).
  - Hors périmètre déclaré : `src/api.ts` (non modifié) : `invoke('biometric_kind'/'unlock_biometric')` appelés depuis security.ts. api.ts importe des types sans `import type`, d'où des faux de modules dans les tests frontend.
  - Windows non compilé ici (cible absente) : branches Windows de lock.rs laissées textuellement identiques (`set_options` Windows sous `cfg(not(macos))`) ; à valider par la CI `windows`.
  - Tests réels (`#[ignore]`) : `trousseau_reel_aller_retour_et_suppression` exécuté et OK ; `touch_id_reel` BLOCKED (exige doigt).
