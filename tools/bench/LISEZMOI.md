# Mesures de performance

Scripts qui pilotent un navigateur par son protocole de débogage (Node 22+, sans dépendance).
Ils ont servi à la version 0.34 : refaites les mesures avant / après toute modification du
chemin d'affichage des terminaux.

## Terminal seul (page de démonstration, Edge headless)

Serveur de la page : `npx vite` (port 1420), puis :

```
bash med.sh <libellé> <on|off> <gros|petits>    # médiane de 3 essais
```

`on|off` : mise en évidence ; `gros|petits` : messages de 4,8 Ko ou de 120 octets.
Edge headless n'a pas de vraie carte graphique : le rendu WebGL n'y est pas représentatif.
`startup.mjs` mesure le démarrage de la version de production (`npx vite build && npx vite preview`).

## Bout en bout dans la vraie application

Lancer Portunia en développement avec un port de débogage WebView2 et son propre dossier
de données (pour cohabiter avec une Portunia installée) :

```
WEBVIEW2_USER_DATA_FOLDER=%TEMP%\portunia-bench WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri dev
```

- `node gros-fichier.mjs` crée le fichier de 20 Mo ;
- `node real.mjs` : shell local, `type` du fichier (console Windows comprise) ;
- `node source.mjs` puis `node net.mjs` : source réseau (Telnet local), comme une session SSH ;
- `node echo.mjs` : délai entre une touche et son écho.

Résultats de référence (machine virtuelle 2 cœurs, sans carte graphique) : voir le message
du commit « Portunia 0.34.0 ».
