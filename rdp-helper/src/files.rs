//! Copie de fichiers par le presse-papiers RDP (MS-RDPECLIP, flux de fichiers).
//!
//! Le texte reste au presse-papiers Windows (moteur natif d'IronRDP, enveloppé ici) ; les
//! fichiers passent par Portunia : « Envoyer des fichiers » les met au presse-papiers de la
//! session (Ctrl+V dans l'Explorateur du serveur), « Récupérer les fichiers » enregistre dans
//! un dossier de ce poste ceux copiés sur le serveur. Une Gate qui n'autorise pas la copie
//! retire la capacité à la négociation : le moteur l'annonce, l'interface masque les boutons.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use ironrdp_client::rdp::RdpInputEvent;
use ironrdp_cliprdr::backend::{ClipboardMessage, CliprdrBackend, CliprdrBackendFactory};
use ironrdp_cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName, ClipboardGeneralCapabilityFlags,
    FileContentsFlags, FileContentsRequest, FileContentsResponse, FileDescriptor, FormatDataRequest, FormatDataResponse,
    LockDataId,
};
use ironrdp_core::impl_as_any;
use tokio::sync::mpsc::UnboundedSender;

use crate::{emit, Output};

/// Morceau demandé au serveur à chaque requête de contenu.
const CHUNK: u32 = 256 * 1024;

const FILE_CAPS: ClipboardGeneralCapabilityFlags = ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
    .union(ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS)
    .union(ClipboardGeneralCapabilityFlags::CAN_LOCK_CLIPDATA)
    .union(ClipboardGeneralCapabilityFlags::HUGE_FILE_SUPPORT_ENABLED);

/// État partagé entre l'entrée de Portunia et le presse-papiers de la session.
pub(crate) struct Files {
    /// Copie demandée par Portunia (faux : jamais de fichiers, quelle que soit la Gate).
    wanted: bool,
    input: UnboundedSender<RdpInputEvent>,
    /// Capacité négociée avec le serveur (et la Gate).
    negotiated: bool,
    /// Fichiers de ce poste offerts au serveur, dans l'ordre de la liste envoyée.
    outgoing: Vec<(PathBuf, u64)>,
    /// Format « FileGroupDescriptorW » du presse-papiers du serveur, s'il contient des fichiers.
    remote: Option<ClipboardFormatId>,
    /// Dossier choisi, en attente de la liste des fichiers du serveur.
    target: Option<PathBuf>,
    download: Option<Download>,
}

struct Download {
    dir: PathBuf,
    files: Vec<FileDescriptor>,
    clip: Option<u32>,
    index: usize,
    /// Fichier en cours : écrit, taille attendue (None : à demander), reçu.
    current: Option<(File, PathBuf, Option<u64>, u64)>,
    stream: u32,
    saved: usize,
    last: Instant,
}

pub(crate) type Shared = Arc<Mutex<Files>>;

pub(crate) fn shared(wanted: bool, input: UnboundedSender<RdpInputEvent>) -> Shared {
    Arc::new(Mutex::new(Files { wanted, input, negotiated: false, outgoing: Vec::new(), remote: None, target: None, download: None }))
}

fn error(code: &'static str, name: Option<String>) {
    emit(&Output::FileError { code, name });
}

impl Files {
    fn send(&self, message: ClipboardMessage) {
        let _ = self.input.send(RdpInputEvent::Clipboard(message));
    }

    /// « Envoyer des fichiers » : met ces fichiers au presse-papiers de la session.
    pub(crate) fn offer(&mut self, paths: Vec<String>) {
        if !self.negotiated {
            return error("not_allowed", None);
        }
        let mut list = Vec::new();
        let mut outgoing = Vec::new();
        for path in paths.into_iter().map(PathBuf::from) {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            // Les dossiers ne sont pas envoyés : seulement les fichiers choisis.
            if !meta.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else { continue };
            // Noms que le presse-papiers écarterait : la liste doit rester alignée sur `outgoing`.
            if name.is_empty() || name.chars().count() > 259 {
                continue;
            }
            let mut descriptor = FileDescriptor::new(name).with_attributes(ClipboardFileAttributes::NORMAL).with_file_size(meta.len());
            if let Some(time) = meta.modified().ok().and_then(filetime) {
                descriptor = descriptor.with_last_write_time(time);
            }
            list.push(descriptor);
            outgoing.push((path, meta.len()));
        }
        if list.is_empty() {
            return error("nothing_to_send", None);
        }
        let count = list.len();
        self.outgoing = outgoing;
        self.send(ClipboardMessage::SendInitiateFileCopy(list));
        emit(&Output::FilesOffered { count });
    }

    /// « Récupérer les fichiers » : demande la liste des fichiers copiés sur le serveur.
    pub(crate) fn fetch(&mut self, dir: String) {
        let Some(format) = self.remote else {
            return error("no_remote_files", None);
        };
        if self.download.is_some() {
            return error("busy", None);
        }
        self.target = Some(PathBuf::from(dir));
        self.send(ClipboardMessage::SendInitiatePaste(format));
    }

    fn request(&self, d: &Download, flags: FileContentsFlags, position: u64, size: u32) {
        self.send(ClipboardMessage::SendFileContentsRequest(FileContentsRequest {
            stream_id: d.stream,
            index: d.index as i32,
            flags,
            position,
            requested_size: size,
            data_id: d.clip,
        }));
    }

    /// Passe au fichier suivant de la récupération (ou la termine).
    fn next(&mut self) {
        let Some(mut d) = self.download.take() else { return };
        loop {
            if d.index >= d.files.len() {
                emit(&Output::FilesSaved { dir: d.dir.display().to_string(), count: d.saved });
                return;
            }
            let f = &d.files[d.index];
            let folder = match &f.relative_path {
                Some(rel) => rel.split('\\').filter(|p| !p.is_empty() && *p != "." && *p != "..").fold(d.dir.clone(), |p, c| p.join(c)),
                None => d.dir.clone(),
            };
            if f.attributes.is_some_and(|a| a.contains(ClipboardFileAttributes::DIRECTORY)) {
                let _ = std::fs::create_dir_all(folder.join(&f.name));
                d.index += 1;
                continue;
            }
            if ironrdp_cliprdr::is_windows_device_name(&f.name) || std::fs::create_dir_all(&folder).is_err() {
                error("name_refused", Some(f.name.clone()));
                d.index += 1;
                continue;
            }
            let path = free_name(&folder, &f.name);
            match File::create(&path) {
                Ok(file) => {
                    d.stream = d.stream.wrapping_add(1);
                    let size = f.file_size;
                    d.current = Some((file, path, size, 0));
                    match size {
                        Some(0) => {
                            d.current = None;
                            d.saved += 1;
                            d.index += 1;
                            continue;
                        }
                        Some(size) => self.request(&d, FileContentsFlags::RANGE, 0, chunk(size, 0)),
                        None => self.request(&d, FileContentsFlags::SIZE, 0, 8),
                    }
                    self.download = Some(d);
                    return;
                }
                Err(e) => {
                    error("write", Some(format!("{} : {e}", path.display())));
                    d.index += 1;
                }
            }
        }
    }

    fn received(&mut self, response: &FileContentsResponse<'_>) {
        let Some(mut d) = self.download.take() else { return };
        if response.stream_id() != d.stream {
            self.download = Some(d);
            return;
        }
        let Some((mut file, path, size, done)) = d.current.take() else {
            self.download = Some(d);
            return;
        };
        let name = d.files[d.index].name.clone();
        if response.is_error() {
            drop(file);
            let _ = std::fs::remove_file(&path);
            error("refused", Some(name));
            d.index += 1;
            self.download = Some(d);
            return self.next();
        }
        // Réponse à une demande de taille.
        let Some(size) = size else {
            match response.data_as_size() {
                Ok(0) => {
                    d.saved += 1;
                    d.index += 1;
                    self.download = Some(d);
                    return self.next();
                }
                Ok(size) => {
                    d.current = Some((file, path, Some(size), 0));
                    self.request(&d, FileContentsFlags::RANGE, 0, chunk(size, 0));
                    self.download = Some(d);
                }
                Err(_) => {
                    error("size", Some(name));
                    d.index += 1;
                    self.download = Some(d);
                    self.next();
                }
            }
            return;
        };
        let data = response.data();
        if let Err(e) = file.write_all(data) {
            error("write", Some(format!("{} : {e}", path.display())));
            d.index += 1;
            self.download = Some(d);
            return self.next();
        }
        let done = done + data.len() as u64;
        if done >= size || data.is_empty() {
            d.saved += 1;
            d.index += 1;
            emit(&Output::FileProgress { name, done, total: size });
            self.download = Some(d);
            return self.next();
        }
        if d.last.elapsed().as_millis() >= 250 {
            d.last = Instant::now();
            emit(&Output::FileProgress { name, done, total: size });
        }
        d.current = Some((file, path, Some(size), done));
        self.request(&d, FileContentsFlags::RANGE, done, chunk(size, done));
        self.download = Some(d);
    }

    /// Le serveur lit un fichier offert : taille, ou morceau.
    fn serve(&self, request: &FileContentsRequest) {
        let reply = |r: FileContentsResponse<'static>| self.send(ClipboardMessage::SendFileContentsResponse(r));
        let Some((path, size)) = usize::try_from(request.index).ok().and_then(|i| self.outgoing.get(i)) else {
            return reply(FileContentsResponse::new_error(request.stream_id));
        };
        if request.flags.contains(FileContentsFlags::SIZE) {
            return reply(FileContentsResponse::new_size_response(request.stream_id, *size));
        }
        let read = || -> std::io::Result<Vec<u8>> {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(request.position))?;
            let mut data = Vec::with_capacity(request.requested_size.min(CHUNK * 4) as usize);
            file.take(u64::from(request.requested_size)).read_to_end(&mut data)?;
            Ok(data)
        };
        match read() {
            Ok(data) => {
                let end = request.position + data.len() as u64 >= *size;
                reply(FileContentsResponse::new_data_response(request.stream_id, data));
                if end {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    emit(&Output::FileSent { name });
                }
            }
            Err(_) => reply(FileContentsResponse::new_error(request.stream_id)),
        }
    }
}

fn chunk(size: u64, done: u64) -> u32 {
    (size - done).min(u64::from(CHUNK)) as u32
}

/// Nom libre dans ce dossier : « rapport.pdf », sinon « rapport (2).pdf »…
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Date Windows (FILETIME : centaines de nanosecondes depuis 1601).
fn filetime(t: SystemTime) -> Option<u64> {
    let since = t.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_secs() * 10_000_000 + u64::from(since.subsec_nanos() / 100) + 116_444_736_000_000_000)
}

// ---------- Presse-papiers enveloppé ----------

pub(crate) struct Factory {
    pub(crate) inner: Box<dyn CliprdrBackendFactory + Send>,
    pub(crate) files: Shared,
}

impl CliprdrBackendFactory for Factory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(Backend { inner: self.inner.build_cliprdr_backend(), files: self.files.clone() })
    }
}

pub(crate) struct Backend {
    inner: Box<dyn CliprdrBackend>,
    files: Shared,
}

impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Backend").field("inner", &self.inner).finish_non_exhaustive()
    }
}

impl_as_any!(Backend);

impl Backend {
    fn files(&self) -> std::sync::MutexGuard<'_, Files> {
        self.files.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl CliprdrBackend for Backend {
    fn temporary_directory(&self) -> &str {
        self.inner.temporary_directory()
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        let caps = self.inner.client_capabilities();
        if self.files().wanted { caps | FILE_CAPS } else { caps }
    }

    fn on_ready(&mut self) {
        self.inner.on_ready();
    }

    fn on_request_format_list(&mut self) {
        self.inner.on_request_format_list();
    }

    fn on_format_list_response(&mut self, ok: bool) {
        self.inner.on_format_list_response(ok);
    }

    fn on_process_negotiated_capabilities(&mut self, capabilities: ClipboardGeneralCapabilityFlags) {
        let allowed = {
            let mut files = self.files();
            files.negotiated = files.wanted && capabilities.contains(ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED);
            files.negotiated
        };
        emit(&Output::Files { allowed });
        self.inner.on_process_negotiated_capabilities(capabilities - FILE_CAPS);
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let format = available_formats.iter().find(|f| f.name.as_ref().is_some_and(|n| n.value() == ClipboardFormatName::FILE_LIST.value())).map(|f| f.id);
        {
            let mut files = self.files();
            let before = files.remote.is_some();
            files.remote = format.filter(|_| files.negotiated);
            if before || files.remote.is_some() {
                emit(&Output::RemoteFiles { available: files.remote.is_some() });
            }
        }
        // Le presse-papiers de Windows ne reçoit que le reste (texte, images).
        if format.is_some() {
            let rest: Vec<ClipboardFormat> = available_formats.iter().filter(|f| Some(f.id) != format && f.name.as_ref().is_none_or(|n| n.value() != "FileContents")).cloned().collect();
            self.inner.on_remote_copy(&rest);
        } else {
            self.inner.on_remote_copy(available_formats);
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        self.inner.on_format_data_request(request);
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        // Liste de fichiers illisible ou refusée : la récupération demandée n'aura pas lieu.
        if response.is_error() && self.files().target.take().is_some() {
            error("no_list", None);
        }
        self.inner.on_format_data_response(response);
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        self.files().serve(&request);
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        self.files().received(&response);
    }

    fn on_lock(&mut self, data_id: LockDataId) {
        self.inner.on_lock(data_id);
    }

    fn on_unlock(&mut self, data_id: LockDataId) {
        self.inner.on_unlock(data_id);
    }

    fn on_remote_file_list(&mut self, files: &[FileDescriptor], clip_data_id: Option<u32>) {
        let mut state = self.files();
        let Some(dir) = state.target.take() else { return };
        if files.is_empty() {
            return error("no_remote_files", None);
        }
        state.download = Some(Download {
            dir,
            files: files.to_vec(),
            clip: clip_data_id,
            index: 0,
            current: None,
            stream: 0,
            saved: 0,
            last: Instant::now(),
        });
        state.next();
    }

    fn on_outgoing_locks_cleared(&mut self, clip_data_ids: &[LockDataId]) {
        self.inner.on_outgoing_locks_cleared(clip_data_ids);
    }

    fn on_outgoing_locks_expired(&mut self, clip_data_ids: &[LockDataId]) {
        self.inner.on_outgoing_locks_expired(clip_data_ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nom_libre() {
        let dir = std::env::temp_dir().join(format!("portunia-rdp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "rapport.pdf"), dir.join("rapport.pdf"));
        std::fs::write(dir.join("rapport.pdf"), b"x").unwrap();
        assert_eq!(free_name(&dir, "rapport.pdf"), dir.join("rapport (2).pdf"));
        std::fs::write(dir.join("LISEZMOI"), b"x").unwrap();
        assert_eq!(free_name(&dir, "LISEZMOI"), dir.join("LISEZMOI (2)"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn morceaux() {
        assert_eq!(chunk(10, 0), 10);
        assert_eq!(chunk(u64::from(CHUNK) * 3, u64::from(CHUNK)), CHUNK);
        assert_eq!(chunk(u64::from(CHUNK) + 5, u64::from(CHUNK)), 5);
    }

    #[test]
    fn date_windows() {
        // 1er janvier 1970 en FILETIME.
        assert_eq!(filetime(UNIX_EPOCH), Some(116_444_736_000_000_000));
    }
}
