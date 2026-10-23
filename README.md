# Termoria

Gestionnaire de sessions distantes pour Windows : toutes vos connexions (SSH, Bureau à distance, consoles web, Telnet…) dans une seule fenêtre. Léger (Tauri 2 + Rust, interface sans framework) et extensible (un protocole = une extension).

## Installer les outils (une seule fois)

1. **Outils de compilation C++ de Visual Studio** : installez « Build Tools for Visual Studio » et cochez « Développement Desktop en C++ ».
2. **Rust** : installez `rustup` depuis https://rustup.rs (choisissez la chaîne `stable-x86_64-pc-windows-msvc`).
3. **Node.js LTS** : https://nodejs.org
4. WebView2 est déjà présent sur Windows 11.

## Lancer en développement

```bash
npm install
npm run tauri dev
```

La première compilation Rust prend quelques minutes, les suivantes sont rapides.

## Produire l'installateur

```bash
npm run tauri build
```

L'installateur se trouve dans `src-tauri/target/release/bundle/nsis/`.

## Fonctionnalités

| Protocole | Affichage | Remarques |
|---|---|---|
| SSH | Onglet terminal | Clé privée, mot de passe ou agent (Pageant / OpenSSH). Les clés des serveurs sont mémorisées à la première connexion, et une clé qui change bloque la connexion. SSH-2 uniquement, compatible OpenSSH 10. Option « Compatibilité anciens équipements » pour les serveurs qui n'acceptent que des algorithmes anciens (diffie-hellman-group1/14-sha1, aes-cbc, 3des-cbc, hmac-sha1, ssh-dss) : ils ne sont utilisés qu'en dernier recours, avec un avertissement dans le terminal. |
| Bureau à distance (RDP) | Fenêtre du client Windows (mstsc) | Rien à installer. |
| Interface web | Fenêtre dédiée | La fenêtre web n'a aucun accès à l'application. |
| Telnet | Onglet terminal | Non chiffré : à réserver au réseau local. |

Autres fonctions :

- arbre des sessions avec dossiers et sous-dossiers (dossiers vides possibles), glisser-déposer pour ranger, menu clic droit (dupliquer, ouvrir tout un dossier…), recherche (Ctrl+Maj+K), onglets ;
- terminal : recherche dans l'historique (Ctrl+Maj+F), police et taille réglables (Ctrl + molette), copier/coller au clic droit, liens ouverts par Ctrl+clic ;
- écran partagé (jusqu'à 4 sessions côte à côte) et saisie multiple (Ctrl+Maj+B) pour taper la même chose sur plusieurs serveurs ;
- commandes enregistrées (Ctrl+Maj+P) : par session, par dossier ou pour toutes, avec variables {{host}}, {{username}}… ;
- reconnexion automatique après une coupure réseau ou une mise en veille (désactivable dans les Paramètres) ;
- explorateur de fichiers du serveur (SFTP) à droite des sessions SSH : navigation, envoi par glisser-déposer, téléchargement, création, renommage et suppression, avec suivi des transferts ;
- mots de passe rangés dans le Gestionnaire d'identifiants Windows, jamais en clair sur le disque ;
- sessions enregistrées dans `%APPDATA%\fr.termoria.app\sessions.json`.

Raccourcis : Ctrl+Maj+N nouvelle session, Ctrl+Maj+W fermer l'onglet, Ctrl+Maj+F rechercher, Ctrl+Maj+C / Ctrl+Maj+V copier / coller dans le terminal, F2 renommer, Suppr supprimer.

## Architecture

```
src-tauri/src/
  connector.rs     contrat d'une extension (trait Connector, manifeste, champs)
  registry.rs      liste des extensions disponibles
  connectors/      une extension par fichier : ssh, rdp, web, telnet (+ sftp.rs : explorateur de fichiers)
  store.rs         sessions enregistrées (JSON)
  secrets.rs       Gestionnaire d'identifiants Windows
  commands.rs      commandes appelées par l'interface
src/
  main.ts          arbre, onglets, panneau de détails
  dialog.ts        formulaire généré à partir du manifeste de l'extension
  terminal.ts      vue terminal (xterm.js)
  extensions.ts    page Extensions
  files.ts         explorateur de fichiers du serveur
  tree.ts          arbre des sessions (dossiers, glisser-déposer)
  menu.ts          menu contextuel
  settings.ts      paramètres de l'interface
  snippets.ts      commandes enregistrées (palette et gestion)
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
- VNC et port série.
- RDP intégré dans un onglet plutôt que dans une fenêtre séparée.
- Tunnels SSH, serveur de rebond, téléchargement de dossiers entiers.
- Import des sessions PuTTY / mRemoteNG.
