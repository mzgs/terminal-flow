use anyhow::{Context as _, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        Arc,
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant},
};
use wezterm_term::{Terminal, TerminalConfiguration, TerminalSize, color::ColorPalette};

#[derive(Debug)]
struct Configuration(ColorPalette);
impl TerminalConfiguration for Configuration {
    fn color_palette(&self) -> ColorPalette {
        self.0.clone()
    }
}

pub(crate) enum Output {
    Bytes(Vec<u8>),
    Closed,
    Error(String),
}

pub(crate) struct Session {
    pub(crate) terminal: Terminal,
    pub(crate) output: Receiver<Output>,
    pub(crate) current_directory: Option<PathBuf>,
    master: Box<dyn MasterPty + Send>,
    child: Option<Box<dyn Child + Send + Sync>>,
    size: TerminalSize,
    directory_checked_at: Instant,
}

impl Session {
    pub(crate) fn spawn(
        mut command: CommandBuilder,
        size: TerminalSize,
        palette: ColorPalette,
    ) -> Result<Self> {
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .context("Couldn’t open a pseudo-terminal")?;
        // GUI launches on macOS do not inherit Terminal.app's UTF-8 locale.
        if ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .all(|key| command.get_env(key).is_none_or(|value| value.is_empty()))
        {
            command.env(
                "LANG",
                if cfg!(target_os = "macos") {
                    "en_US.UTF-8"
                } else {
                    "C.UTF-8"
                },
            );
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "local-terminal");
        command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let initial_directory = command.get_cwd().map(PathBuf::from);
        let child = pair
            .slave
            .spawn_command(command)
            .context("Couldn’t start the shell")?;
        let current_directory = child
            .process_id()
            .and_then(procinfo::LocalProcessInfo::current_working_dir)
            .or(initial_directory);
        drop(pair.slave);
        let terminal = Terminal::new(
            size,
            Arc::new(Configuration(palette)),
            "local-terminal",
            env!("CARGO_PKG_VERSION"),
            writer,
        );
        // ponytail: one bounded reader per tab; async PTY I/O if thread counts become a bottleneck.
        let (sender, output) = mpsc::sync_channel(32);
        thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                let event = match reader.read(&mut buffer) {
                    Ok(0) => Output::Closed,
                    Ok(n) => Output::Bytes(buffer[..n].to_vec()),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    // Unix PTYs may signal slave closure as EIO.
                    Err(error) if error.raw_os_error() == Some(5) => Output::Closed,
                    Err(error) => Output::Error(format!("Couldn’t read shell output: {error}")),
                };
                let closed = !matches!(event, Output::Bytes(_));
                if sender.send(event).is_err() || closed {
                    break;
                }
            }
        });
        Ok(Self {
            terminal,
            output,
            current_directory,
            master: pair.master,
            child: Some(child),
            size,
            directory_checked_at: Instant::now(),
        })
    }

    pub(crate) fn set_palette(&mut self, palette: ColorPalette) {
        *self.terminal.palette_mut() = palette.clone();
        self.terminal.set_config(Arc::new(Configuration(palette)));
        self.terminal.implicit_palette_reset_if_same_as_configured();
    }

    pub(crate) fn update_current_directory(&mut self) -> bool {
        if self.directory_checked_at.elapsed() < Duration::from_millis(250) {
            return false;
        }
        self.directory_checked_at = Instant::now();
        if let Some(directory) = self
            .child
            .as_ref()
            .and_then(|child| child.process_id())
            .and_then(procinfo::LocalProcessInfo::current_working_dir)
            && self.current_directory.as_ref() != Some(&directory)
        {
            self.current_directory = Some(directory);
            return true;
        }
        false
    }

    pub(crate) fn resize(&mut self, size: TerminalSize) -> Result<bool> {
        if self.size == size {
            return Ok(false);
        }
        self.master.resize(pty_size(size))?;
        self.terminal.resize(size);
        self.size = size;
        Ok(true)
    }

    pub(crate) fn exit_status(&mut self) -> Result<Option<portable_pty::ExitStatus>> {
        Ok(self
            .child
            .as_mut()
            .expect("session owns child")
            .try_wait()?)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows as u16,
        cols: size.cols as u16,
        pixel_width: size.pixel_width.min(u16::MAX as usize) as u16,
        pixel_height: size.pixel_height.min(u16::MAX as usize) as u16,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::mpsc::Sender,
        time::{Duration, Instant},
    };
    use wezterm_term::{KeyCode, KeyModifiers, color::ColorAttribute};

    struct Writer(Sender<Vec<u8>>);
    impl Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.send(bytes.to_vec()).unwrap();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn emulator_handles_colors_cursor_alternate_screen_and_keys() {
        let (sender, bytes) = mpsc::channel();
        let mut terminal = Terminal::new(
            TerminalSize::default(),
            Arc::new(Configuration(ColorPalette::default())),
            "test",
            "1",
            Box::new(Writer(sender)),
        );
        terminal.advance_bytes(b"\x1b[31mred\x1b[0m\r\n\x1b[2;5H!");
        let lines = terminal
            .screen()
            .lines_in_phys_range(terminal.screen().phys_range(&(0..2)));
        assert!(lines[0].as_str().starts_with("red"));
        assert_eq!(
            lines[0].get_cell(0).unwrap().attrs().foreground(),
            ColorAttribute::PaletteIndex(1)
        );
        assert_eq!(terminal.cursor_pos().x, 5);
        terminal.advance_bytes(b"\x1b[?1049hALT");
        assert!(terminal.is_alt_screen_active());
        terminal.advance_bytes(b"\x1b[?1049l");
        assert!(!terminal.is_alt_screen_active());
        terminal
            .key_down(KeyCode::Char('c'), KeyModifiers::CTRL)
            .unwrap();
        terminal
            .key_down(KeyCode::UpArrow, KeyModifiers::NONE)
            .unwrap();
        assert_eq!(bytes.recv_timeout(Duration::from_secs(1)).unwrap(), b"\x03");
        assert_eq!(
            bytes.recv_timeout(Duration::from_secs(1)).unwrap(),
            b"\x1b[A"
        );
    }

    #[test]
    #[cfg(unix)]
    fn current_directory_follows_cd_without_shell_escape_sequences() -> Result<()> {
        let initial_directory = std::env::temp_dir().canonicalize()?;
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "read ready; cd /; printf 'ROOT_READY\\n'; read ready; cd \"$1\"; printf 'BACK_READY\\n'; read ready",
            "cwd-test",
        ]);
        command.arg(&initial_directory);
        command.cwd(&initial_directory);
        let mut session =
            Session::spawn(command, TerminalSize::default(), ColorPalette::default())?;
        assert_eq!(session.current_directory.as_ref(), Some(&initial_directory));
        for (marker, directory) in [
            ("ROOT_READY", PathBuf::from("/")),
            ("BACK_READY", initial_directory),
        ] {
            session.terminal.send_paste("ready\n")?;
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut output = Vec::new();
            while !String::from_utf8_lossy(&output).contains(marker) {
                match session
                    .output
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))?
                {
                    Output::Bytes(bytes) => output.extend(bytes),
                    Output::Closed => anyhow::bail!("Shell closed before changing directory"),
                    Output::Error(error) => anyhow::bail!(error),
                }
            }
            session.directory_checked_at = Instant::now() - Duration::from_millis(250);
            assert!(session.update_current_directory());
            assert_eq!(session.current_directory, Some(directory));
            assert!(!session.update_current_directory());
            assert!(session.terminal.get_current_dir().is_none());
        }
        Ok(())
    }

    #[test]
    #[cfg(unix)]
    fn real_pty_runs_a_command_and_receives_resize() -> Result<()> {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "read ready; stty size; locale charmap; printf '\\033[32mPTY_OK\\033[0m\\n'",
        ]);
        for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
            command.env_remove(key);
        }
        let mut session =
            Session::spawn(command, TerminalSize::default(), ColorPalette::default())?;
        session.resize(TerminalSize {
            rows: 30,
            cols: 100,
            ..TerminalSize::default()
        })?;
        session.terminal.send_paste("ready\n")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match session.output.recv_timeout(remaining)? {
                Output::Bytes(bytes) => {
                    session.terminal.advance_bytes(&bytes);
                    output.extend(bytes);
                }
                Output::Closed => break,
                Output::Error(error) => anyhow::bail!(error),
            }
        }
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("30 100"), "{text}");
        assert!(text.contains("PTY_OK"), "{text}");
        assert!(text.contains("UTF-8"), "{text}");
        Ok(())
    }
}
