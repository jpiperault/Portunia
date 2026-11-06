# Sprint 5: Packaging universel, release, recette

## Meta

- **PRD:** `../spec.md`
- **Sprint:** 5 of 5
- **Depends on:** Sprint 2, Sprint 3, Sprint 4
- **Batch:** 4 (sequential)
- **Model:** sonnet
- **Estimated effort:** M
- **Zone sensible :** `release.yml` et mise à jour automatique → **STOP et demander** en cas de doute. **Aucune release réelle (tag) n'est poussée pendant ce sprint**

## Objective

Produire un `.app` et un `.dmg` universels signés ad-hoc, les publier dans la même release que Windows avec un `latest.json` fusionné et vérifié, et livrer la grille de recette manuelle.

## File Boundaries

### Creates (new files)

- `src-tauri/icons/icon.icns` : générée par `npx tauri icon` à partir de l'icône source existante. Ne garder que le `.icns` : ne pas écraser les png et ico existants
- `src-tauri/Entitlements.plist` : hardened runtime (`com.apple.security.cs.allow-jit` si WKWebView l'exige, `network.client`, `device.serial` si besoin pour le port série). **Pas de sandbox**
- `scripts/check-latest-json.mjs` : contrôle de `latest.json` (plateformes attendues, URL par plateforme)
- `docs/recette-macos.md` : grille de recette manuelle (FR)

### Modifies (can touch)

- `src-tauri/tauri.macos.conf.json` : icônes (`icon.png` + `icon.icns`), `bundle.macOS.entitlements`, `hardenedRuntime: true`, `signingIdentity: "-"`, `createUpdaterArtifacts` hérité
- `scripts/build-rdp.mjs` : cible `universal-apple-darwin`. Avec `--target universal-apple-darwin` (ou la variable `PORTUNIA_RDP_UNIVERSAL=1`), compiler `aarch64-apple-darwin` et `x86_64-apple-darwin`, puis `lipo -create` vers `src-tauri/binaries/portunia-rdp-universal-apple-darwin`. Sans option, comportement actuel inchangé
- `.github/workflows/release.yml` : **ajout** d'une tâche `macos` (`macos-latest`, `needs: windows`). La tâche `windows` reste intacte, au caractère près
- `.github/workflows/macos-build.yml` : passer `tauri build` en `--target universal-apple-darwin` et vérifier `lipo -archs`
- `README.md`, `README.fr.md` : section macOS (installation, Gatekeeper « Ouvrir quand même », éventuelle demande d'accès au Trousseau après une mise à jour, dev sur Mac : Xcode CLT, `rustup target add aarch64-apple-darwin x86_64-apple-darwin`)
- `src/styles.css` et les `src/*.ts` touchés au S3 : **uniquement** les corrections de la passe WebKit, à lister dans les Agent Notes

### Read-Only (reference but do NOT modify)

- `src-tauri/tauri.conf.json` : **ne pas modifier**
- `src-tauri/Cargo.toml` : vérifier les features `tauri-plugin-updater`. **Si une feature manque pour `.app.tar.gz` : STOP et demander**

### Shared Contracts

- `latest.json` attendu après release : `platforms` ⊇ {`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`}. Les URL Windows finissent par `-setup.exe`. Les deux URL darwin pointent le même `Portunia_universal.app.tar.gz` (ou le nom produit par tauri-action) et ont chacune une `signature`

### Consumed Invariants

- Config Windows intacte
- Plateformes de `latest.json` (tâche Mac `needs: windows`)

## Tasks

- [x] Générer `icon.icns` et le référencer dans `tauri.macos.conf.json`
- [x] Entitlements et hardened runtime, signature ad-hoc. Tauri signe aussi l'`externalBin` (`portunia-rdp`) : à vérifier en CI avec `codesign -dv --verbose=2` sur les deux binaires
- [x] `build-rdp.mjs` universel avec `lipo`. Test : `lipo -archs` affiche `x86_64 arm64`
- [x] `release.yml`, tâche `macos` :
  - `needs: windows`
  - `rustup target add aarch64-apple-darwin x86_64-apple-darwin`
  - `PORTUNIA_RDP_UNIVERSAL=1`
  - `tauri-action` **au même SHA épinglé** que la tâche Windows, mêmes `owner`, `repo`, `releaseCommitish`, `tagName`, `releaseName`, `includeUpdaterJson: true`, plus `args: --target universal-apple-darwin`
  - secrets de mise à jour existants seulement (`TAURI_SIGNING_PRIVATE_KEY*`, `RELEASES_TOKEN`)
  - `releaseBody` mis à jour dans la tâche Windows ? **NON** : ne pas toucher à la tâche Windows. Le texte « setup.exe » reste. Le `.dmg` est mentionné dans le README
- [x] Bloc de notarisation **prêt mais désactivé** : étape conditionnée par `if: ${{ secrets.APPLE_ID != '' }}` (via une variable `env` intermédiaire, la syntaxe directe sur secrets n'étant pas autorisée), avec les variables `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` documentées en commentaire
- [x] Dernière étape de la tâche `macos` : télécharger le `latest.json` de la release et lancer `node scripts/check-latest-json.mjs latest.json` (échoue si une plateforme manque ou si une URL pointe un artefact d'une autre plateforme)
- [x] `check-latest-json.mjs` : fonction pure plus un auto-test (`node scripts/check-latest-json.mjs --self-test` avec un JSON valide et deux invalides, en code inline, sans framework)
- [x] Passe WebKit : relire le CSS et les API utilisées (`navigator.clipboard`, `ResizeObserver`, `:has()`, `backdrop-filter` avec préfixe `-webkit-`, glisser-déposer de fichiers, police du terminal). Corriger ce qui est manifestement incompatible avec Safari 14+ (macOS 11). Noter le reste pour la recette
- [x] `docs/recette-macos.md` : grille à cocher pour **Apple Silicon** et **Intel**. Elle couvre :
  - première installation (Gatekeeper) et import des données Windows par sauvegarde
  - SSH (mot de passe, clé, agent), SFTP, FTP, S3, VNC, Telnet, série
  - tunnels, Gate, Proxmox
  - RDP IronRDP (clavier AZERTY Mac, Cmd→Ctrl, presse-papiers, son, copie de fichiers, RD Gateway) et RDP via Windows App
  - shells locaux, ping et traceroute, Finder, éditeur externe, notifications
  - menu Édition et Cmd+C/V dans les champs, thème clair/sombre « Comme macOS »
  - Touch ID (activation, déverrouillage, annulation, changement de mot de passe)
  - mise à jour automatique N-1 → N, et vérification que Windows se met toujours à jour
- [x] README FR et EN : section macOS

## Acceptance Criteria

- [x] `node scripts/check-latest-json.mjs --self-test` réussit
- [ ] `macos-build.yml` produit un `.dmg` universel. `lipo -archs` sur `Portunia.app/Contents/MacOS/*` affiche `x86_64 arm64`. `codesign -v` réussit sur l'application et sur `portunia-rdp` (BLOCKED si la CI est indisponible)
- [x] `git diff main -- .github/workflows/release.yml` ne montre **que des ajouts** (aucune ligne de la tâche `windows` modifiée ou supprimée)
- [x] Invariants « Config Windows intacte » et « Plateformes de `latest.json` » verts
- [x] `npm run build` et `cargo test` (src-tauri, rdp-helper) passent
- [x] `docs/recette-macos.md` existe et couvre chaque protocole de la liste ci-dessus

## Verification

- [x] `node scripts/check-latest-json.mjs --self-test`
- [x] `npm run build`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path rdp-helper/Cargo.toml`
- [x] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- `tauri.conf.json` : `targets: ["nsis"]`, icônes png et ico, `externalBin: ["binaries/portunia-rdp"]`, `createUpdaterArtifacts: true`, point d'accès du programme de mise à jour `https://github.com/jpiperault/Portunia-releases/releases/latest/download/latest.json`, clé publique minisign. `tauri.macos.conf.json` (S1) est fusionné par-dessus sur Mac.
- `release.yml` : une seule tâche Windows, `tauri-action` épinglé au SHA 84b9d35b5fc46c1e45415bdb6144030364f7ebc5, `with:` = owner `jpiperault`, repo `Portunia-releases`, `releaseCommitish: main`, `tagName: ${{ github.ref_name }}`, `releaseName: Portunia ${{ github.ref_name }}`, `includeUpdaterJson: true`. Il y a aussi une étape « Assistance » (`aide`) qui ne doit pas être touchée.
- Avec `--target universal-apple-darwin`, tauri-action écrit les entrées `darwin-aarch64` et `darwin-x86_64` en les fusionnant au `latest.json` existant de la release. D'où le `needs: windows`, qui évite une course.
- Aucun compte Apple Developer : signature ad-hoc, pas de notarisation, et Gatekeeper demande « Ouvrir quand même » à la première installation. Les mises à jour téléchargées par l'application n'ont pas l'attribut de quarantaine.
- **Ne jamais pousser de tag `v*`** pendant ce sprint : la première release Mac sera déclenchée par l'utilisateur.

## Agent Notes (filled during execution)

- Assigned to: sprint-executor (sonnet), branche `feat/macos-s5`
- Started: 2026-11-06
- Completed: 2026-11-06 (CI et tâches de release non exécutées : voir « Issues found »)
- Decisions made:
  - `icon.icns` existait déjà (fusionné avant ce sprint, 69 Ko, non modifié) : simplement référencé dans `tauri.macos.conf.json` (`icons/icon.png` + `icons/icon.icns`). Aucune régénération, donc aucun autre fichier d'icône touché.
  - `Entitlements.plist` : `network.client` et `device.serial` seulement. `allow-jit` volontairement omis (WKWebView tourne dans le processus WebContent d'Apple) ; à ajouter si la recette montre un crash au démarrage sous hardened runtime. Ces deux clés n'agissent qu'en sandbox : elles sont documentées comme sans effet ici.
  - `build-rdp.mjs` en mode universel produit en plus `portunia-rdp-aarch64-apple-darwin` et `portunia-rdp-x86_64-apple-darwin` : `tauri build --target universal-apple-darwin` compile Portunia une fois par architecture et `tauri-build` exige chaque binaire externe par triplet (et le triplet de l'hôte pour `cargo test`). Sans option, le script est inchangé.
  - `release.yml` : deux étapes tauri-action exclusives (ad hoc / notarisée) selon `env.NOTARIZE` (calculé au niveau de la tâche depuis `secrets.APPLE_ID`). Une seule étape avec des variables APPLE_* vides risquait de déclencher la signature avec une identité vide. Le moteur RDP est compilé avec `--release` dans la tâche macOS.
  - `latest.json` vérifié par `gh release download` (RELEASES_TOKEN) puis `check-latest-json.mjs` ; le tag passe par une variable d'environnement (pas d'interpolation dans `run`).
  - `macos-build.yml` : `--bundles app,dmg`, puis boucle `lipo -archs` sur `Contents/MacOS/*` (ordre normalisé) et `codesign -v` sur l'app et `portunia-rdp`.
  - `check-latest-json.mjs` contrôle aussi la présence de `signature`, l'extension `-setup.exe` (Windows), `.app.tar.gz` (darwin) et l'identité des deux URL darwin.
  - `tauri-plugin-updater` : `default-features = false` sans `zip` est suffisant pour `.app.tar.gz` : sur macOS, `tar` et `flate2` sont des dépendances inconditionnelles du plugin (v2.14.0). La feature `zip` ne sert qu'au zip Windows et à l'AppImage. Aucun changement de Cargo.toml.
- Corrections WebKit (passe CSS/API) :
  - `src/styles.css` : ajout de `-webkit-backdrop-filter` (écran verrouillé) ; ajout de `-webkit-user-select` à côté des `user-select: none` ; séparation des listes de sélecteurs contenant `:has()` (`.ext-grid ...`, `.seg-opt.on, .seg-opt:has(input:checked)`) pour qu'un WebKit sans `:has()` (Safari < 15.4) ne jette pas toute la règle.
  - `src/settings.ts` : `fontStack` ajoute `Menlo, "SF Mono"` avant `monospace` (Cascadia et Consolas n'existent pas sur Mac). Sans effet sous Windows.
  - Sans changement : `navigator.clipboard` (déclenché par un geste ; `readText` peut demander une autorisation sous WKWebView), `ResizeObserver` (Safari 13.1+), `inset` (14.1+), `accent-color` (15.4+, simple dégradé esthétique).
- Renvoyé à la recette : `clipboard.readText()` (collage dans le terminal et VNC) et son éventuelle demande d'autorisation ; rendu de `accent-color` ; glisser-déposer de fichiers (`onDragDropEvent` de Tauri, pas du DOM) ; police par défaut « Cascadia Mono » listée dans les réglages alors qu'absente du Mac (fallback Menlo à valider visuellement).
- Assumptions :
  - 🟢 Les deux entrées darwin pointent la même archive `.app.tar.gz` (comportement documenté de tauri-action en universel).
  - 🟡 tauri-action ne remplace pas le `releaseBody` d'une release existante quand `releaseBody` est absent de la tâche macOS (non vérifiable ici ; à surveiller à la première release).
  - 🟡 `gh` est présent sur `macos-latest` (c'est le cas des images GitHub), authentifié par `GH_TOKEN`.
  - 🟡 Le nom du `.dmg` est `Portunia_<version>_universal.dmg` (README).
- Issues found :
  - Rien de bloquant. Hors périmètre : la tâche `windows` de `release.yml` n'a pas de `releaseBody` pour le Mac (contrainte du sprint) ; le `.dmg` n'est mentionné que dans le README.
  - Build local `tauri build --target universal-apple-darwin --bundles app,dmg` (createUpdaterArtifacts désactivé en local, faute de clé) : `.app` produit ; `lipo -archs` = `x86_64 arm64` sur `portunia` et `portunia-rdp` ; `codesign -v` OK sur l'app et `portunia-rdp` ; `codesign -dv` : `flags=0x10002(adhoc,runtime)` sur les deux (hardened runtime + ad hoc confirmés, `externalBin` bien signé). La création du `.dmg` a échoué ici sur un délai AppleEvent du Finder (-1712, AppleScript de `bundle_dmg.sh` sans accès GUI/Automation en session agent) : limite d'environnement, non vérifiée localement.
  - Exécution CI (`macos-build.yml`, `release.yml`) impossible ici : BLOCKED, à vérifier au premier push de la branche.
- Corrections après relecture :
  - `macos-build.yml` : `tauri build` reçoit `--config '{"bundle":{"createUpdaterArtifacts":false}}'` (aucun secret dans ce job, sinon « public key found but no private key »). `tauri.conf.json` inchangé.
  - `release.yml` (tâche macos, deux étapes tauri-action) : `releaseBody` identique au caractère près à celui de la tâche windows (3 lignes identiques, aucune ligne `-` dans le diff), pour ne pas vider le corps de la release existante. L'hypothèse 🟡 sur `releaseBody` est ainsi levée.
  - `check-latest-json.mjs` : option `--tag vX.Y.Z` (documentée en en-tête) exigeant `version == tag sans « v »` et `/download/<tag>/` dans chaque URL ; `release.yml` passe `--tag "$TAG"`.
  - Auto-test : cas ajoutés (écrits avant le code) pour signature absente, URL Windows sans `-setup.exe`, bon tag, version différente du tag, URL d'un autre tag.
