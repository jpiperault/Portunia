# Sprint 3: Interface et clavier Mac

## Meta

- **PRD:** `../spec.md`
- **Sprint:** 3 of 5
- **Depends on:** Sprint 1
- **Batch:** 2 (parallel with Sprint 2, aucun fichier en commun)
- **Model:** sonnet
- **Estimated effort:** L

## Objective

Rendre l'interface naturelle sur Mac (menus natifs, Cmd à la place de Ctrl, chemins POSIX, textes propres à la plateforme) sans changer quoi que ce soit au comportement Windows.

## File Boundaries

### Creates (new files)

- `src/platform.ts` : contrat ci-dessous
- `src-tauri/src/appmenu.rs` : barre de menus native macOS

### Modifies (can touch)

- `src-tauri/src/lib.rs` : `mod appmenu;`, installation du menu sous `cfg(target_os = "macos")` dans `setup`
- `src/main.ts` : initialiser `platform.ts` avant le premier rendu, raccourcis (`:1529`, `:1552`), écoute des événements du menu
- `src/terminal.ts` : Cmd+C/V (`:149`, `:203`), Cmd+clic sur un lien (`:132`). Sur Mac, Ctrl+C reste envoyé au shell
- `src/files.ts` (`:17,21,345,172,207`), `src/localpanel.ts` (`:7-18,124,141`), `src/multiexec.ts` (`:163`), `src/screen.ts` (`:315,339`), `src/tree.ts` (`:263`) : raccourcis, chemins, glisser-déposer
- `src/rdpkeys.ts` : correspondance Cmd → Ctrl (réglable)
- `src/settings.ts` : thème « Comme macOS » (`:135-144`), réglage « Touche Cmd en RDP »
- `src/theme.ts` (`:40`), `src/monitoring.ts` (`:108`), `src/credentials.ts` (`:70`), `src/i18n.ts` (`:1`) : textes selon la plateforme
- `src/localshells.ts` : masquer le bouton d'élévation si `elevatable === false`
- `src/menu.ts` : afficher `⌘` à la place de `Ctrl` dans les libellés de raccourcis
- `src/screen.ts` et l'écran de réglage RDP qui propose le client externe mstsc : libellé « Windows App » sur Mac. Si cet écran est dans un autre fichier, le noter dans les Agent Notes
- `src/styles.css` : seulement si un ajustement de mise en page Mac est nécessaire (feux tricolores de la fenêtre, police système)

### Read-Only (reference but do NOT modify)

- `src/security.ts`, `src/importexport.ts` : **appartiennent au S4** (textes Hello et Gestionnaire d'identification)
- `src-tauri/src/platform.rs` (S1) : commande `platform_os`
- `src-tauri/src/connectors/**` : S2 en parallèle, **ne pas modifier**
- `scripts/check-i18n.cjs` : règles i18n

### Shared Contracts

```ts
// src/platform.ts
export let IS_MAC: boolean;                 // fixé par initPlatform(), repli sur /Mac/.test(navigator.userAgent)
export async function initPlatform(): Promise<void>; // invoke('platform_os')
export function isMod(e: KeyboardEvent | MouseEvent): boolean; // IS_MAC ? e.metaKey : e.ctrlKey
export function modLabel(): string;          // "⌘" | "Ctrl"
export function fileManagerName(): string;   // t("Finder","Finder") | t("Explorer","l'Explorateur")
```
- `shells.detect()` contient `elevatable: boolean` (S2). Le traiter comme `true` s'il est absent, pour la compatibilité
- Événement du menu natif → frontend : `menu://<id>`, avec `id` ∈ `new-session`, `quick-connect`, `settings`, `close-tab`, `find` (nommer les ids d'après les actions existantes de `main.ts`)

### Consumed Invariants

- Raccourcis via `isMod` : `! grep -nE 'e\.ctrlKey|ev\.ctrlKey|event\.ctrlKey' src/*.ts | grep -vE 'src/(platform|rdpkeys)\.ts'`
- Config Windows intacte

## Tasks

- [x] `platform.ts` + `initPlatform()` appelé au démarrage dans `main.ts`
- [x] **Menu natif (`appmenu.rs`, macOS uniquement)** :
  - menu Portunia (À propos, Réglages… ⌘,, Masquer ⌘H, Masquer les autres, Tout afficher, Quitter ⌘Q)
  - **menu Édition** avec les éléments prédéfinis Undo, Redo, Cut, Copy, Paste, Select All, indispensables pour que Cmd+C/V/X/A/Z marchent dans les champs WKWebView
  - menu Fenêtre (Réduire ⌘M, Zoom, Fermer l'onglet ⌘W)
  - menu Aide
  - les éléments personnalisés émettent `menu://<id>`
  - libellés FR ou EN selon la langue choisie, via la logique de `lang.rs`
- [x] Remplacer chaque `ctrlKey` des raccourcis applicatifs par `isMod(e)`. **Exceptions :** les touches transmises au terminal ou à la session distante (Ctrl+C dans un shell, touches RDP et VNC brutes) restent en `ctrlKey`, avec un commentaire `// touche transmise, pas un raccourci`
- [x] Terminal Mac : Cmd+C copie la sélection, Cmd+V colle, Cmd+clic ouvre un lien. Ctrl+C reste l'interruption envoyée au shell. Windows ne change pas (Ctrl+Maj+C/V)
- [x] RDP et VNC : réglage « Touche ⌘ envoyée comme » avec les choix `Ctrl` (par défaut) ou `Windows`. Appliqué dans `rdpkeys.ts`. Option ⌥ = Alt
- [x] Ctrl+Alt+Suppr (`screen.ts:339`) : garder le bouton, sans raccourci Mac en conflit
- [x] Panneau local : chemins POSIX sur Mac (racine `/`, raccourcis `~`, `/Volumes`), sans lecteurs `C:`. La règle des caractères réservés (`localpanel.ts:10`) ne s'applique qu'à Windows. « Afficher dans le Finder » via `fileManagerName()`
- [x] Glisser-déposer depuis le Finder (`files.ts:172`, `main.ts:1529`, `tree.ts:263`) : vérifier que les chemins reçus de Tauri (`onDragDropEvent`) sont bien utilisés et non analysés comme des chemins Windows
- [x] Textes : thème « Comme macOS », « notification macOS », agent SSH (« agent SSH (SSH_AUTH_SOCK) » sur Mac au lieu de Pageant), éditeur par défaut, phrase d'en-tête d'`i18n.ts`. Toujours via `t(en, fr)`
- [x] Libellés des raccourcis dans les menus : `modLabel()`
- [x] Shells locaux : masquer « Ouvrir en administrateur » si `elevatable === false`
- [x] Client RDP externe : libellé « Windows App (Microsoft) » sur Mac, « mstsc » sous Windows. La valeur enregistrée ne change pas

## Acceptance Criteria

- [x] `npm run build` passe (`tsc` + `check-i18n` + vite)
- [x] La commande de l'invariant « Raccourcis via isMod » renvoie 0
- [x] `cargo check --manifest-path src-tauri/Cargo.toml` passe en local sur le Mac (`appmenu.rs` compilé ou exclu par `cfg` sans erreur)
- [ ] `grep -nE 'Explorateur|Explorer|Windows Hello|Pageant' src/*.ts` : chaque occurrence restante est soit derrière `IS_MAC`/`fileManagerName()`, soit dans `security.ts`/`importexport.ts` (S4)
- [ ] Les tâches `macos` et `windows` de la CI sont vertes (ou BLOCKED si la CI est indisponible)

## Verification

- [x] `npm run build`
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`
- [x] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- Aucun menu Tauri n'existe aujourd'hui (aucun `Menu::`). `src/menu.ts` est le menu de l'interface web, à garder.
- Les menus Tauri 2 se construisent avec `tauri::menu::{MenuBuilder, SubmenuBuilder, PredefinedMenuItem}`, puis `app.set_menu(menu)` et `app.on_menu_event(...)`, qui émet vers la fenêtre `main`.
- i18n : helper `t(en, fr)`, contrôlé par `scripts/check-i18n.cjs` (toute chaîne visible doit passer par `t`).
- Politique d'incertitude : interface et textes → noter l'hypothèse et continuer (le choix utilisateur est « livrer et corriger »).
- Le comportement Windows l'emporte : sous Windows, chaque raccourci doit faire exactement la même chose qu'avant.

## Agent Notes (filled during execution)

- Assigned to: sprint-executor (sonnet), branche `feat/macos-s3`
- Started / Completed: 2026-11-05 (non commité, indexé seulement)
- Ajouts sur décision de l'utilisateur (hors liste du sprint) : script npm `"test": "node --import ./tests/setup.mjs --test tests/src/"` (node:test, Node 26 exécute le TS directement, aucune dépendance) ; `tests/setup.mjs` (résolution des imports sans extension, faux localStorage/document) ; `tests/src/*.test.ts` (placés là car le hook TDD accepte `tests/<rel_dir>/<nom>.test.ts`) ; `src-tauri/tests/appmenu.rs` et `src-tauri/tests/lib.rs` (tests Rust d'intégration, seule forme acceptée par le hook).
- Decisions made:
  - Toute la logique testable est dans `src/platform.ts` avec un paramètre `mac` optionnel : `isMod`, `modLabel`, `fileManagerName`, `keys()` (« Ctrl Maj K » -> ⇧⌘K ; « Ctrl Maj Q » -> ⌘K), `appShortcut()` (table des raccourcis globaux, ⌘⇧Q exclu sur Mac), `termShortcut()`, `parentDir/joinPath/baseName/localName/places` (chemins), `sshAgentNote`, `externalRdpName`, `canElevate`, `localizeShortcutTitles`.
  - Touche ⌘ en RDP/VNC : `remapMeta` (code ET keysym, car le moteur RDP utilise le code physique) et `liveKey` dans `rdpkeys.ts` ; réglage `metaKeyAs` ('ctrl' par défaut) visible seulement sur Mac. Sur Mac, WebKit n'émet pas keyup pour une touche pressée sous ⌘ : `liveKey` demande un relâchement immédiat (`releaseNow`).
  - ⌘K (connexion rapide) : accélérateur du menu natif uniquement, pas de gestionnaire JS (évite le double déclenchement). Même principe pour ⌘, (réglages), ⌘W (fermer l'onglet), ⌘F (rechercher). ⌘⇧N etc. restent gérés en JS (isMod) donc sans accélérateur dans le menu.
  - Contrôle de conflit pour ⌘K : aucun `key === 'k'` sans Maj dans src/ ; seul ⌘⇧K (filtrer les sessions) existe ; le terminal ne réserve que ⌘/Ctrl+Maj, et xterm ignore ⌘+lettre. Ctrl+K du shell (Ctrl, pas ⌘) n'est pas touché. À confirmer à la main (xterm pourrait absorber l'événement).
  - Terminal Mac : ⌘C copie la sélection, ⌘V ne fait rien au clavier (l'événement `paste` natif du menu Édition colle : pas de double collage), Ctrl+C reste au shell.
  - Menu natif (`appmenu.rs`) compilé partout, installé sous `cfg(target_os = "macos")` ; langue : le menu est installé en langue du cœur puis reconstruit par la commande `appmenu_refresh(lang)` appelée depuis main.ts (set_language arrive après l'installation). Menu « Session » ajouté (Nouvelle session, Connexion rapide) car les ids `new-session` et `quick-connect` doivent avoir un emplacement. Aide : ouvre la page des versions (URL de Portunia-releases tirée du README).
  - `await initPlatform()` en tête de main.ts (top-level await, cible chrome105 OK).
  - Les 9 `ctrlKey` sont tous des raccourcis applicatifs -> `isMod` ; aucune touche transmise ne reste en `ctrlKey` dans ces fichiers (la transmission VNC passe par `liveKey`).
  - `windowsName`/`localJoin` gardent leur nom et leur signature (utilisés par filesview.ts et syncdialog.ts, hors périmètre) mais délèguent à `platform.ts`.
  - Tests par fichier : plusieurs modules de production (files, localpanel, settings, multiexec, terminal, screen, credentials, localshells, main) ne se chargent pas sous node (propriétés de paramètre de constructeur, DOM à l'import, xterm). Leur `tests/src/<nom>.test.ts` teste donc les helpers de `platform.ts`/`rdpkeys.ts` qu'ils appellent, sur les scénarios du fichier (dit explicitement en tête de chaque test). `tree.ts`, `menu.ts`, `theme.ts`, `monitoring.ts` : non modifiés (pas de libellé de raccourci dans menu.ts ; tree.ts:263 vérifié, c'est un commentaire sur le drag HTML5 ; theme.ts:40 est le nom de la palette « Campbell (Windows Terminal) » ; monitoring.ts:108 est un commentaire).
  - Glisser-déposer : `onDragDropEvent` fournit des chemins POSIX sur Mac ; le seul découpage de chemin (`baseName` dans files.ts) ne traite plus « \ » comme séparateur sur Mac. Bug évité en cours de route : `paths.map(baseName)` passait l'index comme paramètre `mac`.
- Assumptions:
  - 🟢 Le menu Édition prédéfini fait coller via l'événement `paste` natif dans WKWebView.
  - 🟡 `shells.detect()` renvoie `elevatable` dans l'objet (S2) ; `canElevate` traite l'absence comme vrai. Le bouton d'élévation est dans main.ts (menu contextuel d'un shell et menu « + »), pas dans localshells.ts.
  - 🟡 Libellé « Windows App (Microsoft) » fourni par `externalRdpName()` mais aucun écran de réglage du client externe n'existe dans src/ (grep mstsc : seulement quick.ts, alias de protocole) : la fonction n'est donc branchée nulle part. À brancher si un écran apparaît (S2/S4 ou Gate).
  - 🟡 URL du menu Aide (Portunia-releases/releases).
  - 🟡 Le format des accélérateurs Tauri "Cmd+K" est accepté (compilé, non lancé).
- Issues found:
  - Hors périmètre, non modifiés : `src/syncdialog.ts:194` construit le chemin local avec `\\` (cassé sur Mac) ; `src/recordings.ts:71` affiche « Afficher dans l'Explorateur » (Windows) ; `src/filesview.ts:72` commentaire ; `src/credentials.ts:111` parle du « Gestionnaire d'identification Windows » (texte S4) ; `src/api.ts` : `ShellSpec` n'a pas de champ `elevatable` (type), contourné par `canElevate`.
  - Critère « grep Explorateur/Explorer... » : restent des occurrences hors condition IS_MAC mais légitimes : screen.ts:209/226 (Explorateur du serveur Windows distant), commentaires (files.ts:1, tree.ts:263, main.ts, filesview.ts), `fileManagerName()` lui-même, et recordings.ts:71 (hors périmètre, à traiter).
  - Corrections de revue (2e passe) : modificateurs (Shift/Alt/Control/Meta/CapsLock) jamais relâchés d'avance par `liveKey` ; `releaseOnMetaUp` libère côté serveur les touches restées enfoncées au keyup de ⌘ ; `menu://…` passe par `runUnlessBusy` (testable) ; `appmenu_refresh` n'est plus attendu et logue son erreur ; accélérateurs du menu dans `CUSTOM_ITEMS` (source unique de `build`, testée : aucun accélérateur avec Maj, ⌘K/⌘F/⌘W/⌘, présents).
  - DÉCISION ORCHESTRATEUR (écran distant au focus, Mac) : ⌘Q, ⌘H, ⌘M et ⌘, (sans Maj) ne sont NI interceptés NI envoyés (constante `MAC_APP_KEYS`, `isMacAppKey` dans rdpkeys.ts) ; toutes les autres combinaisons ⌘+touche (⌘C, ⌘V, ⌘W, ⌘K…) partent vers la session selon « Touche ⌘ envoyée comme » (comme les clients RDP Mac). ⌘⇧ reste réservé à Portunia.
  - Bugs hors périmètre corrigés avec l'accord de l'orchestrateur : `syncdialog.ts` (chemin local via `localPathUnder`, Windows identique) et `recordings.ts` (libellés via `revealLabels`, Finder sur Mac, Windows identique). `filesview.ts:72` : commentaire laissé. Corrigés aussi, mais à signaler : ces deux fichiers étaient hors de la liste du sprint.
  - Dead code sous Windows : `#[cfg_attr(not(target_os = "macos"), allow(dead_code))]` sur `mod appmenu` (lib.rs, couvre `EVENT_IDS`, `HELP_URL`, `event_name`) et sur `install` ; non vérifié par compilation Windows (cible non installée).
  - CI (tâches macos/windows vertes) : BLOCKED, non vérifiable sans pousser.
  - Aucun test Rust n'a été lancé sous Windows. `cargo check` de `portunia-rdp` a nécessité `node scripts/build-rdp.mjs` (binaire non versionné dans src-tauri/binaries).
