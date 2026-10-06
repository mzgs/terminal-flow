use crate::storage::{Authentication, SshProfile, Store};
use anyhow::{Context as _, Result, ensure};
use portable_pty::CommandBuilder;
use std::{
    path::Path,
    process::{Command, Stdio},
};

#[cfg(test)]
use std::path::PathBuf;

pub(crate) struct HostKeyRecovery {
    startup_output: Option<Vec<u8>>,
    pending: bool,
}

impl Default for HostKeyRecovery {
    fn default() -> Self {
        Self {
            startup_output: Some(Vec::new()),
            pending: false,
        }
    }
}

impl HostKeyRecovery {
    pub(crate) fn observe(&mut self, bytes: &[u8]) {
        let Some(output) = &mut self.startup_output else {
            return;
        };
        output.extend_from_slice(bytes);
        let text = String::from_utf8_lossy(output);
        // Stop before remote shell output can be mistaken for an OpenSSH warning.
        if text.contains("\x1b]7;file://") {
            self.startup_output = None;
        } else if text
            .to_ascii_lowercase()
            .contains("host identification has changed")
        {
            self.pending = true;
            // Only one cleanup per tab, even if the replacement connection fails.
            self.startup_output = None;
        } else if output.len() > 8192 {
            output.drain(..output.len() - 8192);
        }
    }

    pub(crate) fn is_pending(&self) -> bool {
        self.pending
    }

    pub(crate) fn take_pending(&mut self) -> bool {
        std::mem::take(&mut self.pending)
    }
}

pub(crate) fn remove_known_host(profile: &SshProfile) -> Result<()> {
    profile.validate()?;
    let path = dirs::home_dir()
        .context("Couldn’t locate your home folder")?
        .join(".ssh/known_hosts");
    remove_known_host_from(&path, &profile.host, profile.port)
}

fn remove_known_host_from(path: &Path, host: &str, port: u16) -> Result<()> {
    if !path
        .try_exists()
        .context("Couldn’t read the saved SSH host keys")?
    {
        return Ok(());
    }
    ensure!(
        path.is_file(),
        "SSH known_hosts is not a file: {}",
        path.display()
    );
    // A nonstandard port has its own trust entry; leave other ports untouched.
    let target = if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    };
    // OpenSSH handles hashed entries and keeps the original file as known_hosts.old.
    let output = Command::new("ssh-keygen")
        .args(["-R", &target, "-f"])
        .arg(path)
        .output()
        .context("Couldn’t start SSH host key cleanup")?;
    ensure!(
        output.status.success(),
        "Couldn’t remove the saved SSH host key for {target}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

pub(crate) fn command(
    profile: &SshProfile,
    directory: &str,
    store: &Store,
) -> Result<CommandBuilder> {
    profile.validate()?;
    let password = profile
        .secret
        .as_ref()
        .map(|secret| store.decrypt(&profile.id, secret))
        .transpose()?;
    build_command(profile, directory, password.as_deref())
}

fn build_command(
    profile: &SshProfile,
    directory: &str,
    password: Option<&str>,
) -> Result<CommandBuilder> {
    let mut command = CommandBuilder::new("ssh");
    command.arg("-tt");
    configure_authentication(&mut command, profile, password)?;
    command.arg("-p");
    command.arg(profile.port.to_string());
    command.arg("-l");
    command.arg(&profile.username);
    command.arg("--");
    command.arg(&profile.host);
    command.arg(remote_command(directory));
    Ok(command)
}

fn configure_authentication(
    command: &mut CommandBuilder,
    profile: &SshProfile,
    password: Option<&str>,
) -> Result<()> {
    profile.validate()?;
    command.args([
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "NumberOfPasswordPrompts=1",
    ]);
    if profile.authentication == Authentication::Password {
        ensure!(
            password.is_some_and(|password| !password.is_empty()),
            "Enter a password in the SSH profile before connecting."
        );
        command.args([
            "-o",
            "PreferredAuthentications=password,keyboard-interactive",
            "-o",
            "PubkeyAuthentication=no",
        ]);
    } else if let Some(path) = &profile.private_key {
        ensure!(
            path.is_file(),
            "The private key file no longer exists: {}",
            path.display()
        );
        command.arg("-i");
        command.arg(path);
        command.args(["-o", "IdentitiesOnly=yes"]);
    }
    if let Some(password) = password.filter(|password| !password.is_empty()) {
        // OpenSSH launches the current executable as askpass. The secret stays out of argv.
        command.env(
            "SSH_ASKPASS",
            std::env::current_exe().context("Couldn’t locate the SSH password helper")?,
        );
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("DISPLAY", "terminal:0");
        command.env("LOCAL_TERMINAL_ASKPASS", "1");
        command.env("LOCAL_TERMINAL_SSH_SECRET", password);
    } else {
        // Agent/default keys work without a prompt; missing key credentials fail clearly.
        command.args(["-o", "BatchMode=yes"]);
    }
    Ok(())
}

#[cfg(test)]
fn upload_command(
    profile: &SshProfile,
    directory: &str,
    paths: &[PathBuf],
    password: Option<&str>,
) -> Result<Command> {
    ensure!(
        directory.starts_with('/') && !directory.contains('\0'),
        "The remote working directory is not available yet."
    );
    ensure!(!paths.is_empty(), "Drop at least one file or folder.");
    let mut builder = CommandBuilder::new("scp");
    configure_authentication(&mut builder, profile, password)?;
    builder.args(["-r", "-P"]);
    builder.arg(profile.port.to_string());
    builder.arg("--");
    for path in paths {
        let metadata = path
            .metadata()
            .with_context(|| format!("Couldn’t read {}", path.display()))?;
        ensure!(
            metadata.is_file() || metadata.is_dir(),
            "Only files and folders can be uploaded: {}",
            path.display()
        );
        // Absolute paths keep filenames containing ':' from being treated as remote hosts.
        builder.arg(std::path::absolute(path)?);
    }
    let host = if profile.host.contains(':') {
        format!("[{}]", profile.host)
    } else {
        profile.host.clone()
    };
    // OpenSSH scp uses SFTP; the directory is a literal protocol path, not shell source.
    builder.arg(format!(
        "{}@{host}:{}/",
        profile.username,
        directory.trim_end_matches('/')
    ));
    Ok(process_command(&builder))
}

fn process_command(builder: &CommandBuilder) -> Command {
    let mut command = Command::new(&builder.get_argv()[0]);
    command.args(&builder.get_argv()[1..]);
    command.envs(builder.iter_extra_env_as_str());
    command.stdin(Stdio::null());
    command
}

pub(crate) fn sftp_command(profile: &SshProfile, store: &Store) -> Result<Command> {
    let password = profile
        .secret
        .as_ref()
        .map(|secret| store.decrypt(&profile.id, secret))
        .transpose()?;
    let mut builder = CommandBuilder::new("ssh");
    configure_authentication(&mut builder, profile, password.as_deref())?;
    builder.args(["-T", "-s", "-p"]);
    builder.arg(profile.port.to_string());
    builder.args(["-l", &profile.username, "--", &profile.host, "sftp"]);
    Ok(process_command(&builder))
}

pub(crate) fn selected_path(selection: &str) -> Result<&str> {
    let selection = selection.trim();
    // ponytail: an unquoted trailing * is an ls -F marker; quote literal trailing stars.
    let selection = selection.strip_suffix('*').unwrap_or(selection);
    // ponytail: handle surrounding listing quotes; mixed shell quoting needs a parser.
    let selection = selection
        .strip_prefix('\'')
        .and_then(|path| path.strip_suffix('\''))
        .or_else(|| {
            selection
                .strip_prefix('"')
                .and_then(|path| path.strip_suffix('"'))
        })
        .unwrap_or(selection);
    ensure!(
        !selection.is_empty() && !selection.chars().any(char::is_control),
        "Select a single filename or path."
    );
    Ok(selection)
}

pub(crate) fn download_path(directory: &str, selection: &str) -> Result<String> {
    let selection = selected_path(selection)?;
    let name = selection.rsplit('/').next().unwrap_or_default();
    ensure!(
        !name.is_empty() && name != "." && name != "..",
        "Select a file to download."
    );
    if selection.starts_with('/') {
        return Ok(selection.to_owned());
    }
    ensure!(
        directory.starts_with('/') && !directory.chars().any(char::is_control),
        "The remote working directory is not available yet. Wait for the remote prompt."
    );
    Ok(format!("{}/{selection}", directory.trim_end_matches('/')))
}

#[cfg(test)]
fn download_command(profile: &SshProfile, path: &str, password: Option<&str>) -> Result<Command> {
    let path = download_path("", path)?;
    let mut builder = CommandBuilder::new("scp");
    configure_authentication(&mut builder, profile, password)?;
    builder.arg("-P");
    builder.arg(profile.port.to_string());
    builder.arg("--");
    let host = if profile.host.contains(':') {
        format!("[{}]", profile.host)
    } else {
        profile.host.clone()
    };
    // Remote sources are SFTP glob patterns; escape them to fetch one literal file.
    let mut literal = String::new();
    for character in path.chars() {
        if "\\*?[]".contains(character) {
            literal.push('\\');
        }
        literal.push(character);
    }
    builder.arg(format!("{}@{host}:{literal}", profile.username));
    Ok(process_command(&builder))
}

#[cfg(test)]
fn download_file(mut command: Command, destination: &Path) -> Result<()> {
    let temporary =
        destination.with_file_name(format!(".terminal-download-{}.part", uuid::Uuid::new_v4()));
    std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .context("Couldn’t create the download file")?;
    command.arg(&temporary);
    let result = (|| {
        let output = command
            .output()
            .context("Couldn’t start the SSH download")?;
        ensure!(
            output.status.success(),
            "Download failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        // Replace the destination only after the complete download succeeds.
        std::fs::rename(&temporary, destination)
            .with_context(|| format!("Couldn’t save download to {}", destination.display()))?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temporary);
    result
}

pub(crate) fn askpass() -> bool {
    if std::env::var("LOCAL_TERMINAL_ASKPASS").as_deref() != Ok("1") {
        return false;
    }
    let prompt = std::env::args().nth(1).unwrap_or_default().to_lowercase();
    if (prompt.contains("password") || prompt.contains("passphrase"))
        && let Ok(secret) = std::env::var("LOCAL_TERMINAL_SSH_SECRET")
    {
        println!("{secret}");
    } else {
        std::process::exit(1);
    }
    true
}

pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_command(directory: &str) -> String {
    let cd = if directory.is_empty() {
        String::new()
    } else {
        format!("cd -- {} 2>/dev/null || :", quote(directory))
    };
    // Escape URL delimiters before emitting OSC 7 so paths containing %, # or ? round-trip.
    let emit = r#"printf '\033]7;file://localhost%s\007' "$(printf '%s' "$PWD" | sed 's/%/%25/g;s/#/%23/g;s/?/%3F/g')""#;
    let prompt = quote(emit);
    // OSC 7 lets WezTerm record the remote directory without polling a local SSH process.
    let script = format!(
        r#"shell_path=${{SHELL:-/bin/sh}}
{cd}
emit_cwd() {{ {emit}; }}
case "${{shell_path##*/}}" in
  bash)
    export PROMPT_COMMAND={prompt}
    ;;
  zsh)
    terminal_zdotdir=$(mktemp -d "${{TMPDIR:-/tmp}}/rust-terminal-zsh.XXXXXX") || terminal_zdotdir=
    if [ -n "$terminal_zdotdir" ]; then
      cat >"$terminal_zdotdir/.zshenv" <<'EOF'
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
EOF
      cat >"$terminal_zdotdir/.zprofile" <<'EOF'
[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"
EOF
      cat >"$terminal_zdotdir/.zshrc" <<'EOF'
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
function _rust_terminal_cwd() {{ {emit}; }}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _rust_terminal_cwd
EOF
      cat >"$terminal_zdotdir/.zlogin" <<'EOF'
[[ -f "$HOME/.zlogin" ]] && source "$HOME/.zlogin"
EOF
      cat >"$terminal_zdotdir/.zlogout" <<'EOF'
command rm -rf -- "$ZDOTDIR"
EOF
      emit_cwd
      exec env ZDOTDIR="$terminal_zdotdir" "$shell_path" -il
    fi
    ;;
esac
emit_cwd
exec "$shell_path" -il"#
    );
    format!("sh -lc {}", quote(&script))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_host_keys_recover_once_and_only_during_startup() {
        let mut recovery = HostKeyRecovery::default();
        recovery.observe(b"@ WARNING: REMOTE HOST IDENTIFI");
        assert!(!recovery.is_pending());
        recovery.observe(b"CATION HAS CHANGED! @\r\n");
        assert!(recovery.take_pending());
        recovery.observe(b"WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!");
        assert!(!recovery.take_pending());

        let mut recovery = HostKeyRecovery::default();
        recovery.observe(b"Permission denied. Host key verification failed.\r\n");
        assert!(!recovery.take_pending());
        recovery.observe(b"\x1b]7;file:");
        recovery.observe(b"//localhost/root\x07");
        recovery.observe(b"WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!");
        assert!(!recovery.take_pending());

        let mut recovery = HostKeyRecovery::default();
        recovery.observe(&vec![b'x'; 16000]);
        assert_eq!(recovery.startup_output.as_ref().unwrap().len(), 8192);
        recovery.observe(b"warning: remote host identification has changed!");
        assert!(recovery.take_pending());
    }

    #[test]
    fn host_key_cleanup_removes_hashed_entries_and_preserves_other_hosts_and_ports() -> Result<()> {
        let root = std::env::temp_dir().join(format!("terminal-host-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root)?;
        let key = root.join("test-key");
        let output = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .output()?;
        assert!(output.status.success());
        let public_key = std::fs::read_to_string(key.with_extension("pub"))?;
        let known_hosts = root.join("known_hosts");
        let entries = format!(
            "89.252.141.17 {public_key}[89.252.141.17]:2222 {public_key}unrelated.example {public_key}"
        );
        std::fs::write(&known_hosts, &entries)?;
        let output = Command::new("ssh-keygen")
            .args(["-H", "-f"])
            .arg(&known_hosts)
            .output()?;
        assert!(output.status.success());
        let original = std::fs::read(&known_hosts)?;
        assert!(String::from_utf8_lossy(&original).starts_with("|1|"));
        remove_known_host_from(&known_hosts, "89.252.141.17", 2222)?;
        let remaining = std::fs::read_to_string(&known_hosts)?;
        assert_eq!(remaining.lines().count(), 2);
        assert_eq!(std::fs::read(known_hosts.with_extension("old"))?, original);
        for (host, exists) in [
            ("89.252.141.17", true),
            ("[89.252.141.17]:2222", false),
            ("unrelated.example", true),
        ] {
            let output = Command::new("ssh-keygen")
                .args(["-F", host, "-f"])
                .arg(&known_hosts)
                .output()?;
            assert_eq!(output.status.success(), exists, "{host}");
        }
        remove_known_host_from(&known_hosts, "89.252.141.17", 22)?;
        assert_eq!(std::fs::read_to_string(&known_hosts)?.lines().count(), 1);
        remove_known_host_from(&root.join("missing"), "89.252.141.17", 22)?;
        // Directories are not silently treated as a missing known_hosts file.
        assert!(remove_known_host_from(&root, "89.252.141.17", 22).is_err());
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn selected_download_paths_are_literal_and_require_a_current_directory() -> Result<()> {
        assert_eq!(
            download_path("/srv/current", " report.txt ")?,
            "/srv/current/report.txt"
        );
        assert_eq!(download_path("/", "-report.txt")?, "/-report.txt");
        assert_eq!(download_path("", "/tmp/report.txt")?, "/tmp/report.txt");
        for selection in ["codex*", "'codex'*", "\"codex\"*"] {
            assert_eq!(download_path("/root", selection)?, "/root/codex");
        }
        for selection in ["'literal*'", "\"literal*\"", "'literal*'*"] {
            assert_eq!(download_path("/root", selection)?, "/root/literal*");
        }
        let name = "Generated Image March 25, 2026 - 12_51PM.png";
        for quote in ['\'', '"'] {
            assert_eq!(
                download_path("/root", &format!("{quote}{name}{quote}"))?,
                format!("/root/{name}")
            );
            assert_eq!(
                download_path("", &format!("{quote}/root/{name}{quote}"))?,
                format!("/root/{name}")
            );
        }
        assert_eq!(
            download_path("/srv", "\"file's $HOME.txt\"")?,
            "/srv/file's $HOME.txt"
        );
        assert_eq!(
            download_path("/srv", "folder/a file's $HOME;[x]?.txt")?,
            "/srv/folder/a file's $HOME;[x]?.txt"
        );
        for selection in [
            "",
            "  ",
            "''",
            "\"\"",
            "*",
            "''*",
            ".",
            "..",
            "folder/",
            "one\ntwo",
            "file\0name",
        ] {
            assert!(download_path("/srv", selection).is_err(), "{selection:?}");
        }
        assert!(download_path("", "report.txt").is_err());
        assert!(download_path("relative", "report.txt").is_err());
        Ok(())
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn downloads_overwrite_existing_files_and_preserve_them_when_transfer_fails() -> Result<()> {
        let root = std::env::temp_dir().join(format!("terminal-download-{}", uuid::Uuid::new_v4()));
        let source = root.join("remote dir [x] ?");
        let downloads = root.join("Downloads");
        std::fs::create_dir_all(&source)?;
        std::fs::create_dir_all(&downloads)?;
        let name = "résumé: file's $HOME; [x]*?\\.txt";
        let file = source.join(name);
        std::fs::write(&file, b"download contents")?;
        let destination = downloads.join(name);
        let profile = SshProfile {
            name: "Download test".into(),
            host: "::1".into(),
            port: 2222,
            ..SshProfile::default()
        };
        let make_command = |path: &Path| -> Result<Command> {
            let command =
                download_command(&profile, path.to_str().unwrap(), Some("private-password"))?;
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert!(args.windows(2).any(|args| args == ["-P", "2222"]));
            assert!(args.last().unwrap().starts_with("root@[::1]:/"));
            assert!(!args.join(" ").contains("private-password"));
            assert!(
                command
                    .get_envs()
                    .any(|(key, value)| key == "SSH_ASKPASS_REQUIRE"
                        && value == Some(std::ffi::OsStr::new("force")))
            );
            let port_ix = args.iter().position(|arg| arg == "-P").unwrap();
            let mut local = Command::new("scp");
            local
                .args(["-D", "/usr/libexec/sftp-server"])
                .args(
                    args.iter()
                        .enumerate()
                        .filter(|(ix, _)| *ix != port_ix && *ix != port_ix + 1)
                        .map(|(_, arg)| arg),
                )
                .stdin(Stdio::null());
            Ok(local)
        };
        download_file(make_command(&file)?, &destination)?;
        assert_eq!(std::fs::read(&destination)?, b"download contents");
        std::fs::write(&file, b"changed remote contents")?;
        download_file(make_command(&file)?, &destination)?;
        assert_eq!(std::fs::read(&destination)?, b"changed remote contents");
        assert!(download_file(make_command(&source.join("missing"))?, &destination).is_err());
        assert_eq!(std::fs::read(&destination)?, b"changed remote contents");
        assert!(
            download_file(
                make_command(&source.join("missing"))?,
                &downloads.join("missing")
            )
            .is_err()
        );
        assert!(download_file(make_command(&source)?, &downloads.join("folder")).is_err());
        assert_eq!(std::fs::read_dir(&downloads)?.count(), 1);
        let name = "Generated Image March 25, 2026 - 12_51PM.png";
        std::fs::write(source.join(name), b"image contents")?;
        for quote in ['\'', '"'] {
            let path = download_path(source.to_str().unwrap(), &format!("{quote}{name}{quote}"))?;
            download_file(make_command(Path::new(&path))?, &downloads.join(name))?;
            assert_eq!(std::fs::read(downloads.join(name))?, b"image contents");
        }
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn uploads_files_and_folders_overwrite_existing_files_in_the_literal_current_directory()
    -> Result<()> {
        let root = std::env::temp_dir().join(format!("terminal-upload-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("current dir's $HOME; [x] # %20 ?");
        let folder = source.join("folder's name");
        std::fs::create_dir_all(folder.join("empty"))?;
        std::fs::create_dir_all(&destination)?;
        let file = source.join("file: name's $HOME.txt");
        std::fs::write(&file, b"file contents")?;
        std::fs::write(folder.join(".hidden"), b"nested contents")?;
        std::fs::create_dir_all(destination.join("folder's name"))?;
        std::fs::write(
            destination.join(file.file_name().unwrap()),
            b"old file contents",
        )?;
        std::fs::write(
            destination.join("folder's name/.hidden"),
            b"old nested contents",
        )?;
        let profile = SshProfile {
            name: "Upload test".into(),
            host: "::1".into(),
            port: 2222,
            ..SshProfile::default()
        };
        let paths = [file.clone(), folder.clone()];
        let directory = destination.to_str().unwrap();
        let command = upload_command(&profile, directory, &paths, Some("private-password"))?;
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|args| args == ["-P", "2222"]));
        assert_eq!(args.last().unwrap(), &format!("root@[::1]:{directory}/"));
        assert!(!args.join(" ").contains("private-password"));
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == "SSH_ASKPASS_REQUIRE"
                    && value == Some(std::ffi::OsStr::new("force")))
        );
        assert!(upload_command(&profile, "", &paths, None).is_err());
        assert!(upload_command(&profile, directory, &[root.join("missing")], None).is_err());

        let output = Command::new("/bin/sh")
            .args(["-c", &remote_command(directory)])
            .env("SHELL", "/usr/bin/true")
            .output()?;
        assert!(output.status.success());
        let encoded = directory
            .replace('%', "%25")
            .replace('#', "%23")
            .replace('?', "%3F");
        assert_eq!(
            output.stdout,
            format!("\x1b]7;file://localhost{encoded}\x07").as_bytes()
        );

        // Exercise real SFTP transfers locally without requiring an SSH account or network.
        // -D forwards the port as the server's allowed-request option; omit it for this transport.
        let port_ix = args.iter().position(|arg| arg == "-P").unwrap();
        let output = Command::new("scp")
            .args(["-D", "/usr/libexec/sftp-server"])
            .args(
                args.iter()
                    .enumerate()
                    .filter(|(ix, _)| *ix != port_ix && *ix != port_ix + 1)
                    .map(|(_, arg)| arg),
            )
            .stdin(Stdio::null())
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read(destination.join(file.file_name().unwrap()))?,
            b"file contents"
        );
        assert_eq!(
            std::fs::read(destination.join("folder's name/.hidden"))?,
            b"nested contents"
        );
        assert!(destination.join("folder's name/empty").is_dir());
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn ssh_uses_saved_authentication_without_putting_secrets_in_arguments() -> Result<()> {
        let profile = SshProfile {
            name: "Test".into(),
            host: "::1".into(),
            port: 2222,
            authentication: Authentication::Password,
            ..SshProfile::default()
        };
        let command = build_command(
            &profile,
            "/srv/it's a directory; touch /tmp/unwanted",
            Some("private-password"),
        )?;
        let argv: Vec<_> = command
            .get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(argv.windows(2).any(|a| a == ["-p", "2222"]));
        assert!(argv.windows(2).any(|a| a == ["-l", "root"]));
        assert!(argv.windows(2).any(|a| a == ["--", "::1"]));
        for option in [
            "StrictHostKeyChecking=accept-new",
            "ConnectTimeout=10",
            "ServerAliveInterval=5",
            "ServerAliveCountMax=2",
        ] {
            assert!(argv.windows(2).any(|a| a == ["-o", option]));
        }
        assert!(!argv.join(" ").contains("private-password"));
        assert_eq!(command.get_env("SSH_ASKPASS_REQUIRE").unwrap(), "force");
        assert!(build_command(&profile, "", None).is_err());
        let mut script = std::process::Command::new("/bin/sh");
        script.args(["-n", "-c", &remote_command("/srv/a'b;$HOME")]);
        assert!(script.status()?.success());
        Ok(())
    }
}
