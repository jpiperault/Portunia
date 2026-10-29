# Portunia

Gestionnaire de sessions distantes pour Windows : toutes vos connexions (SSH, Bureau à distance, consoles web, Telnet…) dans une seule fenêtre. Léger (Tauri 2 + Rust, interface sans framework) et extensible (un protocole = une extension).

Portunia s'appelait **Termoria** jusqu'à la version 0.39. La mise à jour vers Portunia retire l'ancienne application et reprend ses données (sessions, coffre, réglages), copiées au premier lancement ; l'ancien dossier `fr.termoria.app` reste comme copie de secours. Le bastion SSH **Heimdia** s'intègre comme une extension (voir ci-dessous).

## Installer Portunia

Téléchargez `Portunia_x.y.z_x64-setup.exe` dans les [Releases](https://github.com/jpiperault/Portunia-releases/releases) et lancez-le (installation pour l'utilisateur courant, sans droits administrateur). Portunia se met ensuite à jour tout seul : une bannière propose chaque nouvelle version.

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
| SSH | Onglet terminal | Clé privée, mot de passe ou agent (Pageant / OpenSSH). Serveur de rebond (bastion, comme ProxyJump) : une session SSH enregistrée ou `utilisateur@hôte:port`, jusqu'à 3 rebonds enchaînés (`bastion1,bastion2`), repris de ~/.ssh/config à l'import. Les clés des serveurs sont mémorisées à la première connexion, et une clé qui change bloque la connexion. SSH-2 uniquement, compatible OpenSSH 10. Option « Compatibilité anciens équipements » pour les serveurs qui n'acceptent que des algorithmes anciens (diffie-hellman-group1/14-sha1, aes-cbc, 3des-cbc, hmac-sha1, ssh-dss) : ils ne sont utilisés qu'en dernier recours, avec un avertissement dans le terminal. |
| Bureau à distance (RDP) | Onglet écran (IronRDP) ou client Windows | Dans un onglet avec le moteur IronRDP (authentification NLA, compte de domaine, presse-papiers partagé, écran adapté automatiquement à la taille de l'onglet), ou dans le client Bureau à distance de Windows au choix. |
| Interface web | Fenêtre dédiée | La fenêtre web n'a aucun accès à l'application. |
| Telnet | Onglet terminal | Non chiffré : à réserver au réseau local. |
| VNC | Onglet écran | Clavier, souris, molette, presse-papiers dans les deux sens, Ctrl+Alt+Suppr, ajustement à la fenêtre. Encodages Tight, ZRLE, CopyRect, Raw. |
| Shell local | Onglet terminal | PowerShell 7, Windows PowerShell, Invite de commandes, distributions WSL, Git Bash et shells personnalisés, via la console de Windows Terminal livrée avec Portunia (OpenConsole, plus rapide que celle du système : écho de la frappe 47 → 17 ms, sorties volumineuses 11 → 38 Mo/s). Section « Ce PC », menu « + », Ctrl+Maj+T. |
| Bastion Heimdia (extension) | Onglet terminal | Section « Bastions » de la barre latérale : on ajoute un bastion [Heimdia](https://github.com/jpiperault/Heimdia) (empreinte du certificat vérifiée, mot de passe et code, première connexion avec mot de passe provisoire et enrôlement du code par code QR). Les serveurs autorisés s'affichent par dossier ; chaque ouverture utilise un jeton à usage unique, sans retaper le code. Modes coffre (compte fourni par le bastion), enregistré (identifiants demandés dans le terminal) et rebond (de bout en bout). Signale les sessions qui contournent le bastion. Administration du bastion (serveurs et coffre, comptes, groupes, règles, journal vérifié, sessions, réglages) dans Portunia Équipes. Activable dans Extensions. |
| FTP / FTPS | Onglet fichiers | Explorateur en pleine largeur (envoi, téléchargement, glisser-déposer, renommage, suppression). FTPS explicite par défaut, avec reprise de session TLS (exigée par FileZilla Server et vsftpd) et certificats vérifiés par Windows ; certificat auto-signé accepté sur demande. Connexion rouverte d'elle-même après inactivité. `ftps://user@hôte` en connexion rapide. |
| Stockage S3 (Pro) | Onglet fichiers | Amazon S3 et services compatibles (MinIO, Scaleway, OVH, Wasabi, Cloudflare R2…) : compartiments, dossiers, envoi et téléchargement (jusqu'à 5 Go par fichier), renommage et suppression de dossiers entiers. Adressage par chemin pour MinIO / Ceph. Client intégré (signature AWS SigV4), sans le SDK d'Amazon. |
| Port série | Onglet terminal | Ports COM détectés automatiquement, vitesse, parité, contrôle de flux, fin de ligne. |

Autres fonctions :

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
- apparence : thème sombre, clair ou comme Windows, 9 palettes de terminal (Dracula, Nord, Solarized…), couleur par dossier (bandeau sur les sessions, onglets et barre d'outils, étiquette « PRODUCTION ») ;
- tableau de bord du serveur (Pro, sessions SSH vers Linux) : processeur et mémoire avec courbes, swap, charge, disques, processus les plus actifs, services systemd en échec (« Voir » affiche leur journal), relevé toutes les 5 s quand le panneau est visible ;
- commande sur plusieurs serveurs (Pro) : choix des sessions SSH ou d'un dossier entier (clic droit), commande ou commande enregistrée, 8 serveurs à la fois, résultats côte à côte (code de sortie, durée, sortie, filtre des échecs, copie), confirmation renforcée pour les dossiers rouges ;
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
  connectors/        une extension par fichier : ssh, rdp, vnc, web, telnet, serial, local
                     (+ sftp.rs : fichiers, forward.rs : tunnels)
  commands.rs        commandes appelées par l'interface
  store.rs           sessions, dossiers, couleurs et commandes enregistrés (JSON)
  secrets.rs         Gestionnaire d'identifiants Windows
  importers.rs       import ssh config / PuTTY / mRemoteNG, sauvegarde
  license.rs         éditions et vérification des licences (point de contrôle unique)
  lock.rs            verrouillage (mot de passe maître, Windows Hello)
  recording.rs       enregistrement des sessions (asciicast, texte)
  monitor.rs         supervision (test de connexion TCP)
  transfer.rs        transferts de dossiers entiers, édition de fichiers distants
src/                 interface (TypeScript, sans framework)
  main.ts            arbre, onglets, écran partagé, barre d'outils
  dialog.ts          formulaire généré à partir du manifeste de l'extension
  terminal.ts        vue terminal (xterm.js)
  screen.ts          vue écran distant (canvas, clavier, souris)
  files.ts           explorateur de fichiers du serveur
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
  extensions.ts      page Extensions
rdp-helper/          moteur RDP (IronRDP), programme séparé lancé pour chaque session RDP
scripts/             compilation du moteur RDP
tools/license-tool/  outil de l'éditeur : clé de signature et génération des licences (ne pas distribuer)
screenshot.html      démonstration avec données fictives pour les captures d'écran
                     (npx vite, puis /screenshot.html?scene=main ou ?scene=split&theme=light)
.github/workflows/   publication automatique des versions
```

Le cœur ne connaît aucun protocole. Une extension :

1. décrit ses champs (`Manifest.fields`) : l'interface génère le formulaire toute seule ;
2. indique sa vue : `terminal`, `screen` (écran distant dans un onglet), `desktop` (application externe) ou `web` ;
3. implémente `connect()`, qui renvoie soit une connexion terminal, soit « ouvert ailleurs ».

### Ajouter un protocole

1. Créez `src-tauri/src/connectors/monproto.rs` qui implémente `Connector` (prenez `telnet.rs` comme modèle).
2. Déclarez-le dans `connectors/mod.rs` et enregistrez-le dans `Registry::with_builtins()`.
3. Facultatif : ajoutez une couleur `.badge-monproto` dans `src/styles.css`.

## Composants tiers

- Console de Windows Terminal (`conpty.dll`, `OpenConsole.exe`) : Microsoft, licence MIT — voir `src-tauri/conpty/`.

## Pistes pour la suite

- Extensions externes chargées sans recompiler (modules WASM).

