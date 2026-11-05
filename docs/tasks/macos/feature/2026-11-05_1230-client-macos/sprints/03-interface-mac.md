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

- [ ] `platform.ts` + `initPlatform()` appelé au démarrage dans `main.ts`
- [ ] **Menu natif (`appmenu.rs`, macOS uniquement)** :
  - menu Portunia (À propos, Réglages… ⌘,, Masquer ⌘H, Masquer les autres, Tout afficher, Quitter ⌘Q)
  - **menu Édition** avec les éléments prédéfinis Undo, Redo, Cut, Copy, Paste, Select All, indispensables pour que Cmd+C/V/X/A/Z marchent dans les champs WKWebView
  - menu Fenêtre (Réduire ⌘M, Zoom, Fermer l'onglet ⌘W)
  - menu Aide
  - les éléments personnalisés émettent `menu://<id>`
  - libellés FR ou EN selon la langue choisie, via la logique de `lang.rs`
- [ ] Remplacer chaque `ctrlKey` des raccourcis applicatifs par `isMod(e)`. **Exceptions :** les touches transmises au terminal ou à la session distante (Ctrl+C dans un shell, touches RDP et VNC brutes) restent en `ctrlKey`, avec un commentaire `// touche transmise, pas un raccourci`
- [ ] Terminal Mac : Cmd+C copie la sélection, Cmd+V colle, Cmd+clic ouvre un lien. Ctrl+C reste l'interruption envoyée au shell. Windows ne change pas (Ctrl+Maj+C/V)
- [ ] RDP et VNC : réglage « Touche ⌘ envoyée comme » avec les choix `Ctrl` (par défaut) ou `Windows`. Appliqué dans `rdpkeys.ts`. Option ⌥ = Alt
- [ ] Ctrl+Alt+Suppr (`screen.ts:339`) : garder le bouton, sans raccourci Mac en conflit
- [ ] Panneau local : chemins POSIX sur Mac (racine `/`, raccourcis `~`, `/Volumes`), sans lecteurs `C:`. La règle des caractères réservés (`localpanel.ts:10`) ne s'applique qu'à Windows. « Afficher dans le Finder » via `fileManagerName()`
- [ ] Glisser-déposer depuis le Finder (`files.ts:172`, `main.ts:1529`, `tree.ts:263`) : vérifier que les chemins reçus de Tauri (`onDragDropEvent`) sont bien utilisés et non analysés comme des chemins Windows
- [ ] Textes : thème « Comme macOS », « notification macOS », agent SSH (« agent SSH (SSH_AUTH_SOCK) » sur Mac au lieu de Pageant), éditeur par défaut, phrase d'en-tête d'`i18n.ts`. Toujours via `t(en, fr)`
- [ ] Libellés des raccourcis dans les menus : `modLabel()`
- [ ] Shells locaux : masquer « Ouvrir en administrateur » si `elevatable === false`
- [ ] Client RDP externe : libellé « Windows App (Microsoft) » sur Mac, « mstsc » sous Windows. La valeur enregistrée ne change pas

## Acceptance Criteria

- [ ] `npm run build` passe (`tsc` + `check-i18n` + vite)
- [ ] La commande de l'invariant « Raccourcis via isMod » renvoie 0
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` passe en local sur le Mac (`appmenu.rs` compilé ou exclu par `cfg` sans erreur)
- [ ] `grep -nE 'Explorateur|Explorer|Windows Hello|Pageant' src/*.ts` : chaque occurrence restante est soit derrière `IS_MAC`/`fileManagerName()`, soit dans `security.ts`/`importexport.ts` (S4)
- [ ] Les tâches `macos` et `windows` de la CI sont vertes (ou BLOCKED si la CI est indisponible)

## Verification

- [ ] `npm run build`
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml`
- [ ] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- Aucun menu Tauri n'existe aujourd'hui (aucun `Menu::`). `src/menu.ts` est le menu de l'interface web, à garder.
- Les menus Tauri 2 se construisent avec `tauri::menu::{MenuBuilder, SubmenuBuilder, PredefinedMenuItem}`, puis `app.set_menu(menu)` et `app.on_menu_event(...)`, qui émet vers la fenêtre `main`.
- i18n : helper `t(en, fr)`, contrôlé par `scripts/check-i18n.cjs` (toute chaîne visible doit passer par `t`).
- Politique d'incertitude : interface et textes → noter l'hypothèse et continuer (le choix utilisateur est « livrer et corriger »).
- Le comportement Windows l'emporte : sous Windows, chaque raccourci doit faire exactement la même chose qu'avant.

## Agent Notes (filled during execution)

- Assigned to:
- Started:
- Completed:
- Decisions made:
- Assumptions:
- Issues found:
