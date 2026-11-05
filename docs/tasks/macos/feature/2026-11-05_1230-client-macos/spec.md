# Portunia pour macOS : Product Requirements Document

## 1. What & Why

**Problème :** Portunia (v0.69.0, Tauri 2 + Rust) ne tourne que sous Windows. Les utilisateurs sur Mac (Apple Silicon et Intel) n'ont pas de client. La feuille de route du README annonce « Linux, puis macOS ».

**Résultat attendu :** une application macOS universelle (`.app` / `.dmg`, arm64 + x86_64), construite depuis **la même base de code**, avec la parité fonctionnelle de la version Windows (hors exclusions §7). Elle se met à jour automatiquement par le même `latest.json`, sans rien casser côté Windows.

**Justification :** environ 95 % du code est déjà portable (SSH, SFTP, FTP, S3, VNC, Telnet, série, tunnels, Gate, Proxmox, coffre chiffré, moteur RDP IronRDP). Le travail porte sur une liste finie de points propres à Windows, inventoriés en §3.

## 2. Correctness Contract

**Audience :** les utilisateurs de Portunia sur Mac (admins système et réseau), qui ouvrent leurs sessions distantes au quotidien, et le mainteneur, qui teste sur un Mac Apple Silicon et un Mac Intel.

**Failure Definition (inutile) :** une fonction présente sous Windows est absente ou cassée sur Mac sans raison documentée. Le choix utilisateur est la **parité totale**, hors exclusions §7. Modes d'échec concrets à éviter :
1. L'application ne démarre pas sur l'un des deux Mac (architecture manquante dans le binaire universel, ou `portunia-rdp` absent ou non signé).
2. Cmd+C/V ne marche pas dans les champs de saisie (menu Édition natif absent).
3. Aucun shell local n'est proposé, ou le shell s'ouvre hors de `$HOME` sans le `PATH` de connexion (Homebrew introuvable).
4. L'authentification par agent SSH échoue alors que `ssh-add -l` liste des clés.
5. Ping et traceroute renvoient une erreur de permission sans root.
6. La session RDP IronRDP n'affiche pas l'image, ou envoie de mauvaises touches sur un clavier Mac AZERTY.
7. Le `latest.json` publié n'a pas d'entrée `darwin-*`, donc pas de mise à jour automatique sur Mac.

**Danger Definition (nuisible) :**
1. **Secrets en clair** : mot de passe, passphrase ou clé du coffre écrits en clair sur disque ou dans les logs, ou Touch ID qui déverrouille sans vérification réelle.
2. **Régression Windows** : une modification du portage casse la version Windows existante.
3. **Mise à jour cassée** : `latest.json` mal fusionné qui casse la mise à jour automatique Windows, ou qui propose un binaire d'une autre plateforme.

**Risk Tolerance :** **livrer et corriger**. Une fonction qui passe ses tests automatiques mais n'a pas été validée sur un vrai Mac est livrée avec la mention « (expérimental) » dans son libellé, plutôt que masquée. La mention est retirée quand la ligne correspondante de `docs/recette-macos.md` est cochée. **Sauf** dans les trois zones dangereuses, où un refus ou un arrêt vaut mieux qu'un comportement douteux.

## 3. Context Loaded

Inventaire du code (deux explorations, 2026-11-05) :
- `src-tauri/Cargo.toml` : `winreg` est **inconditionnel**, donc la compilation Mac échoue. `keyring` 3 n'a que la feature `windows-native`. Le crate `windows` 0.62 est déjà sous `cfg(windows)`. `portable-pty`, russh, vnc-rs, serialport et rustls-platform-verifier sont portables. `socket2` est déjà présent (en dépendance transitive) dans `Cargo.lock`.
- Windows Hello : `lock.rs:315-348`, avec un stub non-Windows qui renvoie false. Handle de fenêtre : `commands.rs:928-931`. DPAPI : `vault.rs:160-200`, stub qui échoue avec « Windows uniquement ». Secrets : `secrets.rs` via keyring, service `"Termoria"` conservé pour l'historique, clé `{session_id}/{key}`.
- Shells locaux : `connectors/local.rs:95-125` ne détecte que pwsh, Windows PowerShell, cmd, WSL et Git Bash. Dossier de départ via `USERPROFILE`. Élévation par `Start-Process -Verb RunAs` (`:195-214`). PTY via `portable-pty` (openpty sous Unix, fonctionne). `conpty.dll` et `OpenConsole.exe` sont des ressources Windows.
- Agent SSH : `connectors/ssh.rs:578-588`, pipe nommé `\\.\pipe\openssh-ssh-agent` puis Pageant. Aucune branche `SSH_AUTH_SOCK`.
- Ping et traceroute : `nettools.rs:57-122` (`IcmpSendEcho`, stub ailleurs).
- RDP : `rdp-helper` (portunia-rdp, IronRDP), processus séparé qui échange du JSON par lignes plus des blocs RGBA sur stdin/stdout. `rdp.rs:129` ajoute `.exe` via `cfg!`. `mstsc` est lancé avec un fichier `.rdp` temporaire (`rdp.rs:375-452`). `rdp-helper/src/main.rs:195` code en dur `C:\Windows\System32\mstscax.dll`. La pompe à messages du presse-papiers (`:513-531`) a un stub hors Windows. `scripts/build-rdp.mjs` gère déjà le triple de la machine et l'extension.
- Fichiers locaux : `localfs.rs:74-81` (attribut caché, stub prévu). `localfs.rs:123-132` (`local_reveal`) lance `explorer.exe /select,`.
- Importeurs : `~/.ssh/config` et mRemoteNG sont portables, mais leurs chemins par défaut passent par `USERPROFILE` et `APPDATA` (`importers.rs:31-45`). PuTTY lit le registre (`:267`, stub à `:323`).
- Données : `lib.rs:87` `app_data_dir()` donne `~/Library/Application Support/fr.portunia.app` sur Mac, sans rien à faire. La migration Termoria (`lib.rs:48`) ne fait rien sans `APPDATA`.
- Éditeur externe : `commands.rs:1105-1128` passe par `tauri_plugin_opener::open_path`, déjà portable. Notifications : `monitoring.ts:113` via `plugin-notification`, portable.
- Menus Tauri : **aucun**. Sur Mac, sans menu Édition natif, Cmd+C, Cmd+V, Cmd+X, Cmd+A et Cmd+Z ne fonctionnent pas dans les champs du WKWebView.
- Interface : aucun `metaKey` dans `src/*.ts`, tous les raccourcis passent par `ctrlKey` (`terminal.ts:132,149,203`, `main.ts:1552`, `files.ts:17,21,345`, `localpanel.ts:141`, `multiexec.ts:163`, `screen.ts:315,339`). Chemins Windows dans `localpanel.ts:7-18`. Textes « Windows » dans `settings.ts:135-144`, `security.ts:101,116,153`, `importexport.ts:63`, `monitoring.ts:108`, `credentials.ts:70`, `files.ts:207`, `theme.ts:40`, `i18n.ts:1`.
- Config : `tauri.conf.json` a `targets: ["nsis"]`, des icônes png et ico (pas de `.icns`), `createUpdaterArtifacts: true`, les ressources conpty et le point d'accès du programme de mise à jour `Portunia-releases/.../latest.json`.
- CI : `release.yml` n'a qu'une tâche `windows-latest`. `tauri-action` est épinglé (SHA 84b9d35), avec `includeUpdaterJson: true` vers `jpiperault/Portunia-releases`. Il n'y a ni tâche Mac ni secret Apple. `securite.yml` existe.
- Tests : modules `#[cfg(test)]` dans 24 fichiers de `src-tauri/src` et 4 de `rdp-helper/src`. Pas de framework de test TS. La vérification TS se limite à `npm run build` (`tsc` + `check-i18n` + vite).
- Hors périmètre : `aide/` (Portunia Assistance, interface Win32/GDI et SendInput).

## 4. Success Metrics

| Metric | Current | Target | How to Measure |
| --- | --- | --- | --- |
| Builds Mac | 0 | `.app` + `.dmg` universels | Tâche CI `macos-latest` verte, `lipo -archs` affiche `x86_64 arm64` |
| Parité fonctionnelle | 0 % | 100 % de la grille de recette (§16) | `docs/recette-macos.md` cochée sur les deux Mac |
| Régression Windows | — | 0 | Tâche CI `windows-latest` (`cargo test` + `npm run build`) verte à chaque sprint |
| Mise à jour auto | Windows seul | Windows + darwin-aarch64 + darwin-x86_64 | `jq '.platforms \| keys'` sur `latest.json` |

## 5. User Stories

GIVEN un Mac Apple Silicon ou Intel WHEN j'installe le `.dmg` et que j'ouvre Portunia THEN l'application démarre en moins de 5 s, crée `~/Library/Application Support/fr.portunia.app/` et affiche l'arbre des sessions et le tableau de bord, comme sous Windows.

GIVEN une session SSH avec agent WHEN je me connecte THEN Portunia utilise l'agent pointé par `SSH_AUTH_SOCK` (agent macOS, 1Password, Secretive…).

GIVEN un terminal ouvert WHEN je fais Cmd+C, Cmd+V ou Cmd+clic sur un lien THEN Cmd+C copie la sélection dans le presse-papiers macOS, Cmd+V colle son contenu dans le shell, et Cmd+clic ouvre l'URL dans le navigateur par défaut. Ctrl+C envoie toujours l'interruption (0x03) au shell.

GIVEN une session RDP WHEN je tape Cmd+C sur le poste distant THEN Ctrl+C est envoyé (correspondance réglable).

GIVEN « Shells locaux » WHEN j'ouvre la liste THEN zsh, bash, fish et les shells de `/etc/shells` sont proposés, et le shell par défaut est `$SHELL`, lancé en shell de connexion.

GIVEN un coffre verrouillé et Touch ID activé WHEN je pose mon doigt THEN le coffre se déverrouille, et seul un échec de Touch ID ou le mot de passe ramène à la saisie.

GIVEN une session RDP réglée sur le client externe WHEN je l'ouvre sur Mac THEN Portunia ouvre le fichier `.rdp` dans « Windows App » de Microsoft s'il est installé, ou explique comment l'installer.

GIVEN une nouvelle version publiée WHEN Portunia Mac ou Windows vérifie les mises à jour THEN chacun reçoit le paquet de sa plateforme.

## 6. Acceptance Criteria

- [ ] Le `.app` et le `.dmg` universels sont produits par la CI, avec `lipo -archs` qui affiche `x86_64 arm64` pour l'application **et** pour `portunia-rdp`
- [ ] Sur les deux Mac de test, chaque ligne « protocole » de `docs/recette-macos.md` est cochée. Une ligne n'est cochée que si son résultat observable est obtenu (ex. SSH : connexion établie et `uname -a` affiché ; SFTP : un fichier envoyé puis récupéré, contenu identique ; RDP IronRDP : bureau affiché, texte tapé correct en AZERTY, copier-coller dans les deux sens, son entendu, fichier copié). Protocoles couverts : SSH (mot de passe, clé, agent), SFTP, FTP, S3, VNC, Telnet, série, tunnels, Gate, Proxmox, RDP via IronRDP, RDP via Windows App
- [ ] Les shells locaux zsh, bash, fish et `$SHELL` sont détectés et s'ouvrent dans `$HOME`
- [ ] Ping et traceroute fonctionnent sans droits root
- [ ] Le menu Édition natif est présent et Cmd+C, Cmd+V, Cmd+X, Cmd+A et Cmd+Z marchent dans tous les champs. Cmd+Q quitte l'application, Cmd+W ferme l'onglet actif, Cmd+H masque l'application, Cmd+M réduit la fenêtre et Cmd+, ouvre les réglages
- [ ] Tous les raccourcis Ctrl de l'interface passent sur Cmd sur Mac, Windows reste inchangé (`npm run build` vert, et la commande `grep` de l'invariant « Raccourcis via isMod » dans `INVARIANTS.md` renvoie 0)
- [ ] Les mots de passe sont enregistrés dans le Trousseau macOS (visibles dans Trousseaux d'accès sous le service `Termoria`), et aucun secret n'est écrit en clair (invariant « Pas de secret en log » dans `INVARIANTS.md`, au même niveau que ce fichier)
- [ ] Touch ID déverrouille le coffre, et l'annulation ou l'échec retombe sur le mot de passe sans jamais déverrouiller
- [ ] Aucun texte visible sur Mac ne parle de Windows Hello, du Gestionnaire d'identification ou de l'Explorateur. Le contrôle `check-i18n` passe
- [ ] Le `latest.json` publié contient `windows-x86_64`, `darwin-aarch64` et `darwin-x86_64`, et chaque URL pointe vers un artefact de la bonne plateforme
- [ ] La tâche CI Windows (`cargo test` + `npm run build`) est verte après chaque sprint

## 7. Non-Goals

- **Portunia Assistance (`aide/`) sur Mac** : interface Win32/GDI et SendInput, il faudrait une réécriture complète, plus les permissions Enregistrement d'écran et Accessibilité. Le client Mac sait quand même **se connecter** à une assistance, puisque ce n'est qu'une vue RDP.
- **mstsc** : n'existe pas sur Mac, remplacé par Windows App (même réglage « client externe »).
- **Import PuTTY** : le registre Windows n'existe pas sur Mac. L'option est masquée sur Mac. Les imports `~/.ssh/config`, mRemoteNG et sauvegarde Portunia restent disponibles.
- **Notarisation et Developer ID** : pas de compte Apple Developer pour l'instant. Tout est prêt mais désactivé (§9). Conséquence acceptée : à la première installation, Gatekeeper impose « Ouvrir quand même ».
- **Liaison biométrique forte de la clé** (`SecAccessControl` + Data Protection Keychain) : elle exige un Team ID. Elle viendra avec le compte Apple.
- **Mac App Store et sandbox** : incompatibles avec les PTY locaux, les ports série et les sous-processus. Distribution directe uniquement.
- **Linux** : non visé. Le code `cfg(unix)` écrit ici facilitera ce portage plus tard, sans engagement.
- **Framework de test TS** : nouvelle dépendance hors de la pile actuelle. La logique pure côté TS reste minimale (`src/platform.ts`), elle est vérifiée par `tsc` et la recette.

## 8. Technical Constraints

- Pile : Tauri 2, Rust stable, TypeScript sans framework, Vite. **Une seule base de code.**
- Configuration Tauri propre à Mac dans **`src-tauri/tauri.macos.conf.json`**, que Tauri fusionne automatiquement sur Mac. On ne touche pas aux sections Windows de `tauri.conf.json`.
- Code Rust propre à une plateforme via `#[cfg(target_os = "macos")]` ou `#[cfg(unix)]`, à côté des blocs `#[cfg(windows)]` existants, jamais à leur place.
- Environnement de dev : **un Mac Apple Silicon** (macOS, Xcode Command Line Tools, `rustup` avec les cibles `aarch64-apple-darwin` et `x86_64-apple-darwin`, Node LTS). Les tests et la compilation Mac se font **en local**. La CI `macos-build.yml` confirme le binaire universel, et sa tâche `windows-latest` est **le seul garde-fou contre une régression Windows** (aucun Windows en local). Le Mac Intel sert à la recette.
- Nouvelles dépendances approuvées : `security-framework` et/ou `objc2-local-authentication` (Touch ID), avec `objc2` et `block2`, qui font partie de la même famille de bindings et sont indispensables pour appeler LAContext (même approbation), `socket2` en dépendance directe (déjà dans l'arbre). **Toute autre nouvelle dépendance : il faut demander.**

## 9. Architecture Decisions

| Decision | Reversal Cost | Alternatives Considered | Rationale |
|---|---|---|---|
| Même base Tauri, adaptée par `cfg` | High | App Swift native séparée : ~25 000 lignes à réécrire, et chaque fonction livrée deux fois | ~95 % du code est portable |
| `tauri.macos.conf.json` séparé | Low | Modifier `tauri.conf.json` : risque de régression Windows | Fusion native Tauri, la config Windows reste intacte |
| Binaire universel (`universal-apple-darwin`) | Low | Deux `.dmg` séparés : plus de confusion pour l'utilisateur | Un seul téléchargement. `latest.json` pointe le même `.app.tar.gz` pour aarch64 et x86_64 |
| Signature ad-hoc (`signingIdentity: "-"`) | Low | Pas de signature du tout : refusée sur Apple Silicon | Pas de compte Apple. Passer au Developer ID ne demandera que des secrets CI |
| Touch ID = `LAContext` (biométrie) puis clé du coffre lue dans le Trousseau | Med | `SecAccessControl` biométrique : exige un Team ID | Même modèle de menace que Hello + DPAPI sous Windows. On durcit dès que le compte Apple existe |
| Agent SSH via `SSH_AUTH_SOCK` | Low | — | Standard Unix, compatible avec l'agent macOS, 1Password et Secretive |
| ICMP via socket `SOCK_DGRAM`/`IPPROTO_ICMP` (`socket2`) | Low | Lancer `/sbin/ping` puis analyser sa sortie : fragile et dépendant de la langue | macOS autorise l'ICMP datagramme sans root |
| Client RDP externe = Windows App (`open -a "Windows App" fichier.rdp`) | Low | Tout masquer : contraire à la parité | Même réglage que mstsc, même fichier `.rdp` |
| Cmd → Ctrl en RDP par défaut, réglable | Low | Cmd → touche Windows | Habitude des clients RDP Mac |
| La tâche Mac de release dépend de la tâche Windows (`needs`) | Med | Tâches parallèles : `latest.json` risque d'être écrasé | `tauri-action` fusionne sans course |

## 10. Security Boundaries

- **Auth model :** le coffre est déverrouillé par mot de passe (PBKDF2 600k, existant) ou par Touch ID. **Garantie au niveau de l'application** : le code de Portunia ne lit la clé dans le Trousseau qu'après un `LAContext.evaluatePolicy` réussi. Un échec ou une annulation ne renvoie jamais la clé, et il n'y a aucun repli silencieux (vérifié par les tests avec faux authentificateur du S4).
- **Risque résiduel accepté (sans Team ID) :** l'OS ne lie **pas** la clé à la biométrie. Un processus qui tourne sous la même session utilisateur et qu'une ACL du Trousseau autorise (en pratique Portunia lui-même, ou un processus auquel l'utilisateur accorde l'accès dans la boîte de dialogue macOS) pourrait lire la clé sans Touch ID. C'est le même niveau que Windows Hello + DPAPI aujourd'hui, où DPAPI déchiffre pour tout processus de l'utilisateur. Le durcissement (`SecAccessControl` biométrique + Data Protection Keychain) est prévu dès que le compte Apple Developer existe (§7).
- **Trust boundaries :** `$SHELL`, `/etc/shells` et `SSH_AUTH_SOCK` sont des entrées locales. Pour les shells, on vérifie que le chemin est absolu, qu'il existe et qu'il est exécutable. Pour `SSH_AUTH_SOCK`, on vérifie que c'est une socket Unix (`S_ISSOCK`) appartenant à l'utilisateur courant. On n'interprète jamais rien via `sh -c`. Le fichier `.rdp` temporaire est créé avec les droits 0600, sans mot de passe dedans (même règle que mstsc), puis supprimé.
- **Data sensitivity :** mots de passe et passphrases dans le Trousseau (service `"Termoria"` conservé pour la compatibilité). Clé du coffre enveloppée dans le Trousseau, jamais sur disque en clair, jamais dans les logs. Données Windows importées par la sauvegarde Portunia chiffrée (existante).
- **Signature ad-hoc et Trousseau :** l'ACL des éléments du Trousseau est liée au hash de la signature. Avec une signature ad-hoc, macOS peut redemander l'autorisation d'accès après une mise à jour. C'est une gêne acceptée et documentée (recette et README), qui disparaîtra avec le Developer ID. Elle ne réduit pas la sécurité.
- **Tenant isolation :** sans objet (application monoposte).

## 11. Data Model

Aucun changement de schéma. Les mêmes fichiers JSON (`sessions.json`, `credentials.json`, `lock.json`, `known_hosts.json`…) sont stockés dans `app_data_dir()`. `lock.json` gagne un champ facultatif, sans impact sur les fichiers Windows :
- `biometric: "hello" | "touchid" | null`. Une valeur absente est lue comme le comportement actuel.

## 12. Shared Contracts

- **Rust `src-tauri/src/platform.rs`** (créé au S1) :
  - `pub fn home_dir() -> Option<PathBuf>` (`USERPROFILE` sous Windows, `HOME` ailleurs)
  - `pub const OS: &str` (`"windows" | "macos" | "linux"`)
  - commande Tauri `platform_os() -> &'static str`, enregistrée dans `lib.rs`
- **TS `src/platform.ts`** (créé au S3) :
  - `export const IS_MAC: boolean` (calculé une fois au démarrage via `invoke('platform_os')`, avec repli sur `navigator.userAgent`)
  - `export function isMod(e: KeyboardEvent | MouseEvent): boolean` (`metaKey` sur Mac, `ctrlKey` ailleurs)
  - `export function modLabel(): string` (`"⌘"` ou `"Ctrl"`)
  - `export function fileManagerName(): string` (`t("Finder","Finder")` ou `t("Explorer","l'Explorateur")`)
- **Détection des shells** (S2) : même forme de retour que `shells.detect()` aujourd'hui, plus un champ `elevatable: boolean` (faux sur Mac). L'interface du S3 masque le bouton d'élévation quand il vaut faux.
- **Client RDP externe** (S2) : la valeur `client` existante (`"mstsc"`) est conservée dans les sessions. Sur Mac, elle déclenche Windows App. L'interface du S3 adapte seulement le libellé.
- **Biométrie** (S4) : la commande existante `hello_available` / déverrouillage Hello est généralisée en `biometric_kind() -> "hello" | "touchid" | null` (l'ancienne commande reste comme alias).

## 13. Architecture Invariant Registry

| Concept | Owner | Format/Values | Verify Command |
| --- | --- | --- | --- |
| Config Windows intacte | packaging | `tauri.conf.json` toujours avec `nsis`, sans section macOS | `grep -q '"nsis"' src-tauri/tauri.conf.json && ! grep -q '"macOS"' src-tauri/tauri.conf.json` |
| Pas de dépendance Windows inconditionnelle | Cargo | `winreg` et `windows` uniquement sous `cfg(windows)` | voir INVARIANTS.md |
| Pas de secret en log | sécurité | aucun `log!`/`println!` d'une variable `password`/`passphrase`/`key` | voir INVARIANTS.md |
| Raccourcis via `isMod` | interface | plus de `e.ctrlKey` seul dans `src/*.ts` hors `platform.ts`/`rdpkeys.ts` | voir INVARIANTS.md |
| Plateformes de `latest.json` | release | la tâche Mac `needs: windows` | `grep -q 'needs: *\[\?windows' .github/workflows/release.yml` |

## 14. Open Questions

Toutes les questions ont une valeur par défaut, ce qui permet de lancer l'exécution sans ambiguïté :
- [x] **Branches de sprint** (`feat/macos-sN`) : poussées vers `origin` pour déclencher `macos-build.yml`, puis fusionnées par PR. Ni `main` ni tag `v*` ne sont jamais poussés directement. Si la CI est indisponible, les critères CI sont marqués BLOCKED, jamais PASS.
- [x] Windows App : on utilise le bundle id `com.microsoft.rdc.macos` (`open -b`), plus stable que le nom. Le message d'erreur S2 couvre son absence. À confirmer pendant la recette.
- [x] Updater Mac : `.app.tar.gz` ne demande pas la feature `zip`. Si la CI du S5 montre le contraire → STOP (zone sensible).

## 15. Uncertainty Policy

- **STOP et demander :** coffre, Trousseau, Touch ID (`lock.rs`, `vault.rs`, `secrets.rs`). **Exemption :** le S1 peut y ajouter des gates `cfg` ou des stubs d'erreur, sans changer aucune logique existante ; mise à jour automatique et `release.yml`, ainsi que toute nouvelle dépendance hors §8.
- **Noter l'hypothèse et continuer :** interface, textes, shells, réseau, packaging hors release.
- Si la parité Mac entre en conflit avec le comportement Windows, **le comportement Windows l'emporte**, et on ajoute une branche Mac à côté.

## 16. Verification

- **Automatique :**
  - `cargo test --manifest-path src-tauri/Cargo.toml` et `cargo test --manifest-path rdp-helper/Cargo.toml` en local sur le Mac, puis en CI sur `windows-latest` et `macos-latest`
  - `npm run build` (`tsc` + `check-i18n` + vite)
  - `npm run tauri build -- --target universal-apple-darwin` sur `macos-latest`
  - commandes de vérification d'INVARIANTS.md
- **Manuelle :** la grille `docs/recette-macos.md` (créée au S5), à dérouler sur le Mac Apple Silicon **et** sur le Mac Intel. Elle couvre chaque protocole, les shells, le clavier, Touch ID, la mise à jour depuis la version N-1 et la première installation (Gatekeeper).

## 17. Sprint Decomposition

| Sprint | Title | Depends On | Batch | Model | Parallel With |
| --- | --- | --- | --- | --- | --- |
| 1 | Compilation macOS + CI de build | None | 1 | sonnet | — |
| 2 | Couche système Mac | 1 | 2 | sonnet | Sprint 3 |
| 3 | Interface et clavier Mac | 1 | 2 | sonnet | Sprint 2 |
| 4 | Trousseau et Touch ID | 1, 3 | 3 | sonnet | — |
| 5 | Packaging universel, release, recette | 2, 3, 4 | 4 | sonnet | — |

Fiches de sprint : `sprints/01-compilation-macos.md` … `sprints/05-packaging-release.md`.

### Mitigations de sécurité par sprint et validations

| Sprint | Mitigations §10 qu'il porte | Validation |
| --- | --- | --- |
| 1 | Stubs = erreurs explicites (jamais de succès silencieux). Config Windows intacte | Auto. Exception §15 : dans `lock.rs` et `vault.rs`, seulement des gates `cfg` ou des stubs, sans toucher à la logique. Toute autre modification de ces fichiers → STOP |
| 2 | Shells validés (chemin absolu, existant, exécutable). `SSH_AUTH_SOCK` validé (socket `S_ISSOCK` appartenant à l'utilisateur). Jamais de `sh -c`. `.rdp` en 0600 sans mot de passe | Auto |
| 3 | Comportement Windows inchangé. Les touches transmises restent brutes | Auto |
| 4 | Clé lue seulement après un `evaluatePolicy` réussi. `Zeroizing`. Aucun secret en log. Revue `security-reviewer` | **Zone STOP** : arrêt et demande à l'utilisateur à la moindre ambiguïté. Revue de sécurité obligatoire avant fusion |
| 5 | Tâche Windows de `release.yml` inchangée (ajouts seulement). `latest.json` contrôlé. Aucun tag poussé | **Zone STOP** : le diff de `release.yml` est validé par l'utilisateur avant fusion |

## 18. Execution Log

Suivi dans `progress.json`.

## 19. Learnings

À remplir à la fin.
