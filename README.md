# Termoria

Gestionnaire de sessions distantes pour Windows : toutes vos connexions (SSH, Bureau à distance, consoles web, Telnet…) dans une seule fenêtre. Léger (Tauri 2 + Rust, interface sans framework) et extensible (un protocole = une extension).

## Installer Termoria

Téléchargez `Termoria_x.y.z_x64-setup.exe` dans les [Releases](https://github.com/jpiperault/Termonia/releases) et lancez-le (installation pour l'utilisateur courant, sans droits administrateur). Termoria se met ensuite à jour tout seul : une bannière propose chaque nouvelle version.

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
3. GitHub Actions (`.github/workflows/release.yml`) compile l'installateur, le signe et publie la release avec `latest.json`, que Termoria consulte pour se mettre à jour.

La signature utilise la clé `~/.tauri/termoria.key` (secrets `TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` du dépôt). La clé publique est dans `tauri.conf.json`. **Ne perdez pas la clé privée** : sans elle, les versions installées ne peuvent plus être mises à jour.

Pour produire l'installateur localement : définir `TAURI_SIGNING_PRIVATE_KEY` (chemin ou contenu de la clé) et son mot de passe, puis `npm run tauri build`. L'installateur est dans `src-tauri/target/release/bundle/nsis/`.

## Fonctionnalités

| Protocole | Affichage | Remarques |
|---|---|---|
| SSH | Onglet terminal | Clé privée, mot de passe ou agent (Pageant / OpenSSH). Les clés des serveurs sont mémorisées à la première connexion, et une clé qui change bloque la connexion. SSH-2 uniquement, compatible OpenSSH 10. Option « Compatibilité anciens équipements » pour les serveurs qui n'acceptent que des algorithmes anciens (diffie-hellman-group1/14-sha1, aes-cbc, 3des-cbc, hmac-sha1, ssh-dss) : ils ne sont utilisés qu'en dernier recours, avec un avertissement dans le terminal. |
| Bureau à distance (RDP) | Onglet écran (IronRDP) ou client Windows | Dans un onglet avec le moteur IronRDP (authentification NLA, compte de domaine, presse-papiers partagé, écran adapté automatiquement à la taille de l'onglet), ou dans le client Bureau à distance de Windows au choix. |
| Interface web | Fenêtre dédiée | La fenêtre web n'a aucun accès à l'application. |
| Telnet | Onglet terminal | Non chiffré : à réserver au réseau local. |
| VNC | Onglet écran | Clavier, souris, molette, presse-papiers dans les deux sens, Ctrl+Alt+Suppr, ajustement à la fenêtre. Encodages Tight, ZRLE, CopyRect, Raw. |
| Port série | Onglet terminal | Ports COM détectés automatiquement, vitesse, parité, contrôle de flux, fin de ligne. |

Autres fonctions :

- arbre des sessions avec dossiers et sous-dossiers (dossiers vides possibles), glisser-déposer pour ranger, menu clic droit (dupliquer, ouvrir tout un dossier…), recherche (Ctrl+Maj+K), onglets ;
- terminal : recherche dans l'historique (Ctrl+Maj+F), police et taille réglables (Ctrl + molette), copier/coller au clic droit, liens ouverts par Ctrl+clic ;
- écran partagé (jusqu'à 4 sessions côte à côte) et saisie multiple (Ctrl+Maj+B) pour taper la même chose sur plusieurs serveurs ;
- commandes enregistrées (Ctrl+Maj+P) : par session, par dossier ou pour toutes, avec variables {{host}}, {{username}}… ;
- tunnels SSH : port local (ssh -L) et proxy SOCKS5 (ssh -D), ouverts à la connexion ou à la demande, n'écoutant que sur 127.0.0.1 ;
- reconnexion automatique après une coupure réseau ou une mise en veille (désactivable dans les Paramètres) ;
- explorateur de fichiers du serveur (SFTP) à droite des sessions SSH : navigation, envoi et téléchargement de fichiers ou de dossiers entiers (glisser-déposer compris), édition d'un fichier distant dans votre éditeur avec renvoi automatique à chaque enregistrement, création, renommage, suppression, suivi des transferts ;
- import depuis ~/.ssh/config, PuTTY et mRemoteNG (avec aperçu et détection des doublons), sauvegarde et restauration Termoria ;
- apparence : thème sombre, clair ou comme Windows, 9 palettes de terminal (Dracula, Nord, Solarized…), couleur par dossier (bandeau sur les sessions, onglets et barre d'outils, étiquette « PRODUCTION ») ;
- supervision : pastille verte ou rouge et latence pour chaque serveur, vue d'ensemble, notifications quand un serveur tombe ou revient (Pro) ;
- enregistrement des sessions terminal (Pro) : fichiers asciicast + texte, lecteur intégré avec vitesse et navigation ;
- verrouillage par mot de passe maître et Windows Hello, au démarrage et après inactivité (Ctrl+Maj+L) ;
- éditions Gratuit / Pro / Équipes, licences signées vérifiées hors ligne (Paramètres › Licence) ;
- mots de passe rangés dans le Gestionnaire d'identifiants Windows, jamais en clair sur le disque ;
- sessions enregistrées dans `%APPDATA%\fr.termoria.app\sessions.json`.

Raccourcis : Ctrl+Maj+N nouvelle session, Ctrl+Maj+W fermer l'onglet, Ctrl+Maj+F rechercher, Ctrl+Maj+C / Ctrl+Maj+V copier / coller dans le terminal, F2 renommer, Suppr supprimer.

## Architecture

```
src-tauri/src/
  connector.rs     contrat d'une extension (trait Connector, manifeste, champs)
  registry.rs      liste des extensions disponibles
  connectors/      une extension par fichier : ssh, rdp, web, telnet, serial, vnc
rdp-helper/        moteur RDP (IronRDP), programme séparé lancé pour chaque session RDP
scripts/           compilation du moteur RDP
.github/workflows/ publication automatique des versions
tools/license-tool/ outil de l'éditeur : clé de signature et génération des licences (ne pas distribuer) (+ sftp.rs : fichiers, forward.rs : tunnels)
  store.rs         sessions, dossiers et commandes enregistrés (JSON)
  importers.rs     import ssh config / PuTTY / mRemoteNG, sauvegarde
  license.rs       éditions et vérification des licences (point de contrôle unique)
  lock.rs          verrouillage (mot de passe maître, Windows Hello)
  recording.rs     enregistrement des sessions (asciicast, texte)
  monitor.rs       supervision (test de connexion TCP)
  transfer.rs      transferts de dossiers entiers, édition de fichiers distants
  secrets.rs       Gestionnaire d'identifiants Windows
  commands.rs      commandes appelées par l'interface
src/
  main.ts          arbre, onglets, panneau de détails
  dialog.ts        formulaire généré à partir du manifeste de l'extension
  terminal.ts      vue terminal (xterm.js)
  screen.ts        vue écran distant (canvas, clavier, souris)
  extensions.ts    page Extensions
  files.ts         explorateur de fichiers du serveur
  tree.ts          arbre des sessions (dossiers, glisser-déposer)
  menu.ts          menu contextuel
  settings.ts      paramètres de l'interface
  snippets.ts      commandes enregistrées (palette et gestion)
  tunnels.ts       tunnels SSH (éditeur et suivi)
  importexport.ts  import / export
  updates.ts       mises à jour automatiques
  security.ts      écran de verrouillage, licence
  recordings.ts    liste et lecteur des enregistrements
  monitoring.ts    supervision : pastilles, vue d'ensemble, alertes
  theme.ts         thèmes, palettes du terminal, couleurs de dossier
```

Le cœur ne connaît aucun protocole. Une extension :

1. décrit ses champs (`Manifest.fields`) : l'interface génère le formulaire toute seule ;
2. indique sa vue : `terminal`, `desktop` ou `web` ;
3. implémente `connect()`, qui renvoie soit une connexion terminal, soit « ouvert ailleurs ».

### Ajouter un protocole

1. Créez `src-tauri/src/connectors/monproto.rs` qui implémente `Connector` (prenez `telnet.rs` comme modèle).
2. Déclarez-le dans `connectors/mod.rs` et enregistrez-le dans `Registry::with_builtins()`.
3. Facultatif : ajoutez une couleur `.badge-monproto` dans `src/styles.css`.

## Pistes pour la suite

- Extensions externes chargées sans recompiler (modules WASM).
- Serveur de rebond (bastion).

