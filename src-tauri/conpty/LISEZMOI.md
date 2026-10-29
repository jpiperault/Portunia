# Console de Windows Terminal (ConPTY)

`conpty.dll` et `OpenConsole.exe` (x64) viennent du paquet NuGet officiel
**Microsoft.Windows.Console.ConPTY 1.25.260930003** (Microsoft, licence MIT,
https://github.com/microsoft/terminal), signés par Microsoft Corporation.

Livrés à côté de `portunia.exe`, ils remplacent la console du système pour les shells
locaux : `portable-pty` charge en priorité un `conpty.dll` présent dans le dossier de
l'application. Plus rapide (mesure dans le message du commit) et plus à jour que la
console fournie avec Windows.

Mise à jour : télécharger une version plus récente du paquet, vérifier les signatures
(`Get-AuthenticodeSignature`), remplacer les deux fichiers.
