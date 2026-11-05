# Copie de ironrdp-client 0.1.0 pour Portunia

Copie de la version publiée sur crates.io (MIT OU Apache-2.0, voir `Cargo.toml`), utilisée par
`portunia-rdp` à la place de l'originale (`[patch.crates-io]` dans `../../Cargo.toml`).

Seul changement : `ConfigBuilder::with_performance_flags` (champ `performance_flags`), pour le
réglage « Qualité » des sessions. La version publiée annonce toujours les options par défaut.
À retirer dès qu'IronRDP propose ce réglage.

Depuis Portunia 0.65 : `ironrdp-rdpsnd-native` sans ses options par défaut (`default-features = false`),
donc sans le décodeur Opus, dont la compilation demande CMake. Le serveur envoie alors le son en PCM.
