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

- [ ] **Shells (`cfg(unix)`)** : lire `$SHELL`, puis `/etc/shells` (ignorer les commentaires et les lignes vides, garder les chemins absolus existants et exécutables, dédoublonner par nom de fichier en préférant `/opt/homebrew/bin` puis `/usr/local/bin`, `/bin` et `/usr/bin`). Ajouter zsh, bash et fish (Homebrew) s'ils existent. `$SHELL` est le shell par défaut. Le lancement se fait en shell de connexion : `argv[0]` préfixé par `-`, ou l'argument `-l` pour zsh, bash et fish. Ne jamais passer par `sh -c`
- [ ] Le dossier de départ est `platform::home_dir()`. Si elle renvoie `None`, utiliser `/`
- [ ] Variables d'env du PTY : `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG` hérité ou `en_US.UTF-8` par défaut si absent (sinon zsh affiche mal l'UTF-8)
- [ ] `open_elevated` sous Unix : renvoyer une erreur traduite (« Non disponible sur macOS : utilisez sudo dans le shell »), et `elevatable: false`
- [ ] Tests unitaires de l'analyse de `/etc/shells` (fonction pure prenant le texte en entrée : commentaires, doublons, lignes vides)
- [ ] **Agent SSH (`cfg(unix)`)** : se connecter à `SSH_AUTH_SOCK` via le client d'agent de russh-keys (`AgentClient::connect_uds`). Avant de se connecter, vérifier que le chemin est une socket Unix (`FileTypeExt::is_socket`) dont l'uid propriétaire (`MetadataExt::uid`) est celui de l'utilisateur courant (`libc::getuid` ou `nix`, déjà dans l'arbre, sinon STOP). Si la variable est absente ou que la vérification échoue, renvoyer une erreur claire et traduite. Test unitaire : un fichier ordinaire est refusé. Le chemin Windows reste inchangé
- [ ] **ICMP (`cfg(unix)`)** : `socket2::Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))` (et ICMPv6 pour les adresses IPv6), écho avec délai d'attente. Traceroute via `set_ttl` croissant, en lisant les réponses « Time Exceeded ». Garder la même forme de résultat que la version Windows. Tests unitaires de la construction et de l'analyse des paquets (fonctions pures)
- [ ] **Révéler** : macOS `open -R`, Linux `xdg-open` sur le dossier parent. Passer le chemin en argument, jamais dans une chaîne shell
- [ ] **RDP externe macOS** : écrire le `.rdp` temporaire comme aujourd'hui (même contenu, **sans mot de passe**), avec les droits 0600, puis `open -b com.microsoft.rdc.macos <fichier>`. Si la commande échoue (application absente), renvoyer une erreur traduite qui donne le lien App Store de Windows App. Supprimer le fichier après un délai, comme pour mstsc
- [ ] `rdp.rs:129` : le nom du binaire d'aide est déjà géré par `cfg!` : vérifier qu'il ne prend pas `.exe` sur Mac

## Acceptance Criteria

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passe en local sur le Mac, y compris les nouveaux tests (`/etc/shells`, paquets ICMP)
- [ ] En local sur le Mac, un test d'intégration `#[ignore]` lançable à la main, `cargo test -- --ignored ping_localhost`, envoie un ping à 127.0.0.1 avec succès. S'il échoue, c'est un vrai bug (macOS autorise l'ICMP datagramme)
- [ ] Les tâches `macos` et `windows` de la CI sont vertes (ou BLOCKED si la CI est indisponible)
- [ ] Aucun `Command::new("sh")`, `"-c"` ou interpolation de chemin dans une chaîne shell n'est ajouté (`git diff` ne contient pas `"-c"`)

## Verification

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml` sans nouveau warning dans les fichiers modifiés
- [ ] commandes de vérification d'INVARIANTS.md

> **Note :** le smoke test du serveur de dev et la vérification du contenu sont faits par l'orchestrateur après fusion. Les sprint-executors ne font que de la vérification statique.

## Context

- Shells Windows actuels (`local.rs:95-125`) : pwsh, Windows PowerShell, cmd, WSL, Git Bash. PTY via `portable-pty::native_pty_system()`, qui fonctionne tel quel sous Unix (openpty).
- `CREATE_NO_WINDOW` (`local.rs:56-60,206-209`, `rdp.rs:205-209`) est déjà sous `cfg(windows)`.
- Agent SSH actuel : `ssh.rs:578-588` (pipe `\\.\pipe\openssh-ssh-agent`, puis `connect_pageant`).
- macOS autorise `SOCK_DGRAM` + `IPPROTO_ICMP` sans root. Le noyau réécrit l'identifiant ICMP : comparer les réponses par numéro de séquence, pas par identifiant.
- Politique d'incertitude : réseau et shells → noter l'hypothèse et continuer. Si russh-keys n'expose pas de client UDS : STOP et demander (pas de nouvelle dépendance sans accord).

## Agent Notes (filled during execution)

- Assigned to:
- Started:
- Completed:
- Decisions made:
- Assumptions:
- Issues found:
