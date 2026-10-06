//! The small SFTP v3 subset used by the browser, over the existing OpenSSH authentication.
//! https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02
use anyhow::{Context as _, Result, bail, ensure};
use std::{
    io::{Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub(crate) struct TransferProgress {
    direction: &'static str,
    latest: Mutex<Option<(String, u64, u64)>>,
}
impl TransferProgress {
    pub(crate) fn new(direction: &'static str) -> Self {
        Self {
            direction,
            latest: Mutex::new(None),
        }
    }
    pub(crate) fn update(&self, path: &str, transferred: u64, total: u64) {
        // Keep only the latest update so fast transfers cannot queue UI work.
        *self.latest.lock().unwrap() = Some((path.to_owned(), transferred, total));
    }
    pub(crate) fn take_status(&self) -> Option<(String, u8)> {
        let (path, transferred, total) = self.latest.lock().unwrap().take()?;
        let percent = if total == 0 {
            100
        } else {
            (u128::from(transferred) * 100 / u128::from(total)).min(100)
        };
        let name = path.rsplit('/').next().unwrap_or(&path);
        Some((
            format!(
                "{} {name} ({} / {})",
                self.direction,
                file_size(transferred),
                file_size(total)
            ),
            percent as u8,
        ))
    }
}

pub(crate) fn file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MiB", bytes as f64 / (1024. * 1024.))
    } else {
        format!("{:.1} GiB", bytes as f64 / (1024. * 1024. * 1024.))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) permissions: u32,
    pub(crate) modified: u32,
}
impl Entry {
    pub(crate) fn is_directory(&self) -> bool {
        self.permissions & 0o170000 == 0o040000
    }
    pub(crate) fn is_symlink(&self) -> bool {
        self.permissions & 0o170000 == 0o120000
    }
    pub(crate) fn permission_text(&self) -> String {
        let mut value = String::from(if self.is_directory() {
            "d"
        } else if self.is_symlink() {
            "l"
        } else {
            "-"
        });
        for (mask, ch) in [
            (0o400, 'r'),
            (0o200, 'w'),
            (0o100, 'x'),
            (0o40, 'r'),
            (0o20, 'w'),
            (0o10, 'x'),
            (0o4, 'r'),
            (0o2, 'w'),
            (0o1, 'x'),
        ] {
            value.push(if self.permissions & mask != 0 {
                ch
            } else {
                '-'
            });
        }
        for (ix, special, executable, yes, no) in [
            (3, 0o4000, 0o100, 's', 'S'),
            (6, 0o2000, 0o10, 's', 'S'),
            (9, 0o1000, 0o1, 't', 'T'),
        ] {
            if self.permissions & special != 0 {
                value.replace_range(
                    ix..ix + 1,
                    &if self.permissions & executable != 0 {
                        yes
                    } else {
                        no
                    }
                    .to_string(),
                );
            }
        }
        value
    }
}

pub(crate) fn child_path(directory: &str, name: &str) -> Result<String> {
    ensure!(
        !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0']),
        "Enter a filename without slashes."
    );
    ensure!(
        directory.starts_with('/') && !directory.contains('\0'),
        "Choose an absolute remote directory."
    );
    Ok(format!("{}/{name}", directory.trim_end_matches('/')))
}

struct Packet {
    kind: u8,
    data: Vec<u8>,
    offset: usize,
}
impl Packet {
    fn take(&mut self, count: usize) -> Result<&[u8]> {
        let end = self
            .offset
            .checked_add(count)
            .context("Invalid SFTP field length")?;
        let value = self
            .data
            .get(self.offset..end)
            .context("Truncated SFTP response")?;
        self.offset = end;
        Ok(value)
    }
    fn integer(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into()?))
    }
    fn string(&mut self) -> Result<Vec<u8>> {
        let len = self.integer()? as usize;
        Ok(self.take(len)?.to_vec())
    }
    fn text(&mut self) -> Result<String> {
        String::from_utf8(self.string()?)
            .context("This server returned a filename that is not UTF-8")
    }
    fn attributes(&mut self, name: String) -> Result<Entry> {
        let flags = self.integer()?;
        ensure!(flags & !0x8000000f == 0, "Unsupported SFTP attributes");
        let size = if flags & 1 != 0 {
            u64::from_be_bytes(self.take(8)?.try_into()?)
        } else {
            0
        };
        if flags & 2 != 0 {
            self.take(8)?;
        }
        let permissions = if flags & 4 != 0 { self.integer()? } else { 0 };
        let modified = if flags & 8 != 0 {
            self.integer()?;
            self.integer()?
        } else {
            0
        };
        if flags & 0x80000000 != 0 {
            let count = self.integer()?;
            ensure!(count <= 4096, "Too many SFTP attributes");
            for _ in 0..count {
                self.string()?;
                self.string()?;
            }
        }
        Ok(Entry {
            name,
            size,
            permissions,
            modified,
        })
    }
    fn status(&mut self) -> Result<u32> {
        ensure!(self.kind == 101, "Unexpected SFTP response ({})", self.kind);
        let code = self.integer()?;
        let message = String::from_utf8_lossy(&self.string()?).into_owned();
        ensure!(code == 0 || code == 1, "SFTP: {message} (code {code})");
        Ok(code)
    }
    fn expect(&mut self, kind: u8) -> Result<()> {
        if self.kind == 101 {
            self.status()?;
            bail!("Unexpected SFTP status response");
        }
        ensure!(
            self.kind == kind,
            "Unexpected SFTP response ({})",
            self.kind
        );
        Ok(())
    }
}
fn string(value: &[u8]) -> Vec<u8> {
    let mut bytes = (value.len() as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(value);
    bytes
}

/// One serialized connection per SSH tab. Only background jobs take the client lock.
#[derive(Default)]
pub(crate) struct Connection {
    client: Mutex<Option<Client>>,
    process: Mutex<Option<Arc<Mutex<Child>>>>,
    closed: AtomicBool,
}
impl Connection {
    pub(crate) fn run<T>(
        &self,
        mut command: impl FnMut() -> Result<Command>,
        retry_read: bool,
        mut operation: impl FnMut(&mut Client) -> Result<T>,
    ) -> Result<T> {
        let mut client = self
            .client
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP connection lock failed"))?;
        for attempt in 0..2 {
            ensure!(
                !self.closed.load(Ordering::Acquire),
                "SFTP connection closed"
            );
            if let Some(client) = client.as_ref() {
                client.set_deadline(None);
            }
            if client.as_mut().is_some_and(|client| !client.is_usable()) {
                client.take();
            }
            if client.is_none() {
                *client = Some(Client::start_inner(
                    command()?,
                    Some(self),
                    Duration::from_secs(30),
                )?);
            }
            let result = operation(client.as_mut().unwrap());
            client.as_ref().unwrap().set_deadline(Some(IDLE_TIMEOUT));
            if self.closed.load(Ordering::Acquire) {
                client.take();
                bail!("SFTP connection closed");
            }
            let broken = !client.as_mut().unwrap().is_usable();
            if broken {
                client.take();
            }
            // Mutations may already have reached the server: never replay them after a lost reply.
            if result.is_err() && broken && retry_read && attempt == 0 {
                continue;
            }
            return result;
        }
        unreachable!()
    }
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        // Separate from the client lock so closing a tab never waits for network I/O.
        if let Ok(process) = self.process.lock()
            && let Some(child) = &*process
        {
            let _ = child.lock().unwrap().kill();
        }
    }
}

pub(crate) struct Client {
    child: Arc<Mutex<Child>>,
    input: ChildStdin,
    output: ChildStdout,
    stderr: Arc<Mutex<String>>,
    deadline: Arc<Mutex<Option<Instant>>>,
    wake_watchdog: mpsc::Sender<()>,
    request_timeout: Duration,
    id: u32,
    healthy: bool,
    posix_rename: bool,
}
impl Client {
    #[cfg(test)]
    pub(crate) fn start(command: Command) -> Result<Self> {
        Self::start_inner(command, None, Duration::from_secs(30))
    }
    fn start_inner(
        mut command: Command,
        connection: Option<&Connection>,
        timeout: Duration,
    ) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Couldn’t start SFTP")?;
        let input = child.stdin.take().context("Missing SFTP input")?;
        let output = child.stdout.take().context("Missing SFTP output")?;
        let mut error_output = child.stderr.take().context("Missing SFTP error output")?;
        let stderr = Arc::new(Mutex::new(String::new()));
        let captured = stderr.clone();
        std::thread::spawn(move || {
            let mut bytes = [0; 1024];
            while let Ok(count) = error_output.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                let mut error = captured.lock().unwrap();
                if error.len() < 8192 {
                    error.push_str(&String::from_utf8_lossy(&bytes[..count]));
                }
            }
        });
        let child = Arc::new(Mutex::new(child));
        let watched = child.clone();
        let deadline = Arc::new(Mutex::new(None::<Instant>));
        let watched_deadline = deadline.clone();
        let (wake_watchdog, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            loop {
                let expires = *watched_deadline.lock().unwrap();
                let next = if let Some(expires) = expires {
                    receiver.recv_timeout(expires.saturating_duration_since(Instant::now()))
                } else {
                    receiver
                        .recv()
                        .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                };
                match next {
                    Ok(()) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Synchronize expiry with activity so an old idle timer cannot kill active work.
                        let deadline = watched_deadline.lock().unwrap();
                        if deadline.is_some_and(|expires| expires <= Instant::now()) {
                            let mut child = watched.lock().unwrap();
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        let mut client = Self {
            child,
            input,
            output,
            stderr,
            deadline,
            wake_watchdog,
            request_timeout: timeout,
            id: 0,
            healthy: true,
            posix_rename: false,
        };
        if let Some(connection) = connection {
            *connection.process.lock().unwrap() = Some(client.child.clone());
            ensure!(
                !connection.closed.load(Ordering::Acquire),
                "SFTP connection closed"
            );
        }
        client.send(1, &3u32.to_be_bytes())?;
        let mut version = client.receive()?;
        ensure!(
            version.kind == 2 && version.integer()? == 3,
            "This server does not support SFTP version 3"
        );
        while version.offset < version.data.len() {
            let name = version.string()?;
            let value = version.string()?;
            if name == b"posix-rename@openssh.com" && value == b"1" {
                client.posix_rename = true;
            }
        }
        Ok(client)
    }
    fn set_deadline(&self, timeout: Option<Duration>) {
        *self.deadline.lock().unwrap() = timeout.map(|timeout| Instant::now() + timeout);
        let _ = self.wake_watchdog.send(());
    }
    fn send(&mut self, kind: u8, data: &[u8]) -> Result<()> {
        self.set_deadline(Some(self.request_timeout));
        self.input
            .write_all(&((data.len() + 1) as u32).to_be_bytes())?;
        self.input.write_all(&[kind])?;
        self.input.write_all(data)?;
        self.input.flush()?;
        Ok(())
    }
    fn receive(&mut self) -> Result<Packet> {
        let mut length = [0; 4];
        if let Err(error) = self.output.read_exact(&mut length) {
            let message = self.stderr.lock().unwrap().trim().to_owned();
            bail!("SFTP connection closed or timed out. {message} ({error})");
        }
        let length = u32::from_be_bytes(length) as usize;
        ensure!(
            (1..=1024 * 1024).contains(&length),
            "Invalid SFTP packet length"
        );
        let mut bytes = vec![0; length];
        self.output.read_exact(&mut bytes)?;
        self.set_deadline(None);
        Ok(Packet {
            kind: bytes[0],
            data: bytes[1..].to_vec(),
            offset: 0,
        })
    }
    fn request(&mut self, kind: u8, data: &[u8]) -> Result<Packet> {
        self.healthy = false;
        self.id = self.id.wrapping_add(1);
        let mut payload = self.id.to_be_bytes().to_vec();
        payload.extend_from_slice(data);
        self.send(kind, &payload)?;
        let mut reply = self.receive()?;
        ensure!(reply.integer()? == self.id, "Mismatched SFTP response ID");
        self.healthy = true;
        Ok(reply)
    }
    fn is_usable(&mut self) -> bool {
        self.healthy
            && self
                .child
                .lock()
                .unwrap()
                .try_wait()
                .is_ok_and(|status| status.is_none())
    }
    fn with_handle<T>(
        &mut self,
        handle: &[u8],
        operation: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        let result = operation(self);
        let close = self.request(4, &string(handle)).and_then(|mut reply| {
            ensure!(reply.status()? == 0, "Couldn’t close the remote handle");
            Ok(())
        });
        let value = result?;
        close?;
        Ok(value)
    }
    pub(crate) fn list(&mut self, path: &str) -> Result<(String, Vec<Entry>)> {
        ensure!(!path.contains('\0'), "Invalid remote path");
        let mut resolved = self.request(16, &string(path.as_bytes()))?;
        resolved.expect(104)?;
        ensure!(resolved.integer()? == 1, "Invalid resolved SFTP path");
        let path = resolved.text()?;
        ensure!(
            path.starts_with('/'),
            "The server returned a relative directory"
        );
        let mut opened = self.request(11, &string(path.as_bytes()))?;
        opened.expect(102)?;
        let handle = opened.string()?;
        let mut entries = self.with_handle(&handle, |client| {
            let mut entries = Vec::new();
            loop {
                let mut reply = client.request(12, &string(&handle))?;
                if reply.kind == 101 {
                    ensure!(reply.status()? == 1, "Unexpected directory response");
                    break;
                }
                reply.expect(104)?;
                let count = reply.integer()?;
                ensure!(count <= 100_000, "Invalid SFTP directory count");
                for _ in 0..count {
                    let name = reply.text()?;
                    reply.string()?; // The human-readable longname is not a machine-readable listing.
                    let entry = reply.attributes(name)?;
                    if entry.name == "." || entry.name == ".." {
                        continue;
                    }
                    child_path(&path, &entry.name)?;
                    entries.push(entry);
                }
                ensure!(
                    entries.len() <= 100_000,
                    "This folder exceeds the 100,000-entry browser limit"
                );
            }
            Ok(entries)
        })?;
        entries.sort_by_cached_key(|entry| {
            (
                !entry.is_directory(),
                entry.name.to_lowercase(),
                entry.name.clone(),
            )
        });
        Ok((path, entries))
    }
    pub(crate) fn create(&mut self, path: &str, directory: bool) -> Result<()> {
        if directory {
            let mut data = string(path.as_bytes());
            data.extend_from_slice(&0u32.to_be_bytes());
            ensure!(
                self.request(14, &data)?.status()? == 0,
                "Couldn’t create the folder"
            );
        } else {
            let mut data = string(path.as_bytes());
            data.extend_from_slice(&(2u32 | 8 | 32).to_be_bytes()); // WRITE | CREAT | EXCL: never truncate an existing file.
            data.extend_from_slice(&0u32.to_be_bytes());
            let mut reply = self.request(3, &data)?;
            reply.expect(102)?;
            let handle = reply.string()?;
            ensure!(
                self.request(4, &string(&handle))?.status()? == 0,
                "Couldn’t close the file"
            );
        }
        Ok(())
    }
    pub(crate) fn rename(&mut self, path: &str, destination: &str) -> Result<()> {
        let mut data = string(path.as_bytes());
        data.extend(string(destination.as_bytes()));
        ensure!(
            self.request(18, &data)?.status()? == 0,
            "Couldn’t rename the entry"
        );
        Ok(())
    }

    pub(crate) fn read_file(&mut self, path: &str, limit: usize) -> Result<(Vec<u8>, u32)> {
        let mut reply = self.request(7, &string(path.as_bytes()))?;
        reply.expect(105)?;
        let entry = reply.attributes(String::new())?;
        ensure!(
            entry.permissions & 0o170000 == 0o100000,
            "Choose a regular file, not a folder or symbolic link"
        );
        ensure!(
            entry.size <= limit as u64,
            "This file exceeds the editor’s size limit"
        );
        let mut data = string(path.as_bytes());
        data.extend_from_slice(&1u32.to_be_bytes());
        data.extend_from_slice(&0u32.to_be_bytes());
        let mut reply = self.request(3, &data)?;
        reply.expect(102)?;
        let handle = reply.string()?;
        let bytes = self.with_handle(&handle, |client| {
            let mut bytes = Vec::new();
            loop {
                let mut data = string(&handle);
                data.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
                data.extend_from_slice(&32768u32.to_be_bytes());
                let mut reply = client.request(5, &data)?;
                if reply.kind == 101 {
                    ensure!(reply.status()? == 1, "Unexpected read status");
                    break;
                }
                reply.expect(103)?;
                let chunk = reply.string()?;
                ensure!(
                    !chunk.is_empty(),
                    "The server returned an empty read packet"
                );
                ensure!(
                    bytes.len() + chunk.len() <= limit,
                    "This file exceeds the editor’s size limit"
                );
                bytes.extend(chunk);
            }
            Ok(bytes)
        })?;
        Ok((bytes, entry.permissions))
    }

    pub(crate) fn save_file(&mut self, path: &str, bytes: &[u8], original: &[u8]) -> Result<()> {
        ensure!(
            self.posix_rename,
            "This server does not support atomic replacement (posix-rename); the original file was preserved"
        );
        let (current, permissions) = self.read_file(path, crate::editor::REMOTE_LIMIT)?;
        ensure!(
            current == original,
            "The remote file changed since it was opened. Cancel and reopen it before saving"
        );
        let (parent, _) = path
            .rsplit_once('/')
            .context("Choose an absolute remote file")?;
        let temporary = child_path(
            if parent.is_empty() { "/" } else { parent },
            &format!(".terminal-edit-{}", uuid::Uuid::new_v4()),
        )?;
        let mut data = string(temporary.as_bytes());
        data.extend_from_slice(&(2u32 | 8 | 32).to_be_bytes()); // WRITE | CREAT | EXCL
        data.extend_from_slice(&4u32.to_be_bytes());
        data.extend_from_slice(&(permissions & 0o777).to_be_bytes());
        let mut reply = self.request(3, &data)?;
        reply.expect(102)?;
        let handle = reply.string()?;
        let result = (|| {
            self.with_handle(&handle, |client| {
                for (ix, chunk) in bytes.chunks(32768).enumerate() {
                    let mut data = string(&handle);
                    data.extend_from_slice(&((ix * 32768) as u64).to_be_bytes());
                    data.extend(string(chunk));
                    ensure!(
                        client.request(6, &data)?.status()? == 0,
                        "Couldn’t write file content"
                    );
                }
                // FSETSTAT restores the mode after the server's creation umask.
                let mut data = string(&handle);
                data.extend_from_slice(&4u32.to_be_bytes());
                data.extend_from_slice(&(permissions & 0o777).to_be_bytes());
                ensure!(
                    client.request(10, &data)?.status()? == 0,
                    "Couldn’t preserve file permissions"
                );
                Ok(())
            })?;
            // OpenSSH extension: atomically replace the original only after a complete write.
            let mut data = string(b"posix-rename@openssh.com");
            data.extend(string(temporary.as_bytes()));
            data.extend(string(path.as_bytes()));
            ensure!(
                self.request(200, &data)?.status()? == 0,
                "Couldn’t replace the remote file"
            );
            Ok(())
        })();
        if result.is_err() {
            let _ = self.request(13, &string(temporary.as_bytes()));
        }
        result
    }
    pub(crate) fn delete(&mut self, path: &str, depth: usize) -> Result<()> {
        ensure!(
            path != "/" && depth < 64,
            "Refusing to delete the remote root or an excessively deep folder"
        );
        let mut reply = self.request(7, &string(path.as_bytes()))?; // LSTAT: never recurse into symlinks.
        reply.expect(105)?;
        let entry = reply.attributes(String::new())?;
        if entry.is_directory() {
            let (_, entries) = self.list(path)?;
            for entry in entries {
                self.delete(&child_path(path, &entry.name)?, depth + 1)?;
            }
        }
        ensure!(
            self.request(
                if entry.is_directory() { 15 } else { 13 },
                &string(path.as_bytes())
            )?
            .status()?
                == 0,
            "Couldn’t delete the entry"
        );
        Ok(())
    }

    pub(crate) fn download_to(
        &mut self,
        path: &str,
        destination: &std::path::Path,
        progress: &mut dyn FnMut(&str, u64, u64),
    ) -> Result<()> {
        let parent = destination
            .parent()
            .context("Choose a download destination")?;
        let temporary = parent.join(format!(".sftp-download-{}.part", uuid::Uuid::new_v4()));
        let result = (|| {
            // Folder replacement is intentionally refused; file replacement follows the native save dialog.
            ensure!(
                !destination.is_dir(),
                "A folder already exists at this destination; choose another folder"
            );
            self.download(path, &temporary, 0, progress)?;
            ensure!(
                !temporary.is_dir() || !destination.exists(),
                "An entry already exists at this destination"
            );
            std::fs::rename(&temporary, destination).context("Couldn’t save the download")?;
            Ok(())
        })();
        if temporary.is_dir() {
            let _ = std::fs::remove_dir_all(&temporary);
        } else {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    pub(crate) fn upload(
        &mut self,
        directory: &str,
        paths: &[std::path::PathBuf],
        progress: &mut dyn FnMut(&str, u64, u64),
    ) -> Result<()> {
        ensure!(!paths.is_empty(), "Choose at least one file or folder");
        for path in paths {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .context("Upload filenames must be UTF-8")?;
            self.upload_path(path, &child_path(directory, name)?, 0, progress)?;
        }
        Ok(())
    }
    fn upload_path(
        &mut self,
        source: &std::path::Path,
        destination: &str,
        depth: usize,
        progress: &mut dyn FnMut(&str, u64, u64),
    ) -> Result<()> {
        ensure!(depth < 64, "This folder is too deeply nested to upload");
        let metadata = source
            .metadata()
            .with_context(|| format!("Couldn’t read {}", source.display()))?;
        ensure!(
            metadata.is_file() || metadata.is_dir(),
            "Only regular files and folders can be uploaded"
        );
        if metadata.is_dir() {
            let mut reply = self.request(17, &string(destination.as_bytes()))?;
            if reply.kind == 101 {
                // Only 'no such file' permits creation; preserve permission and connection errors.
                let code = reply.integer()?;
                let message = String::from_utf8_lossy(&reply.string()?).into_owned();
                ensure!(code == 2, "SFTP: {message} (code {code})");
                self.create(destination, true)?;
            } else {
                reply.expect(105)?;
                ensure!(
                    reply.attributes(String::new())?.is_directory(),
                    "An entry already exists in place of the upload folder"
                );
            }
            for entry in std::fs::read_dir(source)? {
                let entry = entry?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("Upload filenames must be UTF-8"))?;
                self.upload_path(
                    &entry.path(),
                    &child_path(destination, &name)?,
                    depth + 1,
                    progress,
                )?;
            }
        } else {
            let mut file = std::fs::File::open(source)?;
            progress(destination, 0, metadata.len());
            let mut data = string(destination.as_bytes());
            data.extend_from_slice(&(2u32 | 8 | 16).to_be_bytes()); // WRITE | CREAT | TRUNC, matching existing overwrite behavior.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                data.extend_from_slice(&4u32.to_be_bytes());
                data.extend_from_slice(&(metadata.permissions().mode() & 0o777).to_be_bytes());
            }
            #[cfg(not(unix))]
            data.extend_from_slice(&0u32.to_be_bytes());
            let mut reply = self.request(3, &data)?;
            reply.expect(102)?;
            let handle = reply.string()?;
            self.with_handle(&handle, |client| {
                let mut buffer = [0; 32768];
                let mut offset = 0u64;
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    let mut data = string(&handle);
                    data.extend_from_slice(&offset.to_be_bytes());
                    data.extend(string(&buffer[..count]));
                    ensure!(
                        client.request(6, &data)?.status()? == 0,
                        "Couldn’t upload file content"
                    );
                    offset = offset
                        .checked_add(count as u64)
                        .context("Upload is too large")?;
                    progress(destination, offset, metadata.len());
                }
                Ok(())
            })?;
        }
        Ok(())
    }

    fn download(
        &mut self,
        path: &str,
        destination: &std::path::Path,
        depth: usize,
        progress: &mut dyn FnMut(&str, u64, u64),
    ) -> Result<()> {
        ensure!(depth < 64, "This folder is too deeply nested to download");
        let mut reply = self.request(7, &string(path.as_bytes()))?;
        reply.expect(105)?;
        let entry = reply.attributes(String::new())?;
        ensure!(
            !entry.is_symlink(),
            "Symbolic links are not downloaded; choose the link’s target instead"
        );
        if entry.is_directory() {
            std::fs::create_dir(destination)?;
            let (_, entries) = self.list(path)?;
            for entry in entries {
                let local = std::path::Path::new(&entry.name);
                ensure!(
                    local.components().count() == 1
                        && matches!(
                            local.components().next(),
                            Some(std::path::Component::Normal(_))
                        ),
                    "Unsafe local filename"
                );
                self.download(
                    &child_path(path, &entry.name)?,
                    &destination.join(local),
                    depth + 1,
                    progress,
                )?;
            }
        } else {
            ensure!(
                entry.permissions & 0o170000 == 0o100000,
                "Only regular files and folders can be downloaded"
            );
            let mut file = std::fs::File::options()
                .write(true)
                .create_new(true)
                .open(destination)?;
            progress(path, 0, entry.size);
            let mut data = string(path.as_bytes());
            data.extend_from_slice(&1u32.to_be_bytes()); // READ
            data.extend_from_slice(&0u32.to_be_bytes());
            let mut reply = self.request(3, &data)?;
            reply.expect(102)?;
            let handle = reply.string()?;
            self.with_handle(&handle, |client| {
                let mut offset = 0u64;
                loop {
                    let mut data = string(&handle);
                    data.extend_from_slice(&offset.to_be_bytes());
                    data.extend_from_slice(&32768u32.to_be_bytes());
                    let mut reply = client.request(5, &data)?;
                    if reply.kind == 101 {
                        ensure!(reply.status()? == 1, "Unexpected download status");
                        break;
                    }
                    reply.expect(103)?;
                    let bytes = reply.string()?;
                    ensure!(
                        !bytes.is_empty(),
                        "The server returned an empty download packet"
                    );
                    file.write_all(&bytes)?;
                    offset = offset
                        .checked_add(bytes.len() as u64)
                        .context("Download is too large")?;
                    progress(path, offset, entry.size);
                }
                file.sync_all()?;
                Ok(())
            })?;
        }
        Ok(())
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn local_server() -> Option<&'static str> {
        ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server"]
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file())
    }
    #[test]
    fn remote_editor_reads_and_atomically_saves_without_overwriting_conflicts() -> Result<()> {
        let Some(server) = local_server() else {
            return Ok(());
        };
        let root = std::env::temp_dir().join(format!("sftp-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let path = root.join("notes.txt");
        let original = vec![b'x'; 70000];
        std::fs::write(&path, &original)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751))?;
        }
        let mut client = Client::start(Command::new(server))?;
        let path = path.to_str().unwrap();
        assert_eq!(client.read_file(path, original.len())?.0, original);
        assert!(client.read_file(path, original.len() - 1).is_err());
        client.save_file(path, b"edited\r\n", &original)?;
        assert_eq!(std::fs::read(path)?, b"edited\r\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(path)?.permissions().mode() & 0o777, 0o751);
        }
        assert!(client.save_file(path, b"lost", &original).is_err());
        assert_eq!(std::fs::read(path)?, b"edited\r\n");
        client.posix_rename = false;
        assert!(client.save_file(path, b"lost", b"edited\r\n").is_err());
        assert_eq!(std::fs::read(path)?, b"edited\r\n");
        assert_eq!(std::fs::read_dir(&root)?.count(), 1);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
    #[test]
    fn connection_reuses_process_and_reconnects_without_replaying_mutations() -> Result<()> {
        use std::cell::Cell;
        let Some(server) = local_server() else {
            return Ok(());
        };
        let root = std::env::temp_dir().join(format!("sftp-reuse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let path = root.to_str().unwrap();
        let connection = Connection::default();
        let starts = Cell::new(0);
        let command = || {
            starts.set(starts.get() + 1);
            Ok(Command::new(server))
        };
        let pid = connection.run(command, true, |client| {
            client.list(path)?;
            Ok(client.child.lock().unwrap().id())
        })?;
        for _ in 0..3 {
            assert_eq!(
                connection.run(command, true, |client| {
                    client.list(path)?;
                    Ok(client.child.lock().unwrap().id())
                })?,
                pid
            );
        }
        let file = child_path(path, "created.txt")?;
        connection.run(command, false, |client| client.create(&file, false))?;
        assert!(
            connection
                .run(command, false, |client| client.create(&file, false))
                .is_err()
        );
        connection.run(command, true, |client| client.list(path))?;
        assert_eq!(
            starts.get(),
            1,
            "Refreshes and ordinary file errors must preserve the connection"
        );
        let attempts = Cell::new(0);
        connection.run(command, true, |client| {
            if attempts.replace(attempts.get() + 1) == 0 {
                let mut process = client.child.lock().unwrap();
                process.kill()?;
                process.wait()?;
            }
            client.list(path)
        })?;
        assert_eq!(attempts.get(), 2, "A disconnected read should retry once");
        assert_eq!(starts.get(), 2);
        attempts.set(0);
        assert!(
            connection
                .run(command, false, |client| {
                    attempts.set(attempts.get() + 1);
                    let mut process = client.child.lock().unwrap();
                    process.kill()?;
                    process.wait()?;
                    drop(process);
                    client.create(&child_path(path, "must-not-replay")?, false)
                })
                .is_err()
        );
        assert_eq!(
            attempts.get(),
            1,
            "Lost mutation replies must never be replayed"
        );
        connection.run(command, true, |client| client.list(path))?;
        assert_eq!(starts.get(), 3);
        let other_tab = Connection::default();
        let other_pid = other_tab.run(command, true, |client| {
            Ok(client.child.lock().unwrap().id())
        })?;
        let pid = connection.run(command, true, |client| {
            Ok(client.child.lock().unwrap().id())
        })?;
        assert_ne!(pid, other_pid, "Tabs must own independent connections");
        connection.close();
        assert!(
            connection
                .run(command, true, |client| client.list(path))
                .is_err()
        );
        assert_eq!(starts.get(), 4, "A closed tab must not reconnect");
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
    #[test]
    fn idle_expiry_reconnects_and_active_operations_reset_the_five_minute_timer() -> Result<()> {
        let Some(server) = local_server() else {
            return Ok(());
        };
        let connection = Connection::default();
        let starts = std::cell::Cell::new(0);
        let command = || {
            starts.set(starts.get() + 1);
            Ok(Command::new(server))
        };
        let pid = connection.run(command, true, |client| {
            client.list("/")?;
            Ok(client.child.lock().unwrap().id())
        })?;
        {
            let client = connection.client.lock().unwrap();
            let client = client.as_ref().unwrap();
            let remaining = client
                .deadline
                .lock()
                .unwrap()
                .unwrap()
                .duration_since(Instant::now());
            assert!(remaining > Duration::from_secs(299) && remaining <= Duration::from_secs(300));
            // Accelerate idle expiry without making the integration test wait five minutes.
            client.set_deadline(Some(Duration::from_millis(250)));
        }
        connection.run(command, true, |client| {
            std::thread::sleep(Duration::from_millis(500));
            client.list("/")?;
            assert_eq!(
                client.child.lock().unwrap().id(),
                pid,
                "Active operations must not expire"
            );
            Ok(())
        })?;
        {
            let client = connection.client.lock().unwrap();
            let client = client.as_ref().unwrap();
            let remaining = client
                .deadline
                .lock()
                .unwrap()
                .unwrap()
                .duration_since(Instant::now());
            assert!(
                remaining > Duration::from_secs(299),
                "Completion must reset the idle timer"
            );
            client.set_deadline(Some(Duration::from_millis(50)));
        }
        let started = Instant::now();
        while connection
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .try_wait()?
            .is_none()
        {
            ensure!(
                started.elapsed() < Duration::from_secs(2),
                "Idle connection did not close"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        connection.run(command, true, |client| {
            client.list("/")?;
            assert_ne!(client.child.lock().unwrap().id(), pid);
            Ok(())
        })?;
        assert_eq!(
            starts.get(),
            2,
            "The next operation must reconnect automatically"
        );
        Ok(())
    }
    #[test]
    fn idle_connections_survive_request_deadlines_and_recursive_uploads_reuse_them() -> Result<()> {
        let Some(server) = local_server() else {
            return Ok(());
        };
        let root = std::env::temp_dir().join(format!("sftp-upload-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("destination");
        let folder = source.join("folder's name");
        std::fs::create_dir_all(folder.join("empty"))?;
        std::fs::create_dir(&destination)?;
        let payload = vec![0x5a; 100_000];
        std::fs::write(folder.join(".hidden"), &payload)?;
        std::fs::write(folder.join("empty.txt"), [])?;
        let file = source.join("file ; [*]?.txt");
        std::fs::write(&file, b"contents")?;
        let mut client =
            Client::start_inner(Command::new(server), None, Duration::from_millis(250))?;
        let pid = client.child.lock().unwrap().id();
        client.list(destination.to_str().unwrap())?;
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            client.is_usable(),
            "Idle time must not trigger the request watchdog"
        );
        let paths = vec![folder.clone(), file.clone()];
        let mut uploaded = Vec::new();
        client.upload(
            destination.to_str().unwrap(),
            &paths,
            &mut |path, done, total| {
                uploaded.push((path.to_owned(), done, total));
            },
        )?;
        assert_eq!(
            std::fs::read(destination.join("folder's name/.hidden"))?,
            payload
        );
        let mut downloaded = Vec::new();
        client.download_to(
            destination.join("folder's name").to_str().unwrap(),
            &root.join("copy"),
            &mut |path, done, total| downloaded.push((path.to_owned(), done, total)),
        )?;
        assert_eq!(std::fs::read(root.join("copy/.hidden"))?, payload);
        for updates in [&uploaded, &downloaded] {
            let chunks: Vec<_> = updates
                .iter()
                .filter(|(path, _, _)| path.ends_with("/.hidden"))
                .collect();
            assert_eq!(chunks.first().unwrap().1, 0);
            assert_eq!(chunks.last().unwrap().1, payload.len() as u64);
            assert!(
                chunks
                    .iter()
                    .any(|(_, done, _)| *done > 0 && *done < payload.len() as u64)
            );
            assert!(
                chunks
                    .iter()
                    .all(|(_, _, total)| *total == payload.len() as u64)
            );
            assert!(chunks.windows(2).all(|pair| pair[0].1 < pair[1].1));
            assert!(
                updates
                    .iter()
                    .any(|(path, done, total)| path.ends_with("/empty.txt")
                        && *done == 0
                        && *total == 0)
            );
        }
        std::fs::write(folder.join(".hidden"), b"shorter")?;
        client.upload(destination.to_str().unwrap(), &paths, &mut |_, _, _| {})?;
        assert_eq!(
            std::fs::read(destination.join("folder's name/.hidden"))?,
            b"shorter"
        );
        assert_eq!(
            std::fs::read(destination.join("file ; [*]?.txt"))?,
            b"contents"
        );
        assert!(destination.join("folder's name/empty").is_dir());
        assert_eq!(client.child.lock().unwrap().id(), pid);
        // Ordinary file errors must leave the connection usable.
        assert!(
            client
                .download_to(
                    "/does-not-exist-upload-test",
                    &root.join("failed-copy"),
                    &mut |_, _, _| {}
                )
                .is_err()
        );
        client.list(destination.to_str().unwrap())?;
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
    #[test]
    fn transfer_status_keeps_the_latest_file_and_handles_empty_and_large_sizes() {
        let progress = TransferProgress::new("Uploading");
        assert_eq!(progress.take_status(), None);
        progress.update("/srv/first.txt", 0, 1024);
        progress.update("/srv/file with spaces.txt", 1536, 3072);
        assert_eq!(
            progress.take_status(),
            Some((
                "Uploading file with spaces.txt (1.5 KiB / 3.0 KiB)".into(),
                50
            ))
        );
        assert_eq!(progress.take_status(), None);
        progress.update("/srv/empty", 0, 0);
        assert_eq!(
            progress.take_status(),
            Some(("Uploading empty (0 B / 0 B)".into(), 100))
        );
        progress.update("/srv/large", u64::MAX, u64::MAX);
        assert_eq!(progress.take_status().unwrap().1, 100);
        progress.update("/srv/growing", 200, 100);
        assert_eq!(progress.take_status().unwrap().1, 100);
    }
    #[test]
    fn interrupted_download_reports_partial_progress_and_preserves_the_destination() -> Result<()> {
        let Some(server) = local_server() else {
            return Ok(());
        };
        let root = std::env::temp_dir().join(format!("sftp-progress-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let source = root.join("source");
        let destination = root.join("destination");
        std::fs::write(&source, vec![0x42; 100_000])?;
        std::fs::write(&destination, b"original")?;
        let mut client = Client::start(Command::new(server))?;
        let process = client.child.clone();
        let mut updates = Vec::new();
        let result = client.download_to(
            source.to_str().unwrap(),
            &destination,
            &mut |_, done, total| {
                updates.push((done, total));
                if done > 0 {
                    process.lock().unwrap().kill().unwrap();
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(updates.first(), Some(&(0, 100_000)));
        assert!(
            updates
                .last()
                .is_some_and(|(done, total)| *done > 0 && done < total)
        );
        assert_eq!(std::fs::read(&destination)?, b"original");
        assert_eq!(
            std::fs::read_dir(&root)?.count(),
            2,
            "Partial files must be removed"
        );
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
    #[cfg(unix)]
    #[test]
    fn stalled_request_times_out_and_closing_tab_interrupts_a_blocked_request() -> Result<()> {
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 10"]);
        let started = std::time::Instant::now();
        assert!(Client::start_inner(command, None, Duration::from_millis(100)).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        let connection = Arc::new(Connection::default());
        let worker = connection.clone();
        let (created, ready) = mpsc::channel();
        let work = std::thread::spawn(move || {
            worker.run(
                || {
                    created.send(())?;
                    let mut command = Command::new("sh");
                    command.args(["-c", "exec sleep 10"]);
                    Ok(command)
                },
                true,
                |client| client.list("/"),
            )
        });
        ready.recv_timeout(Duration::from_secs(2))?;
        let started = std::time::Instant::now();
        while connection.process.lock().unwrap().is_none() {
            ensure!(
                started.elapsed() < Duration::from_secs(2),
                "SFTP process did not start"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        connection.close();
        assert!(work.join().unwrap().is_err());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "Closing the tab must interrupt the stalled handshake"
        );
        Ok(())
    }
    #[test]
    fn local_sftp_browses_and_mutates_literal_paths_without_following_symlinks() -> Result<()> {
        let server = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server"]
            .iter()
            .find(|path| std::path::Path::new(path).is_file());
        let Some(server) = server else {
            eprintln!(
                "No local OpenSSH sftp-server installed; skipping subsystem integration test"
            );
            return Ok(());
        };
        let root = std::env::temp_dir().join(format!("sftp-browser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let mut client = Client::start(Command::new(server))?;
        let root_path = root.to_str().unwrap();
        let folder = child_path(root_path, "folder with 'quotes'\nand $dollars")?;
        client.create(&folder, true)?;
        let file = child_path(root_path, "file ; [*]?.txt")?;
        client.create(&file, false)?;
        std::fs::write(&file, b"preserve this")?;
        assert!(client.create(&file, false).is_err());
        assert_eq!(std::fs::read(&file)?, b"preserve this");
        let (path, entries) = client.list(root_path)?;
        assert!(path.starts_with('/'));
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_directory());
        assert_eq!(entries[1].size, 13);
        assert!(entries[1].modified > 0);
        assert_eq!(entries[1].permission_text().len(), 10);
        let renamed = child_path(root_path, "renamed.txt")?;
        client.rename(&file, &renamed)?;
        assert!(client.rename(&renamed, &folder).is_err());
        let existing = child_path(root_path, "existing.txt")?;
        std::fs::write(&existing, b"unchanged")?;
        assert!(client.rename(&renamed, &existing).is_err());
        assert_eq!(std::fs::read(&existing)?, b"unchanged");
        client.delete(&existing, 0)?;
        let nested = child_path(&folder, "nested.txt")?;
        client.create(&nested, false)?;
        let payload = vec![0x42; 100_000];
        std::fs::write(&nested, &payload)?;
        let downloaded = root.join("downloaded");
        client.download_to(&folder, &downloaded, &mut |_, _, _| {})?;
        assert_eq!(std::fs::read(downloaded.join("nested.txt"))?, payload);
        assert!(
            client
                .download_to(&folder, &downloaded, &mut |_, _, _| {})
                .is_err(),
            "Existing folders must not be replaced"
        );
        let copy = root.join("copy.txt");
        std::fs::write(&copy, b"original")?;
        assert!(
            client
                .download_to("/missing-sftp-download-test", &copy, &mut |_, _, _| {})
                .is_err()
        );
        assert_eq!(std::fs::read(&copy)?, b"original");
        client.download_to(&renamed, &copy, &mut |_, _, _| {})?;
        assert_eq!(std::fs::read(&copy)?, b"preserve this");
        std::fs::remove_file(copy)?;
        std::fs::remove_dir_all(downloaded)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&renamed, child_path(&folder, "link")?)?;
        #[cfg(unix)]
        assert!(
            client
                .download(
                    &child_path(&folder, "link")?,
                    &root.join("unsafe"),
                    0,
                    &mut |_, _, _| {}
                )
                .is_err()
        );
        client.delete(&folder, 0)?;
        assert!(std::path::Path::new(&renamed).exists());
        client.delete(&renamed, 0)?;
        assert!(client.list(root_path)?.1.is_empty());
        assert!(client.list("/does-not-exist-sftp-test").is_err());
        assert!(client.delete("/", 0).is_err());
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
    #[test]
    fn truncated_and_extreme_sftp_fields_return_errors() {
        let packet = |data: Vec<u8>| Packet {
            kind: 104,
            data,
            offset: 0,
        };
        let mut attributes = 0x8000000fu32.to_be_bytes().to_vec();
        attributes.extend(u64::MAX.to_be_bytes());
        for value in [u32::MAX, u32::MAX, 0o100644, 0, u32::MAX, 1] {
            attributes.extend(value.to_be_bytes());
        }
        attributes.extend(string(b"key"));
        attributes.extend(string(b"value"));
        for end in 0..attributes.len() {
            assert!(
                packet(attributes[..end].to_vec())
                    .attributes("file".into())
                    .is_err(),
                "truncated at byte {end}"
            );
        }
        let entry = packet(attributes).attributes("file".into()).unwrap();
        assert_eq!(entry.size, u64::MAX);
        assert_eq!(entry.modified, u32::MAX);
        for length in [1, 4096, u32::MAX] {
            assert!(packet(length.to_be_bytes().to_vec()).string().is_err());
        }
        assert_eq!(packet(0u32.to_be_bytes().to_vec()).string().unwrap(), b"");
        assert!(packet(string(b"\xff\xfe")).text().is_err());
        assert!(
            packet(0x10u32.to_be_bytes().to_vec())
                .attributes("file".into())
                .is_err()
        );
        let excessive = [0x80, 0, 0, 0, 0, 0, 0x10, 1];
        assert!(
            packet(excessive.to_vec())
                .attributes("file".into())
                .is_err()
        );
        let mut overflow = packet(vec![0]);
        overflow.take(1).unwrap();
        assert!(overflow.take(usize::MAX).is_err());
        assert_eq!(overflow.offset, 1);
    }

    #[test]
    fn rejects_unsafe_names_and_malformed_packets() {
        for name in ["", ".", "..", "../escape", "nested/name", "null\0byte"] {
            assert!(child_path("/tmp", name).is_err());
        }
        let mut packet = Packet {
            kind: 104,
            data: vec![0, 0, 0, 100],
            offset: 0,
        };
        assert!(packet.string().is_err());
        assert_eq!(
            Entry {
                name: String::new(),
                size: 0,
                permissions: 0o104755,
                modified: 0
            }
            .permission_text(),
            "-rwsr-xr-x"
        );
    }
}
