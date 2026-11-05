# Portunia

[English](README.md) · **Français**

Gestionnaire de sessions distantes pour Windows : toutes vos connexions (SSH, Bureau à distance, consoles web, Telnet…) dans une seule fenêtre. Léger (Tauri 2 + Rust, interface sans framework) et extensible (un protocole = une extension).

Portunia s'appelait **Termoria** jusqu'à la version 0.39. La mise à jour vers Portunia retire l'ancienne application et reprend ses données (sessions, coffre, réglages), copiées au premier lancement ; l'ancien dossier `fr.termoria.app` reste comme copie de secours. La Gate SSH **Portunia Gate** s'intègre comme une extension (voir ci-dessous).

## Installer Portunia

Téléchargez `Portunia_x.y.z_x64-setup.exe` dans les [Releases](https://github.com/jpiperault/Portunia-releases/releases) et lancez-le. L'installateur demande s'il faut installer pour vous seul (sans droits administrateur) ou pour tous les utilisateurs du PC (une demande administrateur) ; une mise à jour garde le mode choisi la première fois. Portunia se met ensuite à jour tout seul : une bannière propose chaque nouvelle version.

## Installer les outils de développement (une seule fois)

1. **Outils de compilation C++ de Visual Studio** : installez « Build Tools for Visual Studio » et cochez « Développement Desktop en C++ ».
2. **Rust** : installez `rustup` depuis https://rustup.rs (choisissez la chaîne `stable-x86_64-pc-windows-msvc`).
3. **Node.js LTS** : https://nodejs.org
4. WebView2 est déjà présent sur Windows 11.

## Lancer en développement

```bash
npm install
npm run tauri dev
```

La première compilation Rust prend quelques minutes, les suivantes sont rapides. Le moteur RDP (`rdp-helper/`) est compilé automatiquement au lancement.

## Publier une version

1. Mettre à jour le numéro de version dans `package.json`, `src-tauri/Cargo.toml` et `src-tauri/tauri.conf.json`.
2. Committer, puis pousser un tag `vX.Y.Z` :
   ```bash
   git tag v0.13.0
   git push origin main --tags
   ```
3. GitHub Actions (`.github/workflows/release.yml`) compile l'installateur, le signe et publie la release dans le dépôt **public** `jpiperault/Portunia-releases` (le code reste privé), avec `latest.json` que Portunia consulte pour se mettre à jour. Secret supplémentaire : `RELEASES_TOKEN`, jeton d'accès avec le droit « Contents : Read and write » sur ce dépôt.

La signature utilise la clé `~/.tauri/termoria.key` (nom d'origine, gardé) (secrets `TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` du dépôt). La clé publique est dans `tauri.conf.json`. **Ne perdez pas la clé privée** : sans elle, les versions installées ne peuvent plus être mises à jour.

Pour produire l'installateur localement : définir `TAURI_SIGNING_PRIVATE_KEY` (chemin ou contenu de la clé) et son mot de passe, puis `npm run tauri build`. L'installateur est dans `src-tauri/target/release/bundle/nsis/`.

## Fonctionnalités

| Protocole | Affichage | Remarques |
|---|---|---|
| SSH | Onglet terminal | Clé privée, mot de passe ou agent (Pageant / OpenSSH). Serveur de rebond (comme ProxyJump) : une session SSH enregistrée ou `utilisateur@hôte:port`, jusqu'à 3 rebonds enchaînés (`bastion1,bastion2`), repris de ~/.ssh/config à l'import. Les clés des serveurs sont mémorisées à la première connexion, et une clé qui change bloque la connexion. SSH-2 uniquement, compatible OpenSSH 10. Option « Compatibilité anciens équipements » pour les serveurs qui n'acceptent que des algorithmes anciens (diffie-hellman-group1/14-sha1, aes-cbc, 3des-cbc, hmac-sha1, ssh-dss) : ils ne sont utilisés qu'en dernier recours, avec un avertissement dans le terminal. |
| Bureau à distance (RDP) | Onglet écran (IronRDP) ou client Windows | Dans un onglet avec le moteur IronRDP (authentification NLA, compte de domaine, presse-papiers partagé, copie de fichiers par boutons ou glisser-déposer, écran adapté automatiquement à la taille de l'onglet), ou dans le client Bureau à distance de Windows au choix. |
| Interface web | Fenêtre dédiée | La fenêtre web n'a aucun accès à l'application. |
| Telnet | Onglet terminal | Non chiffré : à réserver au réseau local. |
| VNC | Onglet écran | Clavier, souris, molette, presse-papiers dans les deux sens, Ctrl+Alt+Suppr, ajustement à la fenêtre. Encodages Tight, ZRLE, CopyRect, Raw. |
| Shell local | Onglet terminal | PowerShell 7, Windows PowerShell, Invite de commandes, distributions WSL, Git Bash et shells personnalisés, via la console de Windows Terminal livrée avec Portunia (OpenConsole, plus rapide que celle du système : écho de la frappe 47 → 17 ms, sorties volumineuses 11 → 38 Mo/s). Section « Ce PC », menu « + », Ctrl+Maj+T. |
| Gate (extension) | Onglet terminal | Section « Gates » de la barre latérale : on ajoute une Gate [Portunia Gate](https://github.com/jpiperault/Portunia-Gate) (empreinte du certificat vérifiée, mot de passe et code, première connexion avec mot de passe provisoire et enrôlement du code par code QR). Les serveurs autorisés s'affichent par dossier ; chaque ouverture utilise un jeton à usage unique, sans retaper le code. Modes coffre (compte fourni par la Gate), enregistré (identifiants demandés dans le terminal) et rebond (de bout en bout). Serveurs Windows (badge RDP) : ouverts dans un onglet Bureau à distance à travers la Gate, en rebond (Gate 0.6, connexion chiffrée de bout en bout) ou enregistré (Gate 0.8, passage RDCleanPath : la Gate relaie et enregistre la session sans voir le mot de passe) ; identifiants Windows demandés à l'ouverture et jamais gardés. Signale les sessions qui contournent la Gate. Dans Portunia Équipes : administration de la Gate (serveurs et coffre, comptes, groupes, règles, réglages) et audit (menu « Audit » de la Gate) : relecture des sessions comme une vidéo, avec la frappe en sous-titres, les pauses sautées, les commandes sensibles repérées, la recherche dans toutes les sessions, les mots de passe tapés masqués (révélables par un administrateur), l’export .cast ou en transcription, et le journal vérifié. Option de la Gate : chaque compte relit ses propres sessions (« Mes sessions »). Portail web de la Gate (Portunia Gate 0.7 et suivants) : Administrer › Portail web, un interrupteur pour l’activer ou le couper (les sessions web en cours se ferment), l’adresse publique, le groupe autorisé, les durées, le copier-coller, les clés Turnstile et le bouton « Fermer toutes les sessions web ». Modes d'exposition (interne ou VPN, tunnel Cloudflare lancé par la Gate, HTTPS direct, proxy ou WAF, relais dédié en DMZ), écoute HTTPS, certificat du portail (PEM ou PFX importé, ou Let's Encrypt avec renouvellement) et état du durcissement facultatif de la Gate se règlent depuis ce même écran (Gate 0.17 à 0.21). Activable dans Extensions. Installation de la Gate (assistant `installer.sh`) et ajout dans Portunia pas à pas : [README de Portunia Gate](https://github.com/jpiperault/Portunia-Gate/blob/main/README.fr.md#installer). |
| Assistance à distance (extension, demande Portunia Gate 0.11) | Onglet Bureau à distance | Prendre la main sur le PC d'un proche ou d'un client. La personne va sur la page de la Gate (`https://votre-portail/assistance`), télécharge **Portunia Assistance** (sans installation ni compte) et vous lit un code à 9 chiffres ; vous le tapez dans « Assistance à distance » de la barre latérale. Elle voit votre nom et choisit : voir seulement, ou voir et contrôler. Un cadre et une barre « Arrêter » restent sur son écran ; Échap trois fois arrête aussi. La Gate ne fait que relayer : la liaison est chiffrée de bout en bout à partir du code (SPAKE2, ChaCha20-Poly1305), et le code ne sert qu'une fois. Administrer › Assistance : interrupteur, groupe des dépanneurs, durée maximale, journal d'audit de chaque assistance. |
| SFTP (catalogue) | Onglet fichiers à deux volets | Fichiers par SSH sans terminal : mêmes authentifications que SSH (clé, agent, mot de passe, identifiants partagés), rebond et Gate, dossiers de départ sur le serveur et sur ce PC. Clic droit sur une session SSH › « Ouvrir en fichiers seulement (SFTP) » reprend ses réglages. À installer depuis Extensions › Catalogue. |
| FTP / FTPS (catalogue) | Onglet fichiers à deux volets | FTPS explicite par défaut, FTPS implicite (port 990), mode passif ou actif, noms en Windows-1252 pour les anciens serveurs. Reprise de session TLS (exigée par FileZilla Server et vsftpd), certificats vérifiés par Windows ; certificat auto-signé accepté sur demande. Connexion rouverte d'elle-même après inactivité. `ftps://user@hôte` en connexion rapide. Installée d'office pour qui a déjà des sessions FTP. |
| Stockage S3 (Pro) | Onglet fichiers à deux volets | Amazon S3 et services compatibles (MinIO, Scaleway, OVH, Wasabi, Cloudflare R2…) : compartiments, dossiers, envoi et téléchargement (jusqu'à 5 Go par fichier), renommage et suppression de dossiers entiers. Adressage par chemin pour MinIO / Ceph. Client intégré (signature AWS SigV4), sans le SDK d'Amazon. |
| Port série | Onglet terminal | Ports COM détectés automatiquement, vitesse, parité, contrôle de flux, fin de ligne. |

Autres fonctions :

- sessions de fichiers à deux volets (SFTP, FTP, S3) : ce PC à gauche, le serveur à droite, → / F5 pour envoyer et ← / F6 pour récupérer, sélection multiple, fichiers masqués, droits Unix, file de transferts avec débit, pause et règle « si le fichier existe » (demander, remplacer si plus récent, remplacer, ignorer) ; les copies gardent la date de l'original (SFTP, FTP avec MFMT) ;
- comparer et synchroniser deux dossiers (Pro) : comparaison récursive par date et taille ou taille seule, motifs d'exclusion, envoi, récupération ou les deux sens, écarts à trancher signalés, suppression facultative sur le serveur, rien n'est copié avant confirmation ;
- catalogue d'extensions (page Extensions) : SFTP et FTP s'installent en un clic ; WebDAV, partages Windows, Azure Blob et Google Cloud Storage suivront ;
- barre latérale : rail d'activités (Sessions, Gates, Ce PC, outils), puces de filtre par protocole et état, sessions épinglées et récentes, onglet « Toutes les sessions en tableau » (tri, filtres, sélection multiple) ; barre de session sur une ligne, repliée dans un menu « ⋯ » sur petit écran, panneaux latéraux (fichiers, notes, serveur, conteneurs) propres à chaque onglet et fermés à l'ouverture d'une session ;
- fenêtre « Connexion rapide » (bouton à côté de « Nouvelle session », Ctrl+Maj+Q, ou une adresse seule comme `10.0.0.12` dans la recherche puis Entrée) : seule l’adresse est obligatoire ; protocole, identifiant, port, mot de passe, clé et rebond sont des options facultatives. En SSH, ce qui manque se tape dans le terminal comme avec PuTTY (`login as:`, puis le mot de passe masqué si la clé et l’agent sont refusés). Rien n’est enregistré ;
- session SSH enregistrée sans identifiant ou sans mot de passe : ils se tapent dans le terminal à chaque connexion (Ctrl+C annule) ;
- connexion rapide sans créer de session : tapez `ssh deploy@10.0.1.12`, `rdp srv-01`, `vnc nas:5901`, `https://nas:5001` ou `COM3@9600` dans la recherche puis Entrée, ou dans la palette (Ctrl+Maj+O). En SSH, clé par défaut puis agent, sinon le mot de passe est demandé (et jamais enregistré). Historique des connexions récentes, bouton « Enregistrer comme session » ;
- clés SSH : création Ed25519 ou RSA 4096 dans ~/.ssh (phrase secrète conseillée), copie de la clé publique, installation sur le serveur de l'onglet en un clic (authorized_keys et droits corrigés), puis la session passe à l'authentification par clé (bouton « Clé SSH » ou palette) ;
- notes par session en Markdown (bouton « Notes », panneau de droite) : titres, listes, cases à cocher cliquables, liens, blocs de code envoyés au terminal d'un clic ; enregistrement automatique, repère dans l'arbre, incluses dans la sauvegarde Portunia ;
- outils réseau (onglet, palette ou clic droit sur une session) : ping et traceroute sans droits administrateur, test de ports TCP (listes et plages, services reconnus), résolution DNS, Wake-on-LAN (adresse MAC enregistrée sur la session, « Réveiller » au clic droit) ;
- identifiants partagés : un compte (utilisateur, mot de passe, clé ou agent, domaine) choisi dans plusieurs sessions SSH, RDP ou VNC ; on change le mot de passe une fois, toutes suivent ;
- palette globale (Ctrl+Maj+O) : aller à une session, un shell local ou une action en quelques lettres ;
- arbre des sessions avec dossiers et sous-dossiers (dossiers vides possibles), glisser-déposer pour ranger, menu clic droit (dupliquer, ouvrir tout un dossier…), recherche (Ctrl+Maj+K), onglets ;
- mise en évidence dans le terminal : erreurs en rouge, avertissements en orange, succès en vert, adresses IP en cyan ; règles modifiables (mot, expression régulière, couleur ou fond) dans Paramètres, sans effet sur vim, htop ni les enregistrements ;
- terminal : recherche dans l'historique (Ctrl+Maj+F), police et taille réglables (Ctrl + molette), copier/coller au clic droit, liens ouverts par Ctrl+clic ;
- écran partagé (jusqu'à 4 sessions côte à côte) et saisie multiple (Ctrl+Maj+B) pour taper la même chose sur plusieurs serveurs ;
- commandes enregistrées (Ctrl+Maj+P) : par session, par dossier ou pour toutes, avec variables {{host}}, {{username}}… ;
- tunnels SSH : port local (ssh -L), proxy SOCKS5 (ssh -D) et port du serveur vers ce PC (ssh -R), ouverts à la connexion ou à la demande, n'écoutant que sur les boucles locales ; repris de ~/.ssh/config et de PuTTY ;
- X11 : les applications graphiques lancées sur le serveur s'affichent sur ce PC (avec VcXsrv ou X410) ;
- reconnexion automatique après une coupure réseau ou une mise en veille (désactivable dans les Paramètres) ;
- explorateur de fichiers du serveur (SFTP) à droite des sessions SSH : navigation, envoi et téléchargement de fichiers ou de dossiers entiers (glisser-déposer compris), édition d'un fichier distant dans votre éditeur avec renvoi automatique à chaque enregistrement, création, renommage, suppression, suivi des transferts ;
- import depuis ~/.ssh/config, PuTTY et mRemoteNG (avec aperçu et détection des doublons), sauvegarde et restauration Portunia ;
- langue : anglais ou français, selon Windows (Paramètres › Apparence pour choisir) ;
- apparence : thème sombre, clair ou comme Windows, 9 palettes de terminal (Dracula, Nord, Solarized…), couleur par dossier (bandeau sur les sessions, onglets et barre d'outils, étiquette « PRODUCTION ») ;
- tableau de bord du serveur (Pro, sessions SSH vers Linux) : processeur et mémoire avec courbes, swap, charge, disques, processus les plus actifs, services systemd en échec (« Voir » affiche leur journal), relevé toutes les 5 s quand le panneau est visible ;
- commande sur plusieurs serveurs (Pro) : choix des sessions SSH ou d'un dossier entier (clic droit), commande ou commande enregistrée, 8 serveurs à la fois, résultats côte à côte (code de sortie, durée, sortie, filtre des échecs, copie), confirmation renforcée pour les dossiers rouges ;
- Proxmox VE (Pro) : les serveurs Proxmox dans leur section de la barre latérale — nœuds, machines virtuelles et conteneurs avec leur état, assistants de création (VM : ISO, Windows 11 avec UEFI et TPM, VirtIO ; CT : modèles téléchargés depuis le catalogue Proxmox, IP fixe ou DHCP), démarrer/arrêter, consoles (VNC de Proxmox relayé par Portunia), instantanés, sauvegardes et restauration, clonage, migration, ressources, tâches et stockages ; gestion des nœuds : redémarrer et éteindre, mises à jour des paquets (apt dist-upgrade dans le shell du nœud), services, journal système, réseau et disques (SMART) en lecture ; jeton d'API ou mot de passe, certificat épinglé par son empreinte ;
- conteneurs (Pro, sessions SSH) : conteneurs Docker ou Podman et pods Kubernetes du serveur, shell dans un conteneur ou suivi des journaux en un clic (nouvel onglet), démarrer, arrêter, redémarrer ;
- supervision : pastille verte ou rouge et latence pour chaque serveur, vue d'ensemble, notifications quand un serveur tombe ou revient (Pro) ;
- enregistrement des sessions terminal (Pro) : fichiers asciicast + texte, lecteur intégré avec vitesse et navigation ;
- verrouillage par mot de passe maître et Windows Hello, au démarrage et après inactivité (Ctrl+Maj+L) ;
- éditions Gratuit / Pro / Équipes, licences signées vérifiées hors ligne (Paramètres › Licence) ;
- mots de passe rangés dans le Gestionnaire d'identifiants Windows, jamais en clair sur le disque ;
- sessions enregistrées dans `%APPDATA%\fr.portunia.app\sessions.json`.

Performances : la sortie des terminaux est regroupée côté cœur et envoyée en binaire (7 fois plus de débit avec une source réseau), le rendu passe par la carte graphique quand elle existe (Paramètres › Terminal), seules les lignes visibles sont colorées, et le code des écrans peu utilisés n'est chargé qu'à la demande. Scripts de mesure : `tools/bench`.

Raccourcis : Ctrl+Maj+N nouvelle session, Ctrl+Maj+W fermer l'onglet, Ctrl+Maj+F rechercher, Ctrl+Maj+C / Ctrl+Maj+V copier / coller dans le terminal, F2 renommer, Suppr supprimer.

## Sécurité

- **Mots de passe** dans le Gestionnaire d'identifiants Windows, jamais en clair sur le disque ; les sauvegardes et imports n'en contiennent pas.
- **Données chiffrées** dès qu'un mot de passe maître est défini : sessions, notes, identifiants partagés et empreintes des serveurs (AES-256-GCM, clé de données enveloppée par le mot de passe maître via PBKDF2, copie protégée par le compte Windows pour Windows Hello). Mot de passe oublié sans Windows Hello : données perdues, d'où les **sauvegardes protégées par une phrase de passe** (Importer / exporter).
- **Verrouillage** par mot de passe maître (PBKDF2, 600 000 itérations) ou Windows Hello : verrouillé, le cœur refuse toute action sensible (frappe dans un terminal, fichiers, export…) et l'interface est inerte ; essais limités (attente croissante après 5 échecs).
- **Serveurs SSH** : empreinte affichée et confirmée à la première connexion (ou reprise de `~/.ssh/known_hosts`), connexion bloquée si la clé change ; algorithmes anciens seulement sur demande.
- **Fichiers venus d'un serveur** : noms nettoyés (pas de `..\`, de flux NTFS ni de noms réservés) ; « Modifier » refuse les types que Windows exécuterait (.exe, .bat, .js, .lnk…).
- **Imports** : seules les valeurs prévues par le formulaire sont gardées (pas de commande cachée).
- **Terminal** : confirmation avant de coller plusieurs lignes ; liens ouverts seulement en http(s).
- **Interface** : politique de contenu stricte, fenêtres web sans accès à l'application, mises à jour signées.
- **Recette** : la liste des tests avant la vente est dans `docs/recette-avant-vente.html` ; le labo de test (serveurs jetables avec Docker Desktop) dans `tools/labo`.
- **Dépendances** : `cargo audit` et `npm audit` chaque semaine sur GitHub (`.github/workflows/securite.yml`) ; exception documentée dans `src-tauri/.cargo/audit.toml`.

## Architecture

```
src-tauri/src/       cœur (Rust)
  connector.rs       contrat d'une extension (trait Connector, manifeste, champs, vues)
  registry.rs        liste des extensions disponibles
  connectors/        une extension par fichier : ssh (et SFTP seul), rdp, vnc, web, telnet, serial,
                     ftp, s3, local (+ sftp.rs : fichiers par SSH, forward.rs : tunnels)
  commands.rs        commandes appelées par l'interface
  store.rs           sessions, dossiers, couleurs et commandes enregistrés (JSON)
  secrets.rs         Gestionnaire d'identifiants Windows
  importers.rs       import ssh config / PuTTY / mRemoteNG, sauvegarde
  license.rs         éditions et vérification des licences (point de contrôle unique)
  lock.rs            verrouillage (mot de passe maître, Windows Hello)
  recording.rs       enregistrement des sessions (asciicast, texte)
  monitor.rs         supervision (test de connexion TCP)
  transfer.rs        transferts de dossiers entiers, édition de fichiers distants
  localfs.rs         fichiers de ce PC (volet gauche des sessions de fichiers)
  filesync.rs        comparer un dossier de ce PC et un dossier du serveur (Pro)
  gate.rs            Gates (API à certificat épinglé, jetons à usage unique)
src/                 interface (TypeScript, sans framework)
  main.ts            arbre, onglets, écran partagé, barre d'outils
  dialog.ts          formulaire généré à partir du manifeste de l'extension
  terminal.ts        vue terminal (xterm.js)
  screen.ts          vue écran distant (canvas, clavier, souris)
  files.ts           explorateur de fichiers du serveur (panneau latéral, ou volet droit)
  filesview.ts       sessions de fichiers à deux volets (SFTP, FTP, S3)
  localpanel.ts      volet « Ce PC »
  transfers.ts       file de transferts
  syncdialog.ts      fenêtre « Comparer et synchroniser » (Pro)
  library.ts         onglet « Toutes les sessions en tableau »
  tree.ts            arbre des sessions (dossiers, glisser-déposer)
  menu.ts            menu contextuel
  settings.ts        paramètres de l'interface
  snippets.ts        commandes enregistrées (palette et gestion)
  tunnels.ts         tunnels SSH (éditeur et suivi)
  importexport.ts    import / export
  updates.ts         mises à jour automatiques
  security.ts        écran de verrouillage, licence
  recordings.ts      liste et lecteur des enregistrements
  monitoring.ts      supervision : pastilles, vue d'ensemble, alertes
  theme.ts           thèmes, palettes du terminal, couleurs de dossier
  localshells.ts     shells locaux : section « Ce PC » et réglages
  extensions.ts      page Extensions et catalogue
  gate.ts            extension Portunia Gate : barre latérale, connexion, administration
  audit.ts           audit Portunia Gate : sessions et journal
  assist.ts          assistance à distance : fenêtre « Nouvelle assistance » (code)
  auditplayer.ts     lecteur des sessions (sous-titres, repères, pauses sautées)
  rdpplayer.ts       lecteur des sessions Bureau à distance (image décodée par le moteur RDP)
  i18n.ts            langue de l'interface : t("English", "Français") côte à côte
rdp-helper/          moteur RDP (IronRDP), programme séparé lancé pour chaque session RDP ou relecture
aide/                Portunia Assistance, le programme de la personne aidée (écran partagé en RDP, fenêtre, accord)
assist-proto/        code d'assistance, échange de clés (SPAKE2) et chiffrement de bout en bout, communs à Portunia et Portunia Assistance
scripts/             compilation du moteur RDP, vérification des appels t(…) (check-i18n.cjs)
tools/license-tool/  outil de l'éditeur : clé de signature et génération des licences (ne pas distribuer)
screenshot.html      démonstration avec données fictives pour les captures d'écran
                     (npx vite, puis /screenshot.html?scene=main ou ?scene=split&theme=light)
.github/workflows/   publication automatique des versions
```

Le cœur ne connaît aucun protocole. Une extension :

1. décrit ses champs (`Manifest.fields`) : l'interface génère le formulaire toute seule ;
2. indique sa vue : `terminal`, `screen` (écran distant dans un onglet), `desktop` (application externe), `web` ou `files` (onglet fichiers à deux volets) ;
3. implémente `connect()`, qui renvoie soit une connexion terminal, soit « ouvert ailleurs ».

### Ajouter un protocole

1. Créez `src-tauri/src/connectors/monproto.rs` qui implémente `Connector` (prenez `telnet.rs` comme modèle).
2. Déclarez-le dans `connectors/mod.rs` et enregistrez-le dans `Registry::with_builtins()`.
3. Facultatif : ajoutez une couleur `.badge-monproto` dans `src/styles.css`.

## Composants tiers

- Console de Windows Terminal (`conpty.dll`, `OpenConsole.exe`) : Microsoft, licence MIT — voir `src-tauri/conpty/`.

## Pistes pour la suite

- Extensions externes téléchargées depuis le catalogue et chargées sans recompiler (modules WASM signés et isolés).
- Versions Linux, puis macOS.

