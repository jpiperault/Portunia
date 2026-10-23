use std::sync::Arc;

use crate::connector::{Connector, Manifest};
use crate::connectors;

/// Liste des protocoles disponibles, dans l'ordre d'affichage.
pub struct Registry {
    connectors: Vec<Arc<dyn Connector>>,
}

impl Registry {
    pub fn with_builtins() -> Self {
        let mut registry = Self {
            connectors: Vec::new(),
        };
        registry.register(Arc::new(connectors::ssh::SshConnector));
        registry.register(Arc::new(connectors::rdp::RdpConnector));
        registry.register(Arc::new(connectors::web::WebConnector));
        registry.register(Arc::new(connectors::telnet::TelnetConnector));
        registry.register(Arc::new(connectors::vnc::VncConnector));
        registry.register(Arc::new(connectors::serial::SerialConnector));
        registry
    }

    /// Ajoute un connecteur ; remplace celui qui aurait le même identifiant.
    pub fn register(&mut self, connector: Arc<dyn Connector>) {
        let id = connector.manifest().id;
        self.connectors.retain(|c| c.manifest().id != id);
        self.connectors.push(connector);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Connector>> {
        self.connectors
            .iter()
            .find(|c| c.manifest().id == id)
            .cloned()
    }

    pub fn manifests(&self) -> Vec<Manifest> {
        self.connectors.iter().map(|c| c.manifest()).collect()
    }
}
