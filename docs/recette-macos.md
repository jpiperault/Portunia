# Recette manuelle macOS

À passer avant la première release Mac, puis avant chaque version qui touche au portage. L'application est universelle : la grille se fait **deux fois**, une sur un Mac Apple Silicon, une sur un Mac Intel (un Mac Apple Silicon qui lance l'application sous Rosetta ne remplace pas un vrai Mac Intel : le noter si c'est la seule option).

Légende : cocher `[x]` si correct, noter l'écart sinon. Chaque colonne : **AS** = Apple Silicon, **IN** = Intel.

Mac testé AS : ____________ (macOS ____)  Mac testé IN : ____________ (macOS ____)  Version de Portunia : ________

## 1. Installation et premières données

| AS | IN | Contrôle |
|----|----|----------|
| [ ] | [ ] | Le `.dmg` s'ouvre, glisser Portunia dans `Applications` fonctionne |
| [ ] | [ ] | Premier lancement : Gatekeeper refuse, `Réglages Système > Confidentialité et sécurité > Ouvrir quand même` fonctionne, une seule fois |
| [ ] | [ ] | `codesign -v /Applications/Portunia.app` réussit, `lipo -archs` sur `Contents/MacOS/*` affiche `x86_64 arm64` |
| [ ] | [ ] | Création du coffre (mot de passe maître) puis redémarrage : le coffre se rouvre |
| [ ] | [ ] | Import d'une sauvegarde faite sous Windows : sessions, dossiers, identifiants, clés SSH et réglages présents |
| [ ] | [ ] | Fenêtre : redimensionnement jusqu'à la taille minimale, plein écran, feux tricolores, deux écrans |

## 2. Protocoles

| AS | IN | Contrôle |
|----|----|----------|
| [ ] | [ ] | SSH avec mot de passe |
| [ ] | [ ] | SSH avec clé (protégée par phrase secrète et non protégée) |
| [ ] | [ ] | SSH avec agent (`SSH_AUTH_SOCK`, agent 1Password ou `ssh-agent`) |
| [ ] | [ ] | SSH via rebond (jusqu'à 3), clé d'hôte inconnue puis clé modifiée (blocage) |
| [ ] | [ ] | SFTP : lister, téléverser, télécharger, renommer, supprimer, glisser-déposer depuis le Finder |
| [ ] | [ ] | FTP / FTPS : connexion, transfert |
| [ ] | [ ] | S3 : lister un bucket, téléverser, télécharger |
| [ ] | [ ] | VNC : affichage, souris, clavier, presse-papiers |
| [ ] | [ ] | Telnet |
| [ ] | [ ] | Port série : liste des ports (`/dev/cu.*`), ouverture, envoi et réception, débit |
| [ ] | [ ] | Terminal : police monospace lisible (Menlo si Cascadia absente), copier/coller, recherche, défilement |

## 3. Réseau et serveurs

| AS | IN | Contrôle |
|----|----|----------|
| [ ] | [ ] | Tunnels : local, distant, dynamique (SOCKS) ; démarrage, arrêt, état |
| [ ] | [ ] | Gate : appairage, liste des serveurs, ouverture d'une session via la Gate |
| [ ] | [ ] | Proxmox : connexion, liste des nœuds et machines, console VNC, démarrage et arrêt d'une VM |

## 4. Bureau à distance

| AS | IN | Contrôle |
|----|----|----------|
| [ ] | [ ] | RDP IronRDP : connexion NLA, affichage net (Retina), redimensionnement de la fenêtre |
| [ ] | [ ] | Clavier AZERTY Mac : lettres, chiffres, accents, `@ # { } [ ] \| ~`, Maj, Verr. Maj, touches de fonction, flèches |
| [ ] | [ ] | Cmd transmis comme Ctrl (Cmd+C, Cmd+V, Cmd+A dans la session Windows) ; Option/AltGr pour les caractères spéciaux |
| [ ] | [ ] | Presse-papiers : texte dans les deux sens |
| [ ] | [ ] | Son : lecture, pas de craquement, volume |
| [ ] | [ ] | Copie de fichiers : Mac vers session, session vers Mac, glisser-déposer |
| [ ] | [ ] | Passerelle RD Gateway |
| [ ] | [ ] | RDP via Windows App (Microsoft) : détection, ouverture d'une session |
| [ ] | [ ] | Fermeture d'un onglet RDP : le processus `portunia-rdp` disparaît (Moniteur d'activité) |

## 5. Système

| AS | IN | Contrôle |
|----|----|----------|
| [ ] | [ ] | Shells locaux : zsh, bash, et autres shells détectés ; variables d'environnement, couleurs |
| [ ] | [ ] | Ping et traceroute sans droits administrateur |
| [ ] | [ ] | « Afficher dans le Finder » et ouverture d'un fichier téléchargé |
| [ ] | [ ] | Éditeur externe : ouverture, enregistrement, renvoi du fichier modifié |
| [ ] | [ ] | Notifications : autorisation demandée, notification reçue, clic ramène à l'onglet |
| [ ] | [ ] | Menu Portunia (À propos, Réglages, Quitter), menu Édition, menu Fenêtre |
| [ ] | [ ] | Cmd+C / Cmd+V / Cmd+X / Cmd+A dans les champs de texte et dans les terminaux |
| [ ] | [ ] | Raccourcis applicatifs sur Cmd (nouvelle connexion rapide, fermer l'onglet, palette), aucun conflit avec Ctrl dans les sessions |
| [ ] | [ ] | Thème « Comme macOS » : suit le passage clair/sombre du système en direct |
| [ ] | [ ] | Rendu : flous (écran verrouillé), cases à cocher, boutons segmentés, grilles de formulaires (passe WebKit) |

## 6. Trousseau et Touch ID

| AS | IN | Contrôle |
|----|----|----------|
| [ ] | [ ] | Activation de Touch ID dans les réglages (Mac avec lecteur) |
| [ ] | [ ] | Déverrouillage au démarrage avec Touch ID |
| [ ] | [ ] | Annulation de la fenêtre Touch ID : retour à la saisie du mot de passe maître, rien n'est perdu |
| [ ] | [ ] | Changement du mot de passe maître avec Touch ID actif : le déverrouillage Touch ID fonctionne encore ensuite |
| [ ] | [ ] | Désactivation de Touch ID : le Trousseau ne garde plus la clé |
| [ ] | [ ] | Mac sans Touch ID (ou lecteur indisponible) : l'option est absente ou grisée, le mot de passe suffit |

## 7. Mise à jour automatique

| AS | IN | Contrôle |
|----|----|----------|
| [ ] | [ ] | Version N-1 installée, release N publiée : la bannière propose N |
| [ ] | [ ] | Installation : téléchargement, signature minisign vérifiée, remplacement de l'application, redémarrage en N |
| [ ] | [ ] | Après mise à jour : pas de nouvelle demande Gatekeeper ; demande éventuelle d'accès au Trousseau (**Toujours autoriser**) |
| [ ] | [ ] | `latest.json` de la release : `windows-x86_64`, `darwin-aarch64`, `darwin-x86_64` (vérifié par la dernière étape de `release.yml`) |
| [ ] | [ ] | **Windows** : une installation Windows N-1 se met toujours à jour vers N, l'URL est le `-setup.exe` |

## Écarts constatés

| Plateforme | Section | Description | Gravité |
|------------|---------|-------------|---------|
|            |         |             |         |
