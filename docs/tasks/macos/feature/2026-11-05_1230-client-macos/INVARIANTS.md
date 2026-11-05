# Invariants : client macOS

Commandes à lancer depuis la racine du dépôt. Chaque commande « Verify » renvoie 0 si l'invariant tient. Celles qui ne s'appliquent qu'après un sprint donné sont conditionnées par l'existence d'un fichier que ce sprint crée.

## Config Windows intacte
- **Owner:** packaging (S1, S5)
- **Preconditions:** toute configuration propre à Mac va dans `src-tauri/tauri.macos.conf.json`
- **Postconditions:** `tauri.conf.json` produit exactement le même installeur NSIS qu'avant le portage
- **Invariants:** `tauri.conf.json` garde la cible `nsis` et ne contient aucune section `macOS`
- **Verify:** `grep -q '"nsis"' src-tauri/tauri.conf.json && ! grep -q '"macOS"' src-tauri/tauri.conf.json`
- **Fix:** déplacer la clé ajoutée dans `tauri.macos.conf.json`

## Pas de dépendance Windows inconditionnelle
- **Owner:** Cargo (S1)
- **Preconditions:** —
- **Postconditions:** les crates compilent sur macOS
- **Invariants:** `winreg`, `windows` et `windows-future` ne sont déclarés que dans des sections `[target.'cfg(windows)'...]`
- **Verify:** `[ ! -f src-tauri/src/platform.rs ] || awk '/^\[/{sec=$0} /^(winreg|windows|windows-future)[ =]/{ if (sec !~ /cfg\(windows\)/) {print FILENAME": "$0" dans "sec; bad=1} } END{exit bad}' src-tauri/Cargo.toml rdp-helper/Cargo.toml`
- **Fix:** déplacer la ligne sous `[target.'cfg(windows)'.dependencies]`

## Pas de secret en log
- **Owner:** sécurité (S2, S4)
- **Preconditions:** les secrets circulent dans des variables nommées `password`, `passphrase`, `secret`, `vault_key`, ou dans des `Zeroizing<…>`
- **Postconditions:** aucun secret n'apparaît dans stdout, stderr ou les journaux
- **Invariants:** aucune macro de log ou d'affichage ne formate une de ces variables
- **Verify:** `! grep -rnE '(println!|eprintln!|log::[a-z]+!|tracing::[a-z]+!|(info|debug|warn|error|trace)!)\(.*(\{(password|passphrase|secret|vault_key)[}:]|,\s*&?(password|passphrase|secret|vault_key)\b)' src-tauri/src rdp-helper/src`
- **Fix:** retirer la variable du message, et logger seulement l'événement (« clé lue », « échec Touch ID »)

## Raccourcis via isMod
- **Owner:** interface (S3)
- **Preconditions:** `src/platform.ts` existe
- **Postconditions:** sur Mac, les raccourcis applicatifs utilisent Cmd. Sous Windows, ils restent sur Ctrl
- **Invariants:** aucun test brut de `ctrlKey` dans `src/*.ts`, sauf dans `platform.ts`, dans `rdpkeys.ts` et sur les lignes marquées `// touche transmise`
- **Verify:** `[ ! -f src/platform.ts ] || ! grep -nE '\b(e|ev|event)\.ctrlKey' src/*.ts | grep -vE '^src/(platform|rdpkeys)\.ts:' | grep -v 'touche transmise'`
- **Fix:** remplacer par `isMod(e)`, ou ajouter `// touche transmise, pas un raccourci` si la touche part vers la session distante

## Plateformes de latest.json
- **Owner:** release (S5)
- **Preconditions:** la tâche Windows publie en premier
- **Postconditions:** `latest.json` contient `windows-x86_64`, `darwin-aarch64` et `darwin-x86_64`
- **Invariants:** si `release.yml` contient une tâche macOS, elle dépend de la tâche `windows`
- **Verify:** `! grep -q 'macos-latest' .github/workflows/release.yml || grep -qE 'needs:\s*\[?\s*windows' .github/workflows/release.yml`
- **Fix:** ajouter `needs: windows` à la tâche macOS
