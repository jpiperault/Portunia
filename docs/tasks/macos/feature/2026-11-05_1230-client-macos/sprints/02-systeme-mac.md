# Sprint 2: Couche système Mac

## Meta

- **PRD:** `../spec.md`
- **Sprint:** 2 of 5
- **Depends on:** Sprint 1
- **Batch:** 2 (parallel with Sprint 3, aucun fichier en commun)
- **Model:** sonnet
- **Estimated effort:** M

## Objective

Donner au backend les équivalents Mac de ce qui est propre à Windows : shells locaux, agent SSH, ping et traceroute, « Afficher dans le Finder », client RDP externe (Windows App).

## File Boundaries

### Creates (new files)

- `src-tauri/src/connectors/local_unix.rs` : détection des shells Unix (à garder séparé si `local.rs` dépasse ~450 lignes, sinon il peut rester vide et être supprimé, à noter dans les Agent Notes)

### Modifies (can touch)

- `src-tauri/src/connectors/local.rs` : branche `cfg(unix)` pour `detect()`, shell de connexion, `elevatable`
- `src-tauri/src/connectors/mod.rs` : déclarer `local_unix` si créé
- `src-tauri/src/connectors/ssh.rs` : agent `SSH_AUTH_SOCK` sous `cfg(unix)` (lignes ~578-588)
- `src-tauri/src/nettools.rs` : ping et traceroute `cfg(unix)` via `socket2`
- `src-tauri/src/localfs.rs` : `local_reveal` sous macOS → `open -R <chemin>` (fichier) ou `open <dossier>`. Fichiers cachés Unix = nom commençant par `.`
- `src-tauri/src/connectors/rdp.rs` : client externe sous macOS = Windows App
- `src-tauri/Cargo.toml` : `socket2` en dépendance directe (version déjà dans `Cargo.lock`, features `all`), sous `[target.'cfg(unix)'.dependencies]`

### Read-Only (reference but do NOT modify)

- `src-tauri/src/platform.rs` (S1) : `home_dir()`, `OS`
- `src-tauri/src/lib.rs` : **ne pas modifier** (le S3 le modifie en parallèle). Aucune nouvelle commande n'est nécessaire, toutes existent déjà
- `src/localshells.ts`, `src/files.ts` : comprendre les formes de données attendues, **ne pas modifier** (S3)

### Shared Contracts

- `shells.detect()` : même forme qu'aujourd'hui, plus `elevatable: bool` (`true` pour les shells Windows existants, `false` sur Unix). Le champ est ajouté sans en supprimer aucun
- Valeur `client` RDP : `"mstsc"` est conservée. Sur macOS, elle ouvre Windows App

### Consumed Invariants

- Pas de secret en log
- Pas de dépendance Windows inconditionnelle

## Tasks

- [x] **Shells (`cfg(unix)`)** : lire `$SHELL`, puis `/etc/shells` (ignorer les commentaires et les lignes vides, garder les chemins absolus existants et exécutables, dédoublonner par nom de fichier en préférant `/opt/homebrew/bin` puis `/usr/local/bin`, `/bin` et `/usr/bin`). Ajouter zsh, bash et fish (Homebrew) s'ils existent. `$SHELL` est le shell par défaut. Le lancement se fait en shell de connexion : `argv[0]` préfixé par `-`, ou l'argument `-l` pour zsh, bash et fish. Ne jamais passer par `sh -c`
- [x] Le dossier de départ est `platform::home_dir()`. Si elle renvoie `None`, utiliser `/`
- [x] Variables d'env du PTY : `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG` hérité ou `en_US.UTF-8` par défaut si absent (sinon zsh affiche mal l'UTF-8)
- [x] `open_elevated` sous Unix : renvoyer une erreur traduite (« Non disponible sur macOS : utilisez sudo dans le shell »), et `elevatable: false`
- [x] Tests unitaires de l'analyse de `/etc/shells` (fonction pure prenant le texte en entrée : commentaires, doublons, lignes vides)
- [x] **Agent SSH (`cfg(unix)`)** : se connecter à `SSH_AUTH_SOCK` via le client d'agent de russh-keys (`AgentClient::connect_uds`). Avant de se connecter, vérifier que le chemin est une socket Unix (`FileTypeExt::is_socket`) dont l'uid propriétaire (`MetadataExt::uid`) est celui de l'utilisateur courant (`libc::getuid` ou `nix`, déjà dans l'arbre, sinon STOP). Si la variable est absente ou que la vérification échoue, renvoyer une erreur claire et traduite. Test unitaire : un fichier ordinaire est refusé. Le chemin Windows reste inchangé
- [x] **ICMP (`cfg(unix)`)** : `socket2::Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))` (et ICMPv6 pour les adresses IPv6), écho avec délai d'attente. Traceroute via `set_ttl` croissant, en lisant les réponses « Time Exceeded ». Garder la même forme de résultat que la version Windows. Tests unitaires de la construction et de l'analyse des paquets (fonctions pures)
- [x] **Révéler** : macOS `open -R`, Linux `xdg-open` sur le dossier parent. Passer le chemin en argument, jamais dans une chaîne shell
- [x] **RDP externe macOS** : écrire le `.rdp` temporaire comme aujourd'hui (même contenu, **sans mot de passe**), avec les droits 0600, puis `open -b com.microsoft.rdc.macos <fichier>`. Si la commande échoue (application absente), renvoyer une erreur traduite qui donne le lien App Store de Windows App. Supprimer le fichier après un délai, comme pour mstsc
- [x] `rdp.rs:129` : le nom du binaire d'aide est déjà géré par `cfg!` : vérifier qu'il ne prend pas `.exe` sur Mac

## Acceptance Criteria

- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passe en local sur le Mac, y compris les nouveaux tests (`/etc/shells`, paquets ICMP)
- [x] En local sur le Mac, un test d'intégration `#[ignore]` lançable à la main, `cargo test -- --ignored ping_localhost`, envoie un ping à 127.0.0.1 avec succès. S'il échoue, c'est un vrai bug (macOS autorise l'ICMP datagramme)
- [ ] (BLOCKED : CI non exécutable depuis l'agent, à vérifier après push) Les tâches `macos` et `windows` de la CI sont vertes (ou BLOCKED si la CI est indisponible)
- [x] Aucun `Command::new("sh")`, `"-c"` ou interpolation de chemin dans une chaîne shell n'est ajouté (`git diff` ne contient pas `"-c"`)

## Verification

- [x] `cargo test --manifest-path src-tauri/Cargo.toml`
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml` sans nouveau warning dans les fichiers modifiés
- [x] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- Shells Windows actuels (`local.rs:95-125`) : pwsh, Windows PowerShell, cmd, WSL, Git Bash. PTY via `portable-pty::native_pty_system()`, qui fonctionne tel quel sous Unix (openpty).
- `CREATE_NO_WINDOW` (`local.rs:56-60,206-209`, `rdp.rs:205-209`) est déjà sous `cfg(windows)`.
- Agent SSH actuel : `ssh.rs:578-588` (pipe `\\.\pipe\openssh-ssh-agent`, puis `connect_pageant`).
- macOS autorise `SOCK_DGRAM` + `IPPROTO_ICMP` sans root. Le noyau réécrit l'identifiant ICMP : comparer les réponses par numéro de séquence, pas par identifiant.
- Politique d'incertitude : réseau et shells → noter l'hypothèse et continuer. Si russh-keys n'expose pas de client UDS : STOP et demander (pas de nouvelle dépendance sans accord).

## Agent Notes (filled during execution)

- Assigned to: sprint-executor (sonnet), branche `feat/macos-s2`
- Started: 2026-11-05
- Completed: 2026-11-05 (hors CI, voir Issues)
- Decisions made:
  - `local_unix.rs` créé (local.rs aurait dépassé ~450 lignes). Fonctions pures : `parse_etc_shells`, `dedupe_by_name`, `select_shells`, `login_args`, `pty_env`. `$SHELL` est placé en premier (shell par défaut) et son chemin exact est conservé au dédoublonnage.
  - Shell de connexion : `-l` pour zsh, bash et fish uniquement. `portable-pty::CommandBuilder` n'expose pas `argv[0]` : l'option « préfixe `-` » n'est pas utilisée. Les autres shells (sh, ksh, tcsh…) démarrent sans option.
  - `ShellSpec.elevatable` : `#[serde(default = ...)]` vaut `true` sous Windows et `false` sous Unix. Les ShellSpec envoyés par l'interface sans ce champ gardent donc le comportement Windows existant.
  - Agent SSH : `libc` ajouté en dépendance directe sous `[target.'cfg(unix)']` (déjà dans Cargo.lock, 0.2.191, aucun nouveau code tiers), pour `libc::getuid`. `socket2` 0.6 (déjà au lock) ajouté de la même façon. Diff de Cargo.lock : 2 lignes. `try_agent` et l'import `AgentClient` ne sont plus limités à Windows.
  - ICMP : `echo()` garde sa signature IPv4. Ajout de `echo_ip(IpAddr, ...)` (ICMPv6 inclus) avec `#[allow(dead_code)]` : `commands.rs` (hors périmètre) n'envoie que de l'IPv4 via `resolve_v4`. Le champ `ttl` de `Echo::Reply` vient de l'en-tête IP que macOS laisse devant la réponse ; absent (Linux) il vaut 0.
  - RDP macOS : le fichier `.rdp` est écrit en 0600 (resserré même s'il existait), `open -b com.microsoft.rdc.macos <fichier>` puis suppression après 60 s. Sous Linux : erreur traduite (pas de client externe). Le libellé du choix `mstsc` devient « Windows App » sous macOS (valeur `"mstsc"` inchangée).
  - Spec dit « supprimer le fichier après un délai, comme pour mstsc » : le chemin Windows actuel ne supprime rien. Je n'ai pas changé le comportement Windows ; la suppression ne s'applique qu'à macOS.
  - `localfs.rs` : `home_dir()` partout, racine Unix `/` à la place de la liste des lecteurs, fichiers cachés = nom commençant par `.`, repli `/` au lieu de `C:\`. `local_reveal` refuse un chemin relatif sous Unix (évite qu'un chemin en `-` soit pris pour une option de `open`).
  - `ssh.rs` : `default_key` et `openssh_fingerprints` passent par `platform::home_dir()`.
  - Tous les edits des fichiers existants ont été faits par script (le formateur automatique du hook réécrivait des fichiers entiers et aurait pollué le diff).
- Assumptions:
  - 🟢 macOS autorise ICMP en datagramme : confirmé (`ping_localhost` et `ttl_expire_vers_internet` passent en local).
  - 🟢 Les réponses macOS contiennent l'en-tête IPv4 ; l'analyse accepte les deux cas (avec ou sans).
  - 🟡 ICMPv6 : somme de contrôle laissée au noyau, chemin non testé sur un vrai réseau (tests unitaires des paquets seulement).
  - 🟡 Identifiant App Store de Windows App : `id1295203466`.
  - 🟡 `open -b` renvoie un code non nul quand le bundle est absent (comportement connu, non testé ici faute de pouvoir désinstaller l'application).
- Issues found:
  - `src-tauri/src/keys.rs:35` lit encore `USERPROFILE` en dur : hors périmètre du sprint, à passer par `crate::platform::home_dir()` (reste à faire par l'orchestrateur ou un autre sprint ; sous macOS, l'import de clés échouera avec « Dossier personnel introuvable »).
  - Avertissements clippy et dead_code préexistants (`importers.rs`, `commands.rs`, `sftp.rs`, `vnc.rs`, `ssh.rs:428` et `:976`) : aucun nouveau dans les fichiers modifiés.
  - CI `macos`/`windows` : non exécutable depuis l'agent (BLOCKED). La compilation Windows des branches `cfg(windows)` modifiées n'est pas vérifiée localement (`detect()`, `open_elevated`, `write_rdp_file`, `launch_external_client`, `hidden`, `drives`, `local_reveal`).
  - `npm run build` a d'abord échoué faute de `node_modules` dans le worktree ; `npm ci` l'a résolu.

### Corrections après revue de code (APPROVE avec réserves)

- `ssh.rs` (`connect_agent_socket`, `check_peer_uid`) : connexion à la socket d'abord, puis `peer_cred().uid()` comparé à `getuid()` sur la socket connectée (plus de TOCTOU). `check_agent_socket` reste comme erreur précoce.
- `nettools.rs` (`verdict`, `next_seq`) : un écho n'est accepté que de la cible elle-même ; une erreur (TTL expiré, injoignable) doit citer notre séquence, sinon elle est ignorée. Séquence aléatoire (`ring::rand`).
- `rdp.rs` : dossier `rdp/` en 0700, fichier `create_new` 0600 après `remove_file`, nom unique par lancement, purge des `.rdp` de plus de 60 s au lancement suivant (non-Windows uniquement ; Windows inchangé).
- `localfs.rs` : `validate_reveal_path` (absolu + existant, erreur traduite) et `child.wait()` dans un thread (plus de zombie) ; Windows inchangé.
- `local.rs` : repli de `home()` sur `/` sous Unix, `.` sous Windows.
- `keys.rs:35` (hors liste, autorisé par l'orchestrateur, bug hérité du S1) : `ssh_dir()` passe par `crate::platform::home_dir()`, même message d'erreur.
- Suivis laissés en l'état : `$SHELL` hors `/etc/shells`, nologin/false sous Linux, traceroute Linux sans `IP_RECVERR`, description du manifest RDP, message `Detached` en français seul.
