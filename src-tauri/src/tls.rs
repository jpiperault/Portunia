//! Configuration TLS commune (FTPS, S3…) : rustls avec le fournisseur ring et
//! les certificats vérifiés par le magasin de Windows (autorités d'entreprise comprises).

use std::sync::Arc;

use anyhow::Result;
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, SignatureScheme,
};
use rustls_platform_verifier::BuilderVerifierExt;

/// Configuration TLS partagée par la connexion de contrôle et les connexions de
/// données : rustls garde les sessions, ce qui permet leur reprise (exigée par
/// FileZilla Server, vsftpd « require_ssl_reuse »…). Certificats vérifiés avec le
/// magasin de Windows (autorités d'entreprise comprises).
pub fn tls_config(insecure: bool) -> Result<Arc<ClientConfig>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions()?;
    let config = if insecure {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider))).with_no_client_auth()
    } else {
        builder.with_platform_verifier()?.with_no_client_auth()
    };
    Ok(Arc::new(config))
}

/// Certificat auto-signé accepté à la demande (case « Accepter un certificat non vérifié ») ;
/// la signature de l'échange reste vérifiée.
#[derive(Debug)]
struct AcceptAnyCert(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}
