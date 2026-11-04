# Copie de ironrdp-client 0.1.0 pour Portunia

Copie de la version publiée sur crates.io (MIT OU Apache-2.0, voir `Cargo.toml`), utilisée par
`portunia-rdp` à la place de l'originale (`[patch.crates-io]` dans `../../Cargo.toml`).

Seul changement : `ConfigBuilder::with_performance_flags` (champ `performance_flags`), pour le
réglage « Qualité » des sessions. La version publiée annonce toujours les options par défaut.
À retirer dès qu'IronRDP propose ce réglage.
