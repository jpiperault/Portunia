# Portunia

**English** · [Français](README.fr.md)

Remote session manager for Windows: all your connections (SSH, Remote Desktop, web consoles, Telnet…) in one window. Lightweight (Tauri 2 + Rust, framework-free interface) and extensible (one protocol = one extension).

Portunia was called **Termoria** until version 0.39. The update to Portunia removes the old app and takes over its data (sessions, vault, settings), copied on first launch; the old `fr.termoria.app` folder stays as a backup copy. The **Portunia Gate** SSH and Remote Desktop Gate plugs in as an extension (see below).

## Installing Portunia

Download `Portunia_x.y.z_x64-setup.exe` from the [Releases](https://github.com/jpiperault/Portunia-releases/releases) and run it. The installer asks whether to install for yourself only (no administrator rights) or for all users of the PC (one administrator prompt); an update keeps the mode chosen the first time. Portunia then updates itself: a banner offers each new version.

## Portunia on macOS

Requires macOS 11 or later, on Apple Silicon or Intel (one universal app).

1. Download `Portunia_x.y.z_universal.dmg` from the [Releases](https://github.com/jpiperault/Portunia-releases/releases), open it and drag Portunia to `Applications`.
2. Portunia is signed ad hoc, not notarized by Apple (no Apple Developer account). The first time, macOS refuses to open it: open `System Settings > Privacy & Security`, scroll to the message about Portunia and click **Open Anyway** (on older macOS: right-click the app, then **Open**). This is asked only once.
3. Updates are offered by the in-app banner and install without this prompt. After an update, macOS may ask again for access to the Keychain (the vault key is stored there, protected by Touch ID if you enabled it): choose **Always Allow**.
4. To move your data from Windows, make a backup in Portunia on Windows and import it on the Mac.

Development on a Mac: install the Xcode command line tools (`xcode-select --install`), Rust from https://rustup.rs and Node.js LTS, then add both targets used by the universal build:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm install
npm run tauri dev
```

The checklist to run before a Mac release is in [docs/recette-macos.md](docs/recette-macos.md).

## Installing the development tools (once)

1. **Visual Studio C++ build tools**: install "Build Tools for Visual Studio" and tick "Desktop development with C++".
2. **Rust**: install `rustup` from https://rustup.rs (choose the `stable-x86_64-pc-windows-msvc` toolchain).
3. **Node.js LTS**: https://nodejs.org
4. WebView2 is already present on Windows 11.

## Running in development

```bash
npm install
npm run tauri dev
```

The first Rust build takes a few minutes, later ones are fast. The RDP engine (`rdp-helper/`) is built automatically on launch.

## Publishing a version

1. Update the version number in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Commit, then push a `vX.Y.Z` tag:
   ```bash
   git tag v0.13.0
   git push origin main --tags
   ```
3. GitHub Actions (`.github/workflows/release.yml`) builds the installer, signs it and publishes the release in the **public** `jpiperault/Portunia-releases` repository (the code stays private), with `latest.json`, which Portunia reads to update itself. A copy of the release, with the list of changes, is also created in this repository. Extra secret: `RELEASES_TOKEN`, an access token with "Contents: Read and write" on that repository.

Signing uses the `~/.tauri/termoria.key` key (original name, kept) (repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). The public key is in `tauri.conf.json`. **Do not lose the private key**: without it, installed versions can no longer be updated.

To build the installer locally: set `TAURI_SIGNING_PRIVATE_KEY` (path or content of the key) and its password, then `npm run tauri build`. The installer is in `src-tauri/target/release/bundle/nsis/`.

## Features

| Protocol | Display | Notes |
|---|---|---|
| SSH | Terminal tab | Private key, password or agent (Pageant / OpenSSH). Jump host (like ProxyJump): a saved SSH session or `user@host:port`, up to 3 chained jumps (`bastion1,bastion2`), taken from ~/.ssh/config on import. Server keys are remembered on first connection, and a changed key blocks the connection. SSH-2 only, compatible with OpenSSH 10. "Legacy equipment compatibility" option for servers that only accept old algorithms (diffie-hellman-group1/14-sha1, aes-cbc, 3des-cbc, hmac-sha1, ssh-dss): used only as a last resort, with a warning in the terminal. |
| Remote Desktop (RDP) | Screen tab (IronRDP) or Windows client | In a tab with the IronRDP engine (NLA authentication, domain account, shared clipboard, file copy with buttons or drag-and-drop, screen automatically fitted to the tab), or in the Windows Remote Desktop client if you prefer. |
| Web interface | Dedicated window | The web window has no access to the app. |
| Telnet | Terminal tab | Unencrypted: keep it to the local network. |
| VNC | Screen tab | Keyboard, mouse, wheel, clipboard both ways, Ctrl+Alt+Del, fit to window. Tight, ZRLE, CopyRect, Raw encodings. |
| Local shell | Terminal tab | PowerShell 7, Windows PowerShell, Command Prompt, WSL distributions, Git Bash and custom shells, through the Windows Terminal console shipped with Portunia (OpenConsole, faster than the system's: keystroke echo 47 → 17 ms, large outputs 11 → 38 MB/s). "This PC" section, "+" menu, Ctrl+Shift+T. |
| Gate (extension) | Terminal or screen tab | "Gates" section of the sidebar: add a [Portunia Gate](https://github.com/jpiperault/Portunia-Gate) Gate (certificate fingerprint checked, password and code, first sign-in with a temporary password and code enrolment by QR code). Allowed servers are shown by folder; each opening uses a one-time token, without typing the code again. Vault (account supplied by the Gate), recorded (credentials asked in the terminal) and jump (end-to-end) modes. Windows servers (RDP badge): opened in a Remote Desktop tab through the Gate, in jump mode (Gate 0.6, end-to-end encrypted) or recorded mode (Gate 0.8, RDCleanPath gateway: the Gate relays and records the session without seeing the password); Windows credentials asked when opening and never kept. Flags sessions that bypass the Gate. In Portunia Teams: Gate administration (servers and vault, accounts, groups, rules, settings) and audit ("Audit" menu of the Gate): video-like session replay, with keystrokes as subtitles, idle time skipped, sensitive commands highlighted, search across all sessions, typed passwords masked (an administrator can reveal them), .cast or transcript export, and the verified audit log. Gate option: each account replays its own sessions ("My sessions"). Gate web portal (Portunia Gate 0.7 and later): Administer › Web portal, a switch to turn it on or off (open web sessions close), public address, allowed group, durations, copy and paste, Turnstile keys and a "Close all web sessions" button. Exposure modes (internal or VPN, Cloudflare Tunnel run by the Gate, direct HTTPS, proxy or WAF, dedicated relay in a DMZ), HTTPS listener, portal certificate (imported PEM or PFX, or Let's Encrypt with renewal) and the Gate's optional hardening status are all set from this screen (Gate 0.17 to 0.21). Enabled in Extensions. Installing the Gate (`installer.sh` wizard) and adding it to Portunia step by step: [Portunia Gate README](https://github.com/jpiperault/Portunia-Gate#install). |
| Remote assistance (extension, needs Portunia Gate 0.11) | Remote Desktop tab | Take control of a relative's or a customer's PC. They go to the Gate page (`https://your-portal/assistance`), download **Portunia Assistance** (no install, no account) and read you a 9-digit code; you type it in "Remote assistance" in the sidebar. They see your name and choose: view only, or view and control. A frame and a session bar stay on their screen (who, since when, pause, take back control, chat, "Stop"); Esc three times also stops. Since 0.81: chat both ways, pause, control asked for and given back, a short network cut resumes without a new code (Gate 0.43), smoother screen (Windows desktop duplication, up to 30 frames per second, only the latest image when the network is slow). Since 0.82: files both ways, through the same encrypted link: drop files or folders (sent as .zip) on the screen or use "Send a file"; the person accepts each file (a warning for programs) and it lands in Downloads\Portunia Assistance; they can send you files they choose themselves, never one you pick on their PC. The image always goes first, a network cut resumes the transfer, and each file is checked (SHA-256). 100 MB per file in the free edition, no limit with Pro. The Gate only relays: the link is encrypted end to end from the code (SPAKE2, ChaCha20-Poly1305), and the code is single use. Administer › Assistance: switch, group of helpers, maximum duration, audit log of each assistance. |
| SFTP (catalogue) | Two-pane files tab | Files over SSH without a terminal: same authentication as SSH (key, agent, password, shared credentials), jump host and Gate, start folders on the server and on this PC. Right click on an SSH session › "Open as files only (SFTP)" reuses its settings. Install it from Extensions › Catalogue. |
| FTP / FTPS (catalogue) | Two-pane files tab | Explicit FTPS by default, implicit FTPS (port 990), passive or active mode, Windows-1252 file names for old servers. TLS session resumption (required by FileZilla Server and vsftpd), certificates checked by Windows; self-signed certificate accepted on request. Connection reopened by itself after inactivity. `ftps://user@host` in quick connect. Installed automatically for those who already have FTP sessions. |
| S3 storage (Pro) | Two-pane files tab | Amazon S3 and compatible services (MinIO, Scaleway, OVH, Wasabi, Cloudflare R2…): buckets, folders, upload and download (up to 5 GB per file), renaming and deleting whole folders. Path-style addressing for MinIO / Ceph. Built-in client (AWS SigV4 signing), without Amazon's SDK. |
| Serial port | Terminal tab | COM ports detected automatically, speed, parity, flow control, line ending. |

Other features:

- two-pane file sessions (SFTP, FTP, S3): this PC on the left, the server on the right, → / F5 to upload and ← / F6 to download, multiple selection, hidden files, Unix permissions, transfer queue with speed, pause and an "if the file exists" rule (ask, replace if newer, replace, skip); copies keep the original's date (SFTP, FTP with MFMT);
- compare and synchronise two folders (Pro): recursive comparison by date and size or size only, exclusion patterns, upload, download or both ways, items to decide highlighted, optional deletion on the server, nothing copied before you confirm;
- extensions catalogue (Extensions page): SFTP and FTP are installed in one click; WebDAV, Windows shares, Azure Blob and Google Cloud Storage will follow;
- sidebar: activity rail (Sessions, Gates, This PC, tools), filter chips by protocol and state, pinned and recent sessions, "All sessions in a table" tab (sort, filters, multiple selection); session toolbar on one line that folds into a "⋯" menu on small screens, side panels (files, notes, server, containers) per tab and closed when a session opens;
- "Quick connect" window (button next to "New session", Ctrl+Shift+Q, or just an address such as `10.0.0.12` in the search box, then Enter): only the address is required; protocol, login, port, password, key and jump host are optional. With SSH, what is missing is typed in the terminal as with PuTTY (`login as:`, then the hidden password if the key and agent are refused). Nothing is saved;
- saved SSH session without a login or password: they are typed in the terminal on each connection (Ctrl+C cancels);
- quick connect without creating a session: type `ssh deploy@10.0.1.12`, `rdp srv-01`, `vnc nas:5901`, `https://nas:5001` or `COM3@9600` in the search box then Enter, or in the palette (Ctrl+Shift+O). With SSH, default key then agent, otherwise the password is asked (and never saved). History of recent connections, "Save as session" button;
- SSH keys: Ed25519 or RSA 4096 creation in ~/.ssh (passphrase recommended), copy of the public key, one-click install on the server of the tab (authorized_keys and permissions fixed), then the session switches to key authentication ("SSH key" button or palette);
- notes per session in Markdown ("Notes" button, right panel): headings, lists, clickable checkboxes, links, code blocks sent to the terminal with one click; saved automatically, marker in the tree, included in the Portunia backup;
- network tools (tab, palette or right click on a session): ping and traceroute without administrator rights, TCP port test (lists and ranges, known services), DNS lookup, Wake-on-LAN (MAC address saved on the session, "Wake up" on right click);
- shared credentials: one account (user, password, key or agent, domain) chosen in several SSH, RDP or VNC sessions; change the password once, they all follow;
- global palette (Ctrl+Shift+O): go to a session, a local shell or an action in a few letters;
- session tree with folders and sub-folders (empty folders allowed), drag and drop to organise, right-click menu (duplicate, open a whole folder…), search (Ctrl+Shift+K), tabs;
- terminal highlighting: errors in red, warnings in orange, successes in green, IP addresses in cyan; editable rules (word, regular expression, colour or background) in Settings, with no effect on vim, htop or recordings;
- terminal: history search (Ctrl+Shift+F), adjustable font and size (Ctrl + wheel), copy/paste on right click, links opened with Ctrl+click;
- split screen (up to 4 sessions side by side) and multi-input (Ctrl+Shift+B) to type the same thing on several servers;
- saved commands (Ctrl+Shift+P): per session, per folder or for all, with {{host}}, {{username}}… variables;
- SSH tunnels: local port (ssh -L), SOCKS5 proxy (ssh -D) and server port to this PC (ssh -R), opened on connection or on demand, listening on loopback only; taken from ~/.ssh/config and PuTTY;
- X11: graphical apps started on the server are shown on this PC (with VcXsrv or X410);
- automatic reconnection after a network cut or sleep (can be turned off in Settings);
- server file browser (SFTP) to the right of SSH sessions: browsing, upload and download of files or whole folders (drag and drop included), editing a remote file in your editor with automatic upload on every save, create, rename, delete, transfer tracking;
- import from ~/.ssh/config, PuTTY and mRemoteNG (with preview and duplicate detection), Portunia backup and restore;
- language: English or French, following Windows (Settings › Appearance to choose);
- appearance: dark, light or Windows theme, 9 terminal palettes (Dracula, Nord, Solarized…), colour per folder (band on sessions, tabs and toolbar, "PRODUCTION" label);
- server dashboard (Pro, SSH sessions to Linux): CPU and memory with charts, swap, load, disks, busiest processes, failed systemd services ("View" shows their log), refreshed every 5 s while the panel is visible;
- command on several servers (Pro): choice of SSH sessions or a whole folder (right click), command or saved command, 8 servers at a time, results side by side (exit code, duration, output, failure filter, copy), stronger confirmation for red folders;
- Proxmox VE (Pro): Proxmox servers in their own sidebar section — nodes, virtual machines and containers with their state, creation wizards (VM: ISO, Windows 11 with UEFI and TPM, VirtIO; CT: templates downloaded from the Proxmox catalogue, fixed IP or DHCP), start/stop, consoles (Proxmox VNC relayed by Portunia), snapshots, backups and restore, clone, migrate, resources, tasks and storage; node management: restart and shut down, package updates (apt dist-upgrade in the node shell), services, system log, network and disks (SMART); since 0.83: native terminal for containers, the node and a VM's serial port (Proxmox termproxy in a real terminal tab, no VNC), SSH or Remote Desktop straight to a machine from the address it reports (QEMU agent), hardware (grow, add or move disks; network cards; CD drive; boot order; CPU type), cloud-init (user, SSH keys, address), ISO and template upload from the PC, task log followed live (opened by itself when a task fails), firewall (datacenter, node, machine), users, API tokens, groups and permissions, Ceph status, storage added (folder, NFS, SMB, Proxmox Backup Server) or removed, node network edited with the pending changes shown before « Apply »; API token or password, certificate pinned by its fingerprint;
- containers (Pro, SSH sessions): the server's Docker or Podman containers and Kubernetes pods, shell in a container or log follow-up in one click (new tab), start, stop, restart;
- monitoring: green or red dot and latency for each server, overview, notifications when a server goes down or comes back (Pro);
- terminal session recording (Pro): asciicast + text files, built-in player with speed and navigation;
- lock with a master password and Windows Hello, at startup and after inactivity (Ctrl+Shift+L);
- Free / Pro / Teams editions, signed licences checked offline (Settings › Licence);
- passwords stored in the Windows Credential Manager, never in clear text on disk;
- sessions saved in `%APPDATA%\fr.portunia.app\sessions.json`.

Performance: terminal output is batched in the core and sent as binary (7 times more throughput with a network source), rendering uses the graphics card when there is one (Settings › Terminal), only visible lines are coloured, and the code of rarely used screens is loaded on demand. Benchmark scripts: `tools/bench`.

Shortcuts: Ctrl+Shift+N new session, Ctrl+Shift+W close tab, Ctrl+Shift+F search, Ctrl+Shift+C / Ctrl+Shift+V copy / paste in the terminal, F2 rename, Del delete.

## Security

- **Passwords** in the Windows Credential Manager, never in clear text on disk; backups and imports contain none.
- **Encrypted data** as soon as a master password is set: sessions, notes, shared credentials and server fingerprints (AES-256-GCM, data key wrapped by the master password via PBKDF2, copy protected by the Windows account for Windows Hello). Forgotten password without Windows Hello: data lost, hence **passphrase-protected backups** (Import / export).
- **Lock** with a master password (PBKDF2, 600,000 iterations) or Windows Hello: when locked, the core refuses every sensitive action (typing in a terminal, files, export…) and the interface is inert; limited attempts (growing delay after 5 failures).
- **SSH servers**: fingerprint shown and confirmed on first connection (or taken from `~/.ssh/known_hosts`), connection blocked if the key changes; old algorithms only on request.
- **Files from a server**: names cleaned (no `..\`, NTFS streams or reserved names); "Edit" refuses types Windows would run (.exe, .bat, .js, .lnk…).
- **Imports**: only the values expected by the form are kept (no hidden command).
- **Terminal**: confirmation before pasting several lines; links opened only over http(s).
- **Interface**: strict content security policy, web windows without access to the app, signed updates.
- **Acceptance tests**: the pre-sale test list is in `docs/recette-avant-vente.html`; the test lab (throwaway servers with Docker Desktop) in `tools/labo`.
- **Dependencies**: `cargo audit` and `npm audit` every week on GitHub (`.github/workflows/securite.yml`); documented exception in `src-tauri/.cargo/audit.toml`.

## Architecture

```
src-tauri/src/       core (Rust)
  connector.rs       extension contract (Connector trait, manifest, fields, views)
  registry.rs        list of available extensions
  connectors/        one extension per file: ssh (and SFTP only), rdp, vnc, web, telnet, serial,
                     ftp, s3, local (+ sftp.rs: files over SSH, forward.rs: tunnels)
  commands.rs        commands called by the interface
  store.rs           saved sessions, folders, colours and commands (JSON)
  secrets.rs         Windows Credential Manager
  importers.rs       ssh config / PuTTY / mRemoteNG import, backup
  license.rs         editions and licence checks (single control point)
  lock.rs            lock (master password, Windows Hello)
  recording.rs       session recording (asciicast, text)
  monitor.rs         monitoring (TCP connection test)
  transfer.rs        whole-folder transfers, remote file editing
  localfs.rs         files of this PC (left pane of file sessions)
  filesync.rs        compare a folder of this PC with a server folder (Pro)
  gate.rs            Gates (API with pinned certificate, one-time tokens)
src/                 interface (TypeScript, no framework)
  main.ts            tree, tabs, split screen, toolbar
  dialog.ts          form generated from the extension's manifest
  terminal.ts        terminal view (xterm.js)
  screen.ts          remote screen view (canvas, keyboard, mouse)
  files.ts           server file browser (side panel, or right pane)
  filesview.ts       two-pane file sessions (SFTP, FTP, S3)
  localpanel.ts      "This PC" pane
  transfers.ts       transfer queue
  syncdialog.ts      "Compare and synchronise" window (Pro)
  library.ts         "All sessions in a table" tab
  tree.ts            session tree (folders, drag and drop)
  menu.ts            context menu
  settings.ts        interface settings
  snippets.ts        saved commands (palette and management)
  tunnels.ts         SSH tunnels (editor and status)
  importexport.ts    import / export
  updates.ts         automatic updates
  security.ts        lock screen, licence
  recordings.ts      recordings list and player
  monitoring.ts      monitoring: dots, overview, alerts
  theme.ts           themes, terminal palettes, folder colours
  localshells.ts     local shells: "This PC" section and settings
  extensions.ts      Extensions page and catalogue
  gate.ts            Portunia Gate extension: sidebar, sign-in, administration
  audit.ts           Portunia Gate audit: sessions and log
  assist.ts          remote assistance: "New assistance" dialog (code)
  auditplayer.ts     session player (subtitles, markers, skipped idle time)
  rdpplayer.ts       Remote Desktop session player (image decoded by the RDP engine)
  i18n.ts            interface language: t("English", "Français") next to each other
rdp-helper/          RDP engine (IronRDP), separate program started for each RDP session or replay
aide/                Portunia Assistance, the program of the person helped (screen shared as RDP, window, consent)
assist-proto/        assistance code, key exchange (SPAKE2) and end-to-end encryption, shared by Portunia and Portunia Assistance
scripts/             RDP engine build, check of t(…) calls (check-i18n.cjs)
tools/license-tool/  publisher tool: signing key and licence generation (do not distribute)
screenshot.html      demo with fake data for screenshots
                     (npx vite, then /screenshot.html?scene=main or ?scene=split&theme=light)
.github/workflows/   automatic release publishing
```

The core knows no protocol. An extension:

1. describes its fields (`Manifest.fields`): the interface builds the form by itself;
2. states its view: `terminal`, `screen` (remote screen in a tab), `desktop` (external app), `web` or `files` (two-pane files tab);
3. implements `connect()`, which returns either a terminal connection or "opened elsewhere".

### Adding a protocol

1. Create `src-tauri/src/connectors/myproto.rs` implementing `Connector` (use `telnet.rs` as a model).
2. Declare it in `connectors/mod.rs` and register it in `Registry::with_builtins()`.
3. Optional: add a `.badge-myproto` colour in `src/styles.css`.

## Third-party components

- Windows Terminal console (`conpty.dll`, `OpenConsole.exe`): Microsoft, MIT licence — see `src-tauri/conpty/`.

## Ideas for later

- External extensions downloaded from the catalogue and loaded without rebuilding (signed, isolated WASM modules).
- Linux version.
