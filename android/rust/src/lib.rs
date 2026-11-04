//! Portunia Assistance pour Android : la partie Rust de l'appli.
//!
//! Même liaison que le programme Windows (`aide/src/relay.rs`, repris tel quel) : place sur le
//! relais de la Gate, code à dicter, échange de clés, accord de la personne, puis serveur RDP
//! dans le canal chiffré de bout en bout. L'écran vient de l'appli (capture Android) ; cette
//! première version est en vue seule : la souris et le clavier du dépanneur sont ignorés.
//!
//! Appels depuis Kotlin (`fr.portunia.assist.Native`) : `start`, `answer`, `frame`, `stop`.
//! Retours vers Kotlin (`fr.portunia.assist.Session`) : `onCode`, `onConsent`, `onConnected`,
//! `onEnded`.

#[path = "../../../aide/src/relay.rs"]
mod relay;
mod display;

use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
};

use anyhow::Result;
use ironrdp_server::{
    tokio_rustls::{
        rustls::{
            self,
            pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
        },
        TlsAcceptor,
    },
    KeyboardEvent, MouseEvent, RdpServer, RdpServerInputHandler,
};
use jni::{
    objects::{GlobalRef, JByteBuffer, JClass, JObject, JString, JValue},
    sys::{jboolean, jint},
    JNIEnv, JavaVM,
};

pub type Server = RdpServer;

static FRENCH: AtomicBool = AtomicBool::new(false);

/// Texte dans la langue du téléphone.
pub fn t(en: &'static str, fr: &'static str) -> &'static str {
    if FRENCH.load(Ordering::Relaxed) {
        fr
    } else {
        en
    }
}

/// Certificat TLS jetable (la session est en plus chiffrée de bout en bout par le code).
fn tls() -> Result<TlsAcceptor> {
    let cert = rcgen::generate_simple_self_signed(vec!["portunia-assistance".into()])?;
    let der = CertificateDer::from(cert.cert.der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![der], key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Vue seule : la souris et le clavier du dépanneur ne font rien.
struct ViewOnly;

impl RdpServerInputHandler for ViewOnly {
    fn keyboard(&mut self, _: KeyboardEvent) {}
    fn mouse(&mut self, _: MouseEvent) {}
}

fn server() -> Result<RdpServer> {
    let any: SocketAddr = ([127, 0, 0, 1], 0).into();
    Ok(RdpServer::builder().with_addr(any).with_tls(tls()?).with_input_handler(ViewOnly).with_display_handler(display::Display::new()).build())
}

/// Classe Kotlin qui reçoit les nouvelles de la session.
struct Bridge {
    vm: JavaVM,
    session: GlobalRef,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// Session en cours : de quoi l'arrêter et répondre à la demande d'accès.
struct Running {
    stop: tokio::sync::watch::Sender<bool>,
    answer: mpsc::Sender<i32>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn notify(method: &str, text: &str) {
    let Some(b) = BRIDGE.get() else { return };
    let Ok(mut env) = b.vm.attach_current_thread_permanently() else { return };
    let Ok(s) = env.new_string(text) else { return };
    let class = <&JClass>::from(b.session.as_obj());
    if env.call_static_method(class, method, "(Ljava/lang/String;)V", &[JValue::Object(&s)]).is_err() {
        let _ = env.exception_clear();
    }
}

struct AndroidUi {
    answer: mpsc::Receiver<i32>,
}

impl relay::Ui for AndroidUi {
    fn code(&mut self, code: &str) {
        notify("onCode", code);
    }
    fn consent(&mut self, who: &str) -> Option<bool> {
        while self.answer.try_recv().is_ok() {}
        notify("onConsent", who);
        // 0 : accepté (vue seule), une fois la capture de l'écran lancée par l'appli.
        match self.answer.recv() {
            Ok(0) => Some(false),
            _ => None,
        }
    }
    fn connected(&mut self, who: &str, _control: bool) {
        notify("onConnected", who);
    }
    fn ended(&mut self, reason: &str) {
        notify("onEnded", reason);
    }
}

/// Démarre une assistance sur le relais `url` (wss://acces.exemple.fr/assistance/relais).
#[no_mangle]
pub extern "system" fn Java_fr_portunia_assist_Native_start(mut env: JNIEnv, _: JClass, url: JString, french: jboolean) {
    FRENCH.store(french != 0, Ordering::Relaxed);
    if BRIDGE.get().is_none() {
        let vm = env.get_java_vm();
        let session = env.find_class("fr/portunia/assist/Session").and_then(|c| env.new_global_ref(JObject::from(c)));
        match (vm, session) {
            (Ok(vm), Ok(session)) => {
                let _ = BRIDGE.set(Bridge { vm, session });
            }
            _ => {
                let _ = env.exception_clear();
                return;
            }
        }
    }
    let Ok(url) = env.get_string(&url).map(String::from) else { return };
    let (stop_tx, stop) = tokio::sync::watch::channel(false);
    let (answer_tx, answer) = mpsc::channel();
    if let Some(old) = RUNNING.lock().unwrap().replace(Running { stop: stop_tx, answer: answer_tx }) {
        let _ = old.stop.send(true);
        let _ = old.answer.send(-1);
    }
    display::reset();
    std::thread::spawn(move || {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut ui = AndroidUi { answer };
        let result = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(anyhow::Error::from).and_then(|rt| {
            let local = tokio::task::LocalSet::new();
            rt.block_on(local.run_until(relay::run(&url, None, &mut ui, |_control| server().expect("serveur RDP"), stop)))
        });
        if let Err(e) = result {
            notify("onEnded", &format!("{e:#}"));
        }
    });
}

/// Réponse à la demande d'accès : 0 accepté (vue seule), -1 refusé.
#[no_mangle]
pub extern "system" fn Java_fr_portunia_assist_Native_answer(_: JNIEnv, _: JClass, value: jint) {
    if let Some(r) = RUNNING.lock().unwrap().as_ref() {
        let _ = r.answer.send(value);
    }
}

/// Image de la capture (tampon direct d'un `Image.Plane`, RGBA_8888).
#[no_mangle]
pub extern "system" fn Java_fr_portunia_assist_Native_frame(env: JNIEnv, _: JClass, buffer: JByteBuffer, width: jint, height: jint, stride: jint) {
    let (Ok(ptr), Ok(len)) = (env.get_direct_buffer_address(&buffer), env.get_direct_buffer_capacity(&buffer)) else { return };
    if ptr.is_null() || width <= 0 || height <= 0 || stride <= 0 {
        return;
    }
    // SAFETY : tampon direct valide pendant l'appel (l'image n'est fermée qu'après le retour).
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    display::push(data, width as usize, height as usize, stride as usize);
}

/// Arrêt demandé par la personne (bouton Arrêter ou notification).
#[no_mangle]
pub extern "system" fn Java_fr_portunia_assist_Native_stop(_: JNIEnv, _: JClass) {
    if let Some(r) = RUNNING.lock().unwrap().take() {
        let _ = r.stop.send(true);
        let _ = r.answer.send(-1);
    }
}
