# Labo de test de Portunia

Des serveurs jetables sur votre PC pour passer la recette avant la vente : SSH (mot de passe,
clé, Gates, ancien équipement, double authentification), SFTP, FTP/FTPS, S3, VNC, telnet,
web, Docker. Tout tourne dans Docker Desktop et n'écoute que sur `127.0.0.1` : rien n'est
visible depuis le réseau.

## 1. Installer Docker Desktop (une seule fois)

1. Télécharger Docker Desktop pour Windows sur https://www.docker.com/products/docker-desktop/
   (gratuit pour un usage personnel, l'enseignement et les entreprises de moins de 250 personnes).
2. L'installer avec les options proposées (WSL 2). Un redémarrage du PC peut être demandé.
3. Lancer Docker Desktop et attendre « Engine running » en bas à gauche.

## 2. Démarrer le labo

Dans un terminal (PowerShell, ou un shell local de Portunia), depuis le dossier du projet :

```
cd tools\labo
docker compose up -d --build
```

La première fois, comptez quelques minutes (téléchargement et construction des images).
Ensuite le démarrage prend quelques secondes.

## 3. Importer les sessions dans Portunia

1. Portunia › **Importer / exporter** › **Restaurer…** › choisir `tools\labo\sessions-labo.json`.
2. **Identifiants partagés** › « Labo » › Modifier › mot de passe `portunia-test`.
3. Dans les sessions :
   - **Labo — S3** › Modifier › Clé secrète : `portunia-labo-secret`
   - **Labo — bureau VNC** › Modifier › Mot de passe VNC : `portunia`

Le dossier **Labo** contient alors toutes les sessions de test.

## Ce qu'il y a dans le labo

| Session Portunia | Serveur | Adresse | Pour tester |
|---|---|---|---|
| Labo — serveur | Linux Debian | 127.0.0.1:2201 | mot de passe, clés, SFTP, tableau de bord, conteneurs, tunnels, X11 |
| Labo — Gate | Linux | 127.0.0.1:2202 | entrée du réseau interne |
| Labo — interne (via Gate) | Linux | `interne`, seulement par la Gate | serveur de rebond |
| Labo — interne (2 Gates) | Linux | par `gate` puis `gate2` | rebonds enchaînés |
| Labo — ancien équipement | Linux, algorithmes anciens | 127.0.0.1:2203 | « Compatibilité anciens équipements » |
| Labo — double authentification | Linux, mot de passe + code | 127.0.0.1:2204 | codes à 6 chiffres |
| Labo — FTPS / FTP non chiffré | vsftpd | 127.0.0.1:2121 | FTP, FTPS (reprise de session TLS exigée) |
| Labo — S3 | SeaweedFS, compartiment `labo` | http://127.0.0.1:9000 | stockage S3 |
| Labo — bureau VNC | Bureau Linux | 127.0.0.1:5901 | VNC |
| Labo — telnet | Linux | 127.0.0.1:2323 | Telnet |
| Labo — web | nginx | http://127.0.0.1:8080 | interface web, tunnels |

Compte partout : **test / portunia-test** (sudo sans mot de passe).

## Recettes particulières

- **Clé SSH** : déposez vos clés publiques (`.pub`) dans `tools\labo\cles`, puis
  `docker compose up -d --force-recreate`. Ou utilisez l'assistant « Clé SSH » de Portunia
  depuis une session par mot de passe.
- **Clé de serveur changée** : `docker compose up -d --force-recreate serveur` recrée le serveur
  avec de nouvelles clés d'hôte ; Portunia doit refuser la connexion suivante.
- **Double authentification** : code du moment avec
  `docker compose exec deuxfacteurs oathtool --totp -b JBSWY3DPEHPK3PXP`,
  ou ajoutez le secret `JBSWY3DPEHPK3PXP` à une application d'authentification.
- **Conteneurs** : sur « Labo — serveur », le bouton « Conteneurs » montre les conteneurs du labo
  (le serveur voit le Docker de votre PC). Kubernetes : activer Kubernetes dans Docker Desktop
  n'est pas utile ici, le serveur n'a pas `kubectl` ; marquez la partie Kubernetes
  « Non applicable » ou testez-la sur un vrai cluster.
- **Supervision** : `docker compose stop web` puis `docker compose start web`.
- **Coupure réseau** : `docker compose restart serveur` pendant une session ouverte.
- **Commande sur plusieurs serveurs** : clic droit sur le dossier « Labo » ; arrêtez un serveur
  avant (`docker compose stop ancien`) pour vérifier qu'un échec ne bloque pas les autres.
- **Tunnels** (session « Labo — serveur », bouton Tunnels) :
  - local `localhost:8081 → web:80` puis http://localhost:8081 ;
  - SOCKS sur le port 1080, à régler dans un navigateur ;
  - inverse : le port 9090 du serveur mène au web du labo vu depuis votre PC
    (dans la session : `curl localhost:9090`).
- **X11** : installez VcXsrv, lancez-le avec « Disable access control », puis `xclock` dans
  « Labo — serveur ».

## Arrêter, repartir de zéro

```
docker compose stop              # arrêter (les données restent)
docker compose down              # supprimer les conteneurs
docker compose down --rmi local  # tout supprimer, images comprises
```

## Ce que le labo ne couvre pas

- **Bureau à distance (RDP)** : créez une machine virtuelle Windows avec Hyper-V
  (Windows Pro : « Activer ou désactiver des fonctionnalités Windows » › Hyper-V), à partir d'une
  version d'évaluation gratuite de Windows 11 Entreprise ou de Windows Server
  (Microsoft Evaluation Center). Elle sert aussi pour le test sur Windows 10/11 propre.
- **Port série** : com0com crée deux ports COM virtuels reliés entre eux ; sinon « Non applicable ».
- **Wake-on-LAN** : il faut une vraie machine qui l'accepte.

Ce labo est fait pour des tests : mots de passe connus, socket Docker partagé. Ne le
lancez pas sur un serveur accessible depuis Internet.
