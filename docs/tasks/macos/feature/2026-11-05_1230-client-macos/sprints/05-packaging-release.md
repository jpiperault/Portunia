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

- [ ] Générer `icon.icns` et le référencer dans `tauri.macos.conf.json`
- [ ] Entitlements et hardened runtime, signature ad-hoc. Tauri signe aussi l'`externalBin` (`portunia-rdp`) : à vérifier en CI avec `codesign -dv --verbose=2` sur les deux binaires
- [ ] `build-rdp.mjs` universel avec `lipo`. Test : `lipo -archs` affiche `x86_64 arm64`
- [ ] `release.yml`, tâche `macos` :
  - `needs: windows`
  - `rustup target add aarch64-apple-darwin x86_64-apple-darwin`
  - `PORTUNIA_RDP_UNIVERSAL=1`
  - `tauri-action` **au même SHA épinglé** que la tâche Windows, mêmes `owner`, `repo`, `releaseCommitish`, `tagName`, `releaseName`, `includeUpdaterJson: true`, plus `args: --target universal-apple-darwin`
  - secrets de mise à jour existants seulement (`TAURI_SIGNING_PRIVATE_KEY*`, `RELEASES_TOKEN`)
  - `releaseBody` mis à jour dans la tâche Windows ? **NON** : ne pas toucher à la tâche Windows. Le texte « setup.exe » reste. Le `.dmg` est mentionné dans le README
- [ ] Bloc de notarisation **prêt mais désactivé** : étape conditionnée par `if: ${{ secrets.APPLE_ID != '' }}` (via une variable `env` intermédiaire, la syntaxe directe sur secrets n'étant pas autorisée), avec les variables `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` documentées en commentaire
- [ ] Dernière étape de la tâche `macos` : télécharger le `latest.json` de la release et lancer `node scripts/check-latest-json.mjs latest.json` (échoue si une plateforme manque ou si une URL pointe un artefact d'une autre plateforme)
- [ ] `check-latest-json.mjs` : fonction pure plus un auto-test (`node scripts/check-latest-json.mjs --self-test` avec un JSON valide et deux invalides, en code inline, sans framework)
- [ ] Passe WebKit : relire le CSS et les API utilisées (`navigator.clipboard`, `ResizeObserver`, `:has()`, `backdrop-filter` avec préfixe `-webkit-`, glisser-déposer de fichiers, police du terminal). Corriger ce qui est manifestement incompatible avec Safari 14+ (macOS 11). Noter le reste pour la recette
- [ ] `docs/recette-macos.md` : grille à cocher pour **Apple Silicon** et **Intel**. Elle couvre :
  - première installation (Gatekeeper) et import des données Windows par sauvegarde
  - SSH (mot de passe, clé, agent), SFTP, FTP, S3, VNC, Telnet, série
  - tunnels, Gate, Proxmox
  - RDP IronRDP (clavier AZERTY Mac, Cmd→Ctrl, presse-papiers, son, copie de fichiers, RD Gateway) et RDP via Windows App
  - shells locaux, ping et traceroute, Finder, éditeur externe, notifications
  - menu Édition et Cmd+C/V dans les champs, thème clair/sombre « Comme macOS »
  - Touch ID (activation, déverrouillage, annulation, changement de mot de passe)
  - mise à jour automatique N-1 → N, et vérification que Windows se met toujours à jour
- [ ] README FR et EN : section macOS

## Acceptance Criteria

- [ ] `node scripts/check-latest-json.mjs --self-test` réussit
- [ ] `macos-build.yml` produit un `.dmg` universel. `lipo -archs` sur `Portunia.app/Contents/MacOS/*` affiche `x86_64 arm64`. `codesign -v` réussit sur l'application et sur `portunia-rdp` (BLOCKED si la CI est indisponible)
- [ ] `git diff main -- .github/workflows/release.yml` ne montre **que des ajouts** (aucune ligne de la tâche `windows` modifiée ou supprimée)
- [ ] Invariants « Config Windows intacte » et « Plateformes de `latest.json` » verts
- [ ] `npm run build` et `cargo test` (src-tauri, rdp-helper) passent
- [ ] `docs/recette-macos.md` existe et couvre chaque protocole de la liste ci-dessus

## Verification

- [ ] `node scripts/check-latest-json.mjs --self-test`
- [ ] `npm run build`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path rdp-helper/Cargo.toml`
- [ ] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- `tauri.conf.json` : `targets: ["nsis"]`, icônes png et ico, `externalBin: ["binaries/portunia-rdp"]`, `createUpdaterArtifacts: true`, point d'accès du programme de mise à jour `https://github.com/jpiperault/Portunia-releases/releases/latest/download/latest.json`, clé publique minisign. `tauri.macos.conf.json` (S1) est fusionné par-dessus sur Mac.
- `release.yml` : une seule tâche Windows, `tauri-action` épinglé au SHA 84b9d35b5fc46c1e45415bdb6144030364f7ebc5, `with:` = owner `jpiperault`, repo `Portunia-releases`, `releaseCommitish: main`, `tagName: ${{ github.ref_name }}`, `releaseName: Portunia ${{ github.ref_name }}`, `includeUpdaterJson: true`. Il y a aussi une étape « Assistance » (`aide`) qui ne doit pas être touchée.
- Avec `--target universal-apple-darwin`, tauri-action écrit les entrées `darwin-aarch64` et `darwin-x86_64` en les fusionnant au `latest.json` existant de la release. D'où le `needs: windows`, qui évite une course.
- Aucun compte Apple Developer : signature ad-hoc, pas de notarisation, et Gatekeeper demande « Ouvrir quand même » à la première installation. Les mises à jour téléchargées par l'application n'ont pas l'attribut de quarantaine.
- **Ne jamais pousser de tag `v*`** pendant ce sprint : la première release Mac sera déclenchée par l'utilisateur.

## Agent Notes (filled during execution)

- Assigned to:
- Started:
- Completed:
- Decisions made:
- Assumptions:
- Issues found:
