mod appearance;
mod automation;
#[cfg(test)]
mod crash_tests;
mod dialogs;
mod editor;
mod palette;
mod search;
mod selection;
mod session;
mod sftp;
mod sftp_browser;
mod ssh;
mod ssh_icons;
mod storage;
#[cfg(target_os = "macos")]
mod updater;
mod workspace;

use gpui_kit::{
    assets::IconName,
    component::{
        ActiveTheme, Disableable, Sizable, Theme, ThemeMode, TitleBar,
        button::{Button, ButtonVariants},
        input::{Input, InputEvent, InputState},
        menu::ContextMenuExt,
        progress::Progress,
        scroll::{Scrollbar, ScrollbarHandle, ScrollbarMode},
        status_bar::StatusBar,
    },
    prelude::FluentBuilder,
    *,
};
use portable_pty::CommandBuilder;
use selection::{CellPosition, Selection, SelectionMode};
use session::{Output, Session};
use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
    sync::mpsc::TryRecvError,
    time::{Duration, Instant},
};
use storage::{Settings, SshProfile, Store, TabSnapshot, TabSource};
use wezterm_term::{
    Intensity, KeyCode, KeyModifiers, MouseButton as TerminalMouseButton,
    MouseEvent as TerminalMouseEvent, MouseEventKind, TerminalSize, Underline, color::SrgbaTuple,
};
use workspace::Workspace;

const SSH_RECONNECT_INTERVAL: Duration = Duration::from_secs(5);
const STATUS_BAR_TIMEOUT: Duration = Duration::from_secs(4);

actions!(
    local_terminal,
    [
        Find,
        FindNext,
        FindPrevious,
        ShowStatusBar,
        Copy,
        CopyScreen,
        DownloadSelection,
        EditSelection,
        ExtractSelection,
        RunSelection,
        SearchSelection,
        SelectAll,
        Paste,
        Restart,
        CheckForUpdates,
        Quit,
        ClearTerminal,
        ZoomIn,
        ZoomOut,
        ResetZoom,
        NewTab,
        CloseTab,
        SplitRight,
        SplitDown,
        ClosePane,
        NextPane,
        PreviousPane,
        NextTab,
        PreviousTab,
        OpenSettings,
        OpenCommandPalette,
        OpenFile,
        AddSshServer,
        ManageSshServers
    ]
);

fn scrollbar_mode(cx: &App) -> ScrollbarMode {
    if cx.should_auto_hide_scrollbars() {
        ScrollbarMode::Scrolling
    } else {
        ScrollbarMode::Always
    }
}

#[derive(Clone, Default)]
// The terminal paints visible rows only; expose its scrollback to GPUI's scrollbar.
struct TerminalScrollbar(Rc<Cell<TerminalScrollbarState>>);

#[derive(Clone, Copy, Default)]
struct TerminalScrollbarState {
    viewport: Bounds<Pixels>,
    history_height: Pixels,
    row_height: Pixels,
    offset: Point<Pixels>,
    requested_offset: Option<f32>,
}

impl ScrollbarHandle for TerminalScrollbar {
    fn viewport_bounds(&self) -> Bounds<Pixels> {
        self.0.get().viewport
    }

    fn offset(&self) -> Point<Pixels> {
        self.0.get().offset
    }

    fn set_offset(&self, offset: Point<Pixels>) {
        let mut state = self.0.get();
        if state.row_height > px(0.) {
            state.requested_offset = Some((state.history_height + offset.y) / state.row_height);
            state.offset = offset;
            self.0.set(state);
        }
    }

    fn content_size(&self) -> Size<Pixels> {
        let state = self.0.get();
        state.viewport.size + size(px(0.), state.history_height)
    }
}

struct TerminalView {
    browser: Option<Entity<sftp_browser::SftpBrowser>>,
    browser_snapshot: storage::BrowserSnapshot,
    _browser_subscription: Option<Subscription>,
    saved_id: String,
    // ponytail: URL titles live with the tab; add to TabSnapshot if restore needs custom titles.
    custom_title: Option<String>,
    source: TabSource,
    ssh_profile: Option<SshProfile>,
    ssh_host_key_recovery: ssh::HostKeyRecovery,
    store: Option<Store>,
    font_family: String,
    font_size: f32,
    appearance: appearance::Appearance,
    cursor_epoch: Instant,
    cursor_on: bool,
    connecting: bool,
    downloading: bool,
    download_revision: u64,
    transfer_revision: u64,
    transfer_percent: Option<u8>,
    transfer_connection: Option<std::sync::Arc<sftp::Connection>>,
    reconnect_at: Option<Instant>,
    closed: bool,
    saved_output: Vec<String>,
    _start_task: Option<Task<()>>,
    session: Option<Session>,
    focus: FocusHandle,
    status: String,
    status_bar_message: String,
    status_bar_until: Option<Instant>,
    status_bar_hovered: bool,
    running: bool,
    scroll_offset: f32,
    scrollbar: TerminalScrollbar,
    bounds: Bounds<Pixels>,
    cell_size: Size<Pixels>,
    composition: String,
    search_input: Entity<InputState>,
    search_open: bool,
    search_matches: Vec<Selection>,
    search_active: Option<usize>,
    search_task: Option<Task<()>>,
    search_dirty: bool,
    _search_subscription: Subscription,
    selection: Option<Selection>,
    drag_selection: Option<Selection>,
    mouse_button: Option<MouseButton>,
    font_scale: f32,
    wheel_remainder: f32,
    _output_task: Task<()>,
}

impl TerminalView {
    #[cfg(test)]
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::configured(
            TabSnapshot {
                id: uuid::Uuid::new_v4().to_string(),
                source: TabSource::default(),
                output: vec![],
                font_scale: 1.,
                scroll_offset: 0.,
                browser: Default::default(),
            },
            None,
            None,
            &Settings::default(),
            window,
            cx,
        )
    }

    fn configured(
        snapshot: TabSnapshot,
        profile: Option<SshProfile>,
        store: Option<Store>,
        settings: &Settings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle().tab_stop(true);
        window.focus(&focus, cx);
        let task = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                if this
                    .update(cx, |view, cx| {
                        view.read_output(cx);
                        view.update_status_bar(cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search terminal…"));
        let search_subscription = cx.subscribe(&search_input, |view, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                view.search_task.take();
                view.search_matches.clear();
                view.search_active = None;
                view.refresh_search(true, cx);
            }
        });
        let browser = profile.clone().zip(store.clone()).map(|(profile, store)| {
            cx.new(|cx| {
                sftp_browser::SftpBrowser::new(profile, store, snapshot.browser.clone(), window, cx)
            })
        });
        let browser_subscription = browser.as_ref().map(|browser| {
            cx.observe_in(browser, window, |view, browser, window, cx| {
                view.browser_snapshot = browser.read(cx).snapshot();
                if !browser.read(cx).is_open() && browser.read(cx).has_focus(window, cx) {
                    window.focus(&view.focus, cx);
                }
                cx.notify();
            })
        });
        let mut view = Self {
            browser,
            browser_snapshot: snapshot.browser.clone(),
            _browser_subscription: browser_subscription,
            saved_id: snapshot.id,
            custom_title: None,
            source: snapshot.source,
            ssh_profile: profile,
            ssh_host_key_recovery: ssh::HostKeyRecovery::default(),
            store,
            font_family: settings.font_family.clone(),
            font_size: settings.font_size,
            appearance: settings.appearance.clone(),
            cursor_epoch: Instant::now(),
            cursor_on: true,
            connecting: false,
            downloading: false,
            download_revision: 0,
            transfer_revision: 0,
            transfer_percent: None,
            transfer_connection: None,
            reconnect_at: None,
            closed: false,
            saved_output: snapshot.output,
            _start_task: None,
            session: None,
            focus,
            status: String::new(),
            status_bar_message: String::new(),
            status_bar_until: None,
            status_bar_hovered: false,
            running: false,
            scroll_offset: 0.,
            scrollbar: TerminalScrollbar::default(),
            bounds: Bounds::default(),
            cell_size: size(px(1.), px(1.)),
            composition: String::new(),
            search_input,
            search_open: false,
            search_matches: Vec::new(),
            search_active: None,
            search_task: None,
            search_dirty: false,
            _search_subscription: search_subscription,
            selection: None,
            drag_selection: None,
            mouse_button: None,
            font_scale: snapshot.font_scale,
            wheel_remainder: 0.,
            _output_task: task,
        };
        view.start(cx);
        view.status_bar_message.clone_from(&view.status);
        if let Some(session) = &mut view.session {
            // A text snapshot is history, never shell input or terminal control sequences.
            for line in &view.saved_output {
                let plain: String = line
                    .chars()
                    .filter(|c| !c.is_control() || *c == '\t')
                    .collect();
                session.terminal.advance_bytes(plain.as_bytes());
                session.terminal.advance_bytes(b"\r\n");
            }
        }
        view.set_scroll_offset(snapshot.scroll_offset, cx);
        view
    }

    fn font(&self) -> Font {
        let mut font = font(self.font_family.clone());
        font.weight = FontWeight(self.appearance.font_weight as f32);
        font
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        if self.running || self.connecting || self.closed {
            return;
        }
        self.snapshot();
        self.search_task.take();
        self.reconnect_at = None;
        if let TabSource::Ssh { directory, .. } = &self.source {
            let Some(profile) = self.ssh_profile.clone() else {
                self.status =
                    "The saved SSH profile was deleted. Add it again to reconnect.".into();
                self.running = false;
                cx.notify();
                return;
            };
            let Some(store) = self.store.clone() else {
                self.status = "Application storage is unavailable.".into();
                self.running = false;
                cx.notify();
                return;
            };
            let directory = directory.clone();
            let name = profile.name.clone();
            self.status = format!("Connecting to {name}…");
            self.running = false;
            self.connecting = true;
            let recover_host_key = self.ssh_host_key_recovery.take_pending();
            if recover_host_key && let Some(session) = &mut self.session {
                session.terminal.advance_bytes(
                    b"\r\nSSH host key changed. Removing the saved key and reconnecting once.\r\n",
                );
            }
            let preparation = cx.background_spawn(async move {
                if recover_host_key {
                    ssh::remove_known_host(&profile)?;
                }
                ssh::command(&profile, &directory, &store)
            });
            self._start_task = Some(cx.spawn(async move |this, cx| {
                let command = preparation.await;
                let _ = this.update(cx, |view, cx| {
                    view.connecting = false;
                    match command {
                        Ok(command) => view.spawn(command, name, cx),
                        Err(error) => {
                            view.status = format!("{error:#}");
                            view.schedule_reconnect();
                            cx.notify();
                        }
                    }
                });
            }));
            cx.notify();
            return;
        }
        self.session.take();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(windows) {
                "powershell.exe"
            } else {
                "/bin/sh"
            }
            .into()
        });
        let mut command = CommandBuilder::new(&shell);
        if !cfg!(windows) {
            command.arg("-l");
        }
        let directory = match &self.source {
            TabSource::Local { directory } => directory.clone().filter(|path| path.is_dir()),
            _ => None,
        }
        .or_else(std::env::home_dir);
        if let Some(directory) = directory {
            command.cwd(directory);
        }
        self.spawn(command, shell, cx);
    }

    fn schedule_reconnect(&mut self) {
        if matches!(self.source, TabSource::Ssh { .. }) && !self.closed {
            if self.ssh_host_key_recovery.is_pending() {
                self.reconnect_at = Some(Instant::now());
                self.status
                    .push_str(" · Recovering changed SSH host key while active");
            } else {
                self.reconnect_at = Some(Instant::now() + SSH_RECONNECT_INTERVAL);
                self.status
                    .push_str(" · Automatic retry in 5s while active");
            }
        }
    }

    fn maybe_reconnect(&mut self, cx: &mut Context<Self>) {
        if matches!(self.source, TabSource::Ssh { .. })
            && self.reconnect_at.is_none_or(|at| Instant::now() >= at)
        {
            self.start(cx);
        }
    }

    fn close(&mut self) {
        self.closed = true;
        self.transfer_revision += 1;
        self.transfer_percent = None;
        if let Some(connection) = self.transfer_connection.take() {
            connection.close();
        }
        self.search_task.take();
        self._start_task.take();
        self.connecting = false;
        self.reconnect_at = None;
        self.running = false;
        self.session.take();
    }

    fn spawn(&mut self, command: CommandBuilder, title: String, cx: &mut Context<Self>) {
        let remote = matches!(self.source, TabSource::Ssh { .. });
        let size = self
            .session
            .as_ref()
            .filter(|_| remote)
            .map(|session| session.terminal.get_size())
            .unwrap_or_default();
        let palette = self.appearance.palette();
        match Session::spawn(command, size, palette) {
            Ok(mut session) => {
                if remote && let Some(previous) = &mut self.session {
                    if previous.terminal.is_alt_screen_active() {
                        previous.terminal.advance_bytes(b"\x1b[?1049l");
                    }
                    let cursor = previous.terminal.cursor_pos();
                    // Keep history and colors, with fresh terminal modes and the new PTY writer.
                    std::mem::swap(
                        session.terminal.screen_mut(),
                        previous.terminal.screen_mut(),
                    );
                    session.terminal.advance_bytes(format!(
                        "\x1b[{};{}H",
                        cursor.y + 1,
                        cursor.x + 1
                    ));
                    if cursor.x != 0 {
                        session.terminal.advance_bytes(b"\r\n");
                    }
                } else {
                    self.scroll_offset = 0.;
                }
                self.session = Some(session);
                self.status = title;
                self.status_bar_message.clone_from(&self.status);
                self.running = true;
                self.wheel_remainder = 0.;
                self.selection = None;
                self.drag_selection = None;
            }
            Err(error) => {
                if !remote {
                    self.session = None;
                }
                self.status = format!("{error:#}");
                self.running = false;
                self.schedule_reconnect();
            }
        }
        self.refresh_search(false, cx);
        cx.notify();
    }

    fn show_status_bar(&mut self, _: &ShowStatusBar, _: &mut Window, cx: &mut Context<Self>) {
        self.status_bar_until = Some(Instant::now() + STATUS_BAR_TIMEOUT);
        cx.notify();
    }

    fn update_status_bar(&mut self, cx: &mut Context<Self>) {
        if self.status_bar_message != self.status {
            self.status_bar_message.clone_from(&self.status);
            self.status_bar_until = Some(Instant::now() + STATUS_BAR_TIMEOUT);
            cx.notify();
        } else if self
            .status_bar_until
            .is_some_and(|until| Instant::now() >= until)
        {
            self.status_bar_until = None;
            cx.notify();
        }
    }

    fn read_output(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &mut self.session else {
            return;
        };
        if !self.running {
            return;
        }
        let (_, blink) = self.appearance.cursor(session.terminal.cursor_pos().shape);
        let cursor_on =
            !blink || cx.reduce_motion() || self.cursor_epoch.elapsed().as_millis() % 1000 < 500;
        let cursor_changed = cursor_on != self.cursor_on;
        let mut changed =
            matches!(self.source, TabSource::Local { .. }) && session.update_current_directory();
        self.cursor_on = cursor_on;
        // Leave frame time for input and painting even when the PTY stays busy.
        let deadline = Instant::now() + Duration::from_millis(4);
        let mut reconnect = false;
        for _ in 0..32 {
            match session.output.try_recv() {
                Ok(Output::Bytes(bytes)) => {
                    if matches!(self.source, TabSource::Ssh { .. }) {
                        self.ssh_host_key_recovery.observe(&bytes);
                    }
                    let screen = session.terminal.screen();
                    let bottom = screen.phys_to_stable_row_index(screen.scrollback_rows());
                    let alt_screen = session.terminal.is_alt_screen_active();
                    let cursor = session.terminal.cursor_pos();
                    session.terminal.advance_bytes(bytes);
                    let moved = session.terminal.cursor_pos();
                    if (cursor.x, cursor.y, cursor.shape) != (moved.x, moved.y, moved.shape) {
                        self.cursor_epoch = Instant::now();
                        self.cursor_on = true;
                    }
                    if alt_screen != session.terminal.is_alt_screen_active() {
                        self.search_task.take();
                        self.search_matches.clear();
                        self.search_active = None;
                        self.selection = None;
                        self.drag_selection = None;
                        self.scroll_offset = 0.;
                        self.wheel_remainder = 0.;
                    } else if self.scroll_offset > 0. {
                        let screen = session.terminal.screen();
                        let added =
                            screen.phys_to_stable_row_index(screen.scrollback_rows()) - bottom;
                        self.scroll_offset = (self.scroll_offset + added as f32).max(0.).min(
                            screen
                                .scrollback_rows()
                                .saturating_sub(screen.physical_rows)
                                as f32,
                        );
                    }
                    changed = true;
                    if Instant::now() >= deadline {
                        break;
                    }
                }
                Ok(Output::Error(error)) => {
                    self.status = error;
                    self.running = false;
                    reconnect = true;
                    changed = true;
                    break;
                }
                Ok(Output::Closed) | Err(TryRecvError::Disconnected) => {
                    self.status = match session.exit_status() {
                        Ok(Some(status)) => {
                            reconnect = !status.success();
                            format!("Shell exited ({})", status.exit_code())
                        }
                        // The PTY can close just before SSH's exit status becomes available.
                        Ok(None) if matches!(self.source, TabSource::Ssh { .. }) => break,
                        Ok(None) => {
                            reconnect = true;
                            "Shell closed".into()
                        }
                        Err(error) => {
                            reconnect = true;
                            format!("Couldn’t read shell status: {error}")
                        }
                    };
                    self.running = false;
                    changed = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        if reconnect {
            self.schedule_reconnect();
        }
        if changed {
            self.refresh_search(false, cx);
        }
        if changed || cursor_changed {
            cx.notify();
        }
    }

    fn input(&mut self, key: KeyCode, modifiers: KeyModifiers, cx: &mut Context<Self>) {
        if !self.running {
            return;
        }
        self.cursor_epoch = Instant::now();
        self.cursor_on = true;
        self.selection = None;
        self.drag_selection = None;
        if let Some(session) = &mut self.session
            && let Err(error) = session.terminal.key_down(key, modifiers)
        {
            self.status = format!("Couldn’t send input: {error}");
        }
        self.scroll_offset = 0.;
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // Desktop shortcuts are dispatched by GPUI. Printable text comes through the IME handler.
        if event.keystroke.modifiers.platform {
            return;
        }
        if !self.composition.is_empty() && !event.keystroke.modifiers.control {
            return;
        }
        let stroke = &event.keystroke;
        if stroke.key == "escape" && self.search_open {
            self.close_search(window, cx);
            cx.stop_propagation();
            return;
        }
        if stroke.key == "escape" && self.selection.take().is_some() {
            self.drag_selection = None;
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if stroke.modifiers.shift && !stroke.modifiers.control && !stroke.modifiers.alt {
            let rows = self
                .session
                .as_ref()
                .map_or(1, |session| session.terminal.screen().physical_rows);
            let offset = match stroke.key.as_str() {
                "pageup" => Some(self.scroll_offset + rows as f32),
                "pagedown" => Some(self.scroll_offset - rows as f32),
                "home" => Some(f32::INFINITY),
                "end" => Some(0.),
                _ => None,
            };
            if let Some(offset) = offset {
                self.set_scroll_offset(offset, cx);
                cx.stop_propagation();
                return;
            }
        }
        if let Some(key) = terminal_key(&event.keystroke) {
            self.input(key, terminal_modifiers(event.keystroke.modifiers), cx);
            cx.stop_propagation();
        }
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if self.running
            && let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
        {
            if let Some(session) = &mut self.session
                && let Err(error) = session.terminal.send_paste(&text)
            {
                self.status = format!("Couldn’t paste: {error}");
            }
            self.scroll_offset = 0.;
            self.selection = None;
            self.drag_selection = None;
            cx.notify();
        }
        window.focus(&self.focus, cx);
    }

    fn drop_paths(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        if !self.running || paths.paths().is_empty() {
            return;
        }
        if matches!(self.source, TabSource::Local { .. }) {
            match dropped_path_text(paths.paths()) {
                Ok(text) => {
                    if let Some(session) = &mut self.session
                        && let Err(error) = session.terminal.send_paste(&text)
                    {
                        self.status = format!("Couldn’t insert paths: {error}");
                    }
                    self.scroll_offset = 0.;
                    self.selection = None;
                    self.drag_selection = None;
                }
                Err(error) => self.status = error.to_string(),
            }
            cx.notify();
            return;
        }
        // Read pending OSC 7 output before capturing the destination for this drop.
        self.read_output(cx);
        if !self.running {
            return;
        }
        let directory = self
            .session
            .as_ref()
            .and_then(|session| session.terminal.get_current_dir())
            .and_then(|url| url.to_file_path().ok());
        let Some(directory) = directory.and_then(|path| path.to_str().map(str::to_owned)) else {
            self.status =
                "Couldn’t upload: the remote working directory is not available yet.".into();
            cx.notify();
            return;
        };
        let (Some(profile), Some(store)) = (self.ssh_profile.clone(), self.store.clone()) else {
            self.status =
                "Couldn’t upload: the SSH profile or application storage is unavailable.".into();
            cx.notify();
            return;
        };
        let paths = paths.paths().to_vec();
        self.transfer_revision += 1;
        let revision = self.transfer_revision;
        self.transfer_percent = Some(0);
        self.status = format!("Uploading to {directory}…");
        let destination = directory.clone();
        let connection = self
            .browser
            .as_ref()
            .map(|browser| browser.read(cx).connection())
            .unwrap_or_else(|| std::sync::Arc::new(sftp::Connection::default()));
        self.transfer_connection = Some(connection.clone());
        let progress = std::sync::Arc::new(sftp::TransferProgress::new("Uploading"));
        let reported = progress.clone();
        let upload = cx.background_spawn(async move {
            let mut report =
                |path: &str, transferred, total| reported.update(path, transferred, total);
            connection.run(
                || ssh::sftp_command(&profile, &store),
                false,
                |client| client.upload(&directory, &paths, &mut report),
            )
        });
        let progress_task = cx.spawn(async move |this, cx| {
            loop {
                if let Some((status, percent)) = progress.take_status()
                    && this
                        .update(cx, |view, cx| {
                            if view.transfer_revision != revision {
                                return;
                            }
                            view.status = status;
                            view.transfer_percent = Some(percent);
                            cx.notify();
                        })
                        .is_err()
                {
                    return;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
            }
        });
        cx.spawn(async move |this, cx| {
            let result = upload.await;
            drop(progress_task);
            let _ = this.update(cx, |view, cx| {
                if view.transfer_revision != revision {
                    return;
                }
                view.transfer_percent = None;
                view.transfer_connection = None;
                view.status = match result {
                    Ok(()) => format!("Uploaded to {destination}"),
                    Err(error) => format!("{error:#}"),
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_transfer(&mut self, cx: &mut Context<Self>) {
        if let Some(connection) = self.transfer_connection.take() {
            connection.close();
            if let Some(browser) = &self.browser {
                browser.update(cx, |browser, cx| {
                    if std::sync::Arc::ptr_eq(&connection, &browser.connection()) {
                        browser.cancel_transfer(cx);
                    }
                });
            }
            self.transfer_revision += 1;
            self.transfer_percent = None;
            self.downloading = false;
            self.status = "Transfer cancelled".into();
            cx.notify();
        }
    }

    fn find(&mut self, _: &Find, window: &mut Window, cx: &mut Context<Self>) {
        self.search_open = true;
        self.refresh_search(true, cx);
        self.search_input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        cx.notify();
    }

    fn selected_download_path(&self) -> anyhow::Result<String> {
        anyhow::ensure!(
            matches!(self.source, TabSource::Ssh { .. }),
            "Downloads are available in SSH terminals."
        );
        self.selected_file_path()?
            .into_os_string()
            .into_string()
            .map_err(|_| anyhow::anyhow!("The selected path is not valid UTF-8."))
    }

    fn selected_file_path(&self) -> anyhow::Result<std::path::PathBuf> {
        let (Some(selection), Some(session)) = (&self.selection, &self.session) else {
            anyhow::bail!("Select a filename or path to edit.");
        };
        let selected = selection.text(&session.terminal);
        if matches!(self.source, TabSource::Ssh { .. }) {
            let directory = session
                .terminal
                .get_current_dir()
                .and_then(|url| url.to_file_path().ok());
            return ssh::download_path(
                directory
                    .as_ref()
                    .and_then(|path| path.to_str())
                    .unwrap_or_default(),
                &selected,
            )
            .map(std::path::PathBuf::from);
        }
        let path = std::path::PathBuf::from(ssh::selected_path(&selected)?);
        anyhow::ensure!(path.file_name().is_some(), "Select a file to edit.");
        if path.is_absolute() {
            return Ok(path);
        }
        let directory = Workspace::directory(self)
            .ok_or_else(|| anyhow::anyhow!("The local working directory is unavailable."))?;
        Ok(directory.join(path))
    }

    fn edit_selection(&mut self, _: &EditSelection, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.read_output(cx);
        let target = (|| -> anyhow::Result<editor::Target> {
            let path = self.selected_file_path()?;
            if matches!(self.source, TabSource::Local { .. }) {
                return Ok(editor::Target::Local(path));
            }
            let (Some(profile), Some(store)) = (self.ssh_profile.clone(), self.store.clone())
            else {
                anyhow::bail!("The SSH profile or application storage is unavailable.");
            };
            Ok(editor::Target::Remote {
                path: path
                    .into_os_string()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("The selected path is not valid UTF-8."))?,
                profile: std::sync::Arc::new(profile),
                store,
                connection: self
                    .browser
                    .as_ref()
                    .map(|browser| browser.read(cx).connection())
                    .unwrap_or_else(|| std::sync::Arc::new(sftp::Connection::default())),
            })
        })();
        match target {
            Ok(target) => editor::open(target, window, cx),
            Err(error) => {
                self.status = format!("Couldn’t edit: {error}");
                cx.notify();
            }
        }
    }

    fn selected_command(&self, extract: bool) -> anyhow::Result<String> {
        let windows = cfg!(windows) && matches!(self.source, TabSource::Local { .. });
        let path = self.selected_file_path()?;
        let path = path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("The selected path is not valid UTF-8."))?;
        let command = if extract {
            selection::extract_command(path, windows)
        } else if windows {
            None
        } else {
            selection::run_command(path)
        };
        command.ok_or_else(|| {
            anyhow::anyhow!(
                "Select a supported {}.",
                if extract { "archive" } else { "script" }
            )
        })
    }

    fn execute_selection(&mut self, extract: bool, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.read_output(cx);
        if !self.running {
            return;
        }
        let result = (|| -> anyhow::Result<()> {
            let command = self.selected_command(extract)?;
            self.send_command(&command, None)
        })();
        match result {
            Ok(()) => {
                self.selection = None;
                self.drag_selection = None;
                self.scroll_offset = 0.;
            }
            Err(error) => {
                self.status = format!(
                    "Couldn’t {}: {error}",
                    if extract { "extract" } else { "run" }
                )
            }
        }
        cx.notify();
    }

    fn send_command(&mut self, command: &str, caret: Option<usize>) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.running && !self.connecting,
            "The shell is unavailable."
        );
        anyhow::ensure!(
            !command.trim().is_empty() && !command.contains('\0'),
            "Invalid shell command."
        );
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("The shell is unavailable."))?;
        anyhow::ensure!(
            caret.is_none()
                || session.terminal.bracketed_paste_enabled()
                || !command.contains(['\n', '\r']),
            "Inserting a multiline command without running it requires a shell with bracketed paste enabled."
        );
        session.terminal.send_paste(command)?;
        if let Some(caret) = caret {
            // A cursor move clears the shell's paste highlight, even for an end marker.
            for _ in 0..caret.max(1) {
                session
                    .terminal
                    .key_down(KeyCode::LeftArrow, KeyModifiers::NONE)?;
            }
            if caret == 0 {
                session
                    .terminal
                    .key_down(KeyCode::RightArrow, KeyModifiers::NONE)?;
            }
        } else {
            session
                .terminal
                .key_down(KeyCode::Enter, KeyModifiers::NONE)?;
        }
        self.selection = None;
        self.drag_selection = None;
        self.scroll_offset = 0.;
        Ok(())
    }

    fn search_selection(
        &mut self,
        _: &SearchSelection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        if let (Some(selection), Some(session)) = (&self.selection, &self.session)
            && let Some(url) = selection::google_search_url(&selection.text(&session.terminal))
        {
            cx.open_url(&url);
        }
    }

    fn download_selection(
        &mut self,
        _: &DownloadSelection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        if !self.running || self.downloading {
            return;
        }
        self.read_output(cx);
        if !self.running {
            return;
        }
        let path = match self.selected_download_path() {
            Ok(path) => path,
            Err(error) => {
                self.status = format!("Couldn’t download: {error}");
                cx.notify();
                return;
            }
        };
        let (Some(profile), Some(store)) = (self.ssh_profile.clone(), self.store.clone()) else {
            self.status =
                "Couldn’t download: the SSH profile or application storage is unavailable.".into();
            cx.notify();
            return;
        };
        self.downloading = true;
        self.transfer_revision += 1;
        let revision = self.transfer_revision;
        self.download_revision = revision;
        self.transfer_percent = Some(0);
        self.status = format!("Downloading {path} to Downloads…");
        let connection = self
            .browser
            .as_ref()
            .map(|browser| browser.read(cx).connection())
            .unwrap_or_else(|| std::sync::Arc::new(sftp::Connection::default()));
        self.transfer_connection = Some(connection.clone());
        let progress = std::sync::Arc::new(sftp::TransferProgress::new("Downloading"));
        let reported = progress.clone();
        let download = cx.background_spawn(async move {
            let mut report =
                |path: &str, transferred, total| reported.update(path, transferred, total);
            let directory = dirs::download_dir()
                .ok_or_else(|| anyhow::anyhow!("Couldn’t locate your Downloads folder"))?;
            std::fs::create_dir_all(&directory)?;
            let destination = directory.join(path.rsplit('/').next().unwrap());
            connection.run(
                || ssh::sftp_command(&profile, &store),
                true,
                |client| client.download_to(&path, &destination, &mut report),
            )?;
            Ok::<_, anyhow::Error>(destination)
        });
        let progress_task = cx.spawn(async move |this, cx| {
            loop {
                if let Some((status, percent)) = progress.take_status()
                    && this
                        .update(cx, |view, cx| {
                            if view.transfer_revision != revision {
                                return;
                            }
                            view.status = status;
                            view.transfer_percent = Some(percent);
                            cx.notify();
                        })
                        .is_err()
                {
                    return;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
            }
        });
        cx.spawn(async move |this, cx| {
            let result = download.await;
            drop(progress_task);
            let _ = this.update(cx, |view, cx| {
                if view.download_revision == revision {
                    view.downloading = false;
                }
                if view.transfer_revision != revision {
                    cx.notify();
                    return;
                }
                view.transfer_percent = None;
                view.transfer_connection = None;
                view.status = match result {
                    Ok(path) => format!("Downloaded to {}", path.display()),
                    Err(error) => format!("Couldn’t download: {error:#}"),
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search_open = false;
        self.search_task.take();
        self.search_dirty = false;
        self.search_matches.clear();
        self.search_active = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn refresh_search(&mut self, reveal: bool, cx: &mut Context<Self>) {
        if !self.search_open {
            return;
        }
        let query = self.search_input.read(cx).value().to_string();
        if query.is_empty() || self.session.is_none() {
            self.search_task.take();
            self.search_matches.clear();
            self.search_active = None;
            self.search_dirty = false;
            cx.notify();
            return;
        }
        if self.search_task.is_some() && !reveal {
            self.search_dirty = true;
            return;
        }
        self.search_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(120))
                .await;
            let Ok(Some((lines, first_row))) = this.update(cx, |view, _| {
                view.search_dirty = false;
                view.session.as_ref().map(|session| {
                    let screen = session.terminal.screen();
                    // ponytail: copy bounded scrollback; index changed rows if history grows.
                    (
                        screen.lines_in_phys_range(0..screen.scrollback_rows()),
                        screen.phys_to_stable_row_index(0),
                    )
                })
            }) else {
                return;
            };
            let search_query = query.clone();
            let matches = cx
                .background_spawn(async move { search::matches(&lines, first_row, &search_query) })
                .await;
            let _ = this.update(cx, |view, cx| {
                view.search_task.take();
                if !view.search_open || view.search_input.read(cx).value().as_ref() != query {
                    return;
                }
                let previous = view
                    .search_active
                    .and_then(|ix| view.search_matches.get(ix))
                    .map(Selection::bounds);
                view.search_matches = matches;
                view.search_active = previous
                    .and_then(|bounds| {
                        view.search_matches
                            .iter()
                            .position(|found| found.bounds() == bounds)
                    })
                    .or_else(|| view.search_matches.len().checked_sub(1));
                if reveal {
                    view.reveal_search_match(cx);
                }
                if view.search_dirty {
                    view.refresh_search(false, cx);
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn reveal_search_match(&mut self, cx: &mut Context<Self>) {
        if let (Some(ix), Some(session)) = (self.search_active, &self.session) {
            let screen = session.terminal.screen();
            if let Some(row) = screen.stable_row_to_phys(self.search_matches[ix].bounds().0.0) {
                let top = row.saturating_sub(screen.physical_rows / 2);
                let offset = screen
                    .scrollback_rows()
                    .saturating_sub(screen.physical_rows)
                    .saturating_sub(top);
                self.set_scroll_offset(offset as f32, cx);
            }
        }
    }

    fn navigate_search(&mut self, previous: bool, cx: &mut Context<Self>) {
        if let Some(ix) = self.search_active {
            let count = self.search_matches.len();
            self.search_active = Some(if previous {
                (ix + count - 1) % count
            } else {
                (ix + 1) % count
            });
            self.reveal_search_match(cx);
            cx.notify();
        }
    }

    fn search_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event.keystroke.key.as_str() {
            "escape" => self.close_search(window, cx),
            "enter"
                if self
                    .search_input
                    .read(cx)
                    .focus_handle(cx)
                    .is_focused(window) =>
            {
                self.navigate_search(event.keystroke.modifiers.shift, cx)
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    fn copy_screen(&mut self, _: &CopyScreen, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(session) = &self.session {
            let text = screen_text(session, self.scroll_offset);
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
        window.focus(&self.focus, cx);
    }

    fn copy(&mut self, _: &Copy, window: &mut Window, cx: &mut Context<Self>) {
        if let (Some(selection), Some(session)) = (&self.selection, &self.session) {
            cx.write_to_clipboard(ClipboardItem::new_string(selection.text(&session.terminal)));
        }
        window.focus(&self.focus, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.selection = self
            .session
            .as_ref()
            .map(|session| Selection::all(&session.terminal));
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn clear_terminal(&mut self, _: &ClearTerminal, window: &mut Window, cx: &mut Context<Self>) {
        self.search_task.take();
        if let Some(session) = &mut self.session {
            session.terminal.erase_scrollback_and_viewport();
        }
        self.refresh_search(false, cx);
        self.selection = None;
        self.drag_selection = None;
        self.scroll_offset = 0.;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn zoom(&mut self, scale: f32, cx: &mut Context<Self>) {
        self.font_scale = scale.clamp(0.5, 2.5);
        cx.notify();
    }

    fn set_scroll_offset(&mut self, offset: f32, cx: &mut Context<Self>) {
        if let Some(session) = &self.session {
            let screen = session.terminal.screen();
            let offset = offset.max(0.).min(
                screen
                    .scrollback_rows()
                    .saturating_sub(screen.physical_rows) as f32,
            );
            self.wheel_remainder = 0.;
            if self.scroll_offset != offset {
                self.scroll_offset = offset;
                cx.notify();
            }
        }
    }

    fn cell_at(&self, position: Point<Pixels>) -> Option<CellPosition> {
        let screen = self.session.as_ref()?.terminal.screen();
        let relative = position - self.bounds.origin;
        let column = (f32::from(relative.x) / f32::from(self.cell_size.width))
            .floor()
            .max(0.) as usize;
        let row = (f32::from(relative.y) / f32::from(self.cell_size.height)
            + self.scroll_offset.ceil()
            - self.scroll_offset)
            .floor()
            .max(0.) as usize;
        let range = visible_range(self.session.as_ref()?, self.scroll_offset);
        Some((
            screen.phys_to_stable_row_index(range.start + row.min(range.len() - 1)),
            column.min(screen.physical_cols - 1),
        ))
    }

    fn send_mouse(
        &mut self,
        kind: MouseEventKind,
        button: TerminalMouseButton,
        position: Point<Pixels>,
        modifiers: Modifiers,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.running
            || (kind != MouseEventKind::Release && (modifiers.shift || self.scroll_offset > 0.))
        {
            return false;
        }
        let Some(session) = &mut self.session else {
            return false;
        };
        if !session.terminal.is_mouse_grabbed() {
            return false;
        }
        let relative = position - self.bounds.origin;
        let x = (f32::from(relative.x) / f32::from(self.cell_size.width))
            .floor()
            .max(0.) as usize;
        let y = (f32::from(relative.y) / f32::from(self.cell_size.height))
            .floor()
            .max(0.) as i64;
        let event = TerminalMouseEvent {
            kind,
            button,
            x,
            y,
            x_pixel_offset: f32::from(relative.x).max(0.) as isize
                % f32::from(self.cell_size.width).max(1.) as isize,
            y_pixel_offset: f32::from(relative.y).max(0.) as isize
                % f32::from(self.cell_size.height).max(1.) as isize,
            modifiers: terminal_modifiers(modifiers),
        };
        if let Err(error) = session.terminal.mouse_event(event) {
            self.status = format!("Couldn’t send mouse input: {error}");
            cx.notify();
        }
        true
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        window.prevent_default();
        self.mouse_button = None;
        if self.send_mouse(
            MouseEventKind::Press,
            terminal_mouse_button(Some(event.button)),
            event.position,
            event.modifiers,
            cx,
        ) {
            self.mouse_button = Some(event.button);
            self.selection = None;
            self.drag_selection = None;
        } else if event.button == MouseButton::Left {
            if let (Some(at), Some(session)) = (self.cell_at(event.position), &self.session) {
                let mode = match event.click_count {
                    1 => SelectionMode::Character,
                    2 => SelectionMode::Word,
                    _ => SelectionMode::Line,
                };
                let mut selection = Selection::new(&session.terminal, at, mode);
                if event.modifiers.shift
                    && let Some(previous) = self.selection
                {
                    selection = previous;
                    selection.extend(&session.terminal, at);
                }
                self.drag_selection = Some(selection);
                self.selection =
                    (event.click_count > 1 || event.modifiers.shift).then_some(selection);
            }
        } else if event.button == MouseButton::Middle {
            self.paste(&Paste, window, cx);
        }
        cx.notify();
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.dragging()
            && let Some(mut selection) = self.drag_selection
        {
            if event.position.y < self.bounds.top() {
                self.set_scroll_offset(self.scroll_offset + 1., cx);
            }
            if event.position.y > self.bounds.bottom() {
                self.set_scroll_offset(self.scroll_offset - 1., cx);
            }
            if let (Some(at), Some(session)) = (self.cell_at(event.position), &self.session) {
                selection.extend(&session.terminal, at);
                self.selection = Some(selection);
                cx.notify();
            }
        } else if self.bounds.contains(&event.position) {
            self.send_mouse(
                MouseEventKind::Move,
                terminal_mouse_button(event.pressed_button),
                event.position,
                event.modifiers,
                cx,
            );
        }
    }

    fn mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.mouse_button.take().is_some() {
            self.send_mouse(
                MouseEventKind::Release,
                terminal_mouse_button(Some(event.button)),
                event.position,
                event.modifiers,
                cx,
            );
        }
        self.drag_selection = None;
    }

    fn restart(&mut self, _: &Restart, window: &mut Window, cx: &mut Context<Self>) {
        if !self.running && !self.connecting {
            self.start(cx);
        }
        window.focus(&self.focus, cx);
    }

    fn snapshot(&mut self) -> TabSnapshot {
        let mut source = self.source.clone();
        if let Some(session) = &self.session {
            let directory = session
                .terminal
                .get_current_dir()
                .and_then(|url| url.to_file_path().ok());
            match &mut source {
                TabSource::Local { directory: saved } => {
                    *saved = directory.or_else(|| session.current_directory.clone());
                    if !session.terminal.is_alt_screen_active() {
                        let screen = session.terminal.screen();
                        let cursor_row = screen.phys_row(session.terminal.cursor_pos().y);
                        // Restore completed history; a fresh shell supplies the live prompt.
                        // ponytail: unfinished cursor lines are omitted without shell integration.
                        let mut end = if self.running {
                            cursor_row
                        } else {
                            screen.scrollback_rows()
                        };
                        while self.running
                            && end > 0
                            && screen.lines_in_phys_range(end - 1..end)[0].last_cell_was_wrapped()
                        {
                            end -= 1;
                        }
                        let cursor_line = screen.lines_in_phys_range(cursor_row..cursor_row + 1)[0]
                            .as_str()
                            .trim_end()
                            .to_string();
                        let mut lines: Vec<String> = screen
                            .lines_in_phys_range(end.saturating_sub(500)..end)
                            .iter()
                            .map(|line| line.as_str().trim_end().to_string())
                            .collect();
                        // Also discard copies accumulated by older session snapshots.
                        while lines.last().is_some_and(|line| {
                            line.is_empty() || (self.running && line == &cursor_line)
                        }) {
                            lines.pop();
                        }
                        self.saved_output = lines;
                    }
                }
                TabSource::Ssh {
                    directory: saved, ..
                } => {
                    if let Some(directory) = directory {
                        *saved = directory.to_string_lossy().into_owned();
                    }
                }
            }
        }
        self.source = source.clone();
        TabSnapshot {
            id: self.saved_id.clone(),
            source,
            output: if matches!(self.source, TabSource::Local { .. }) {
                self.saved_output.clone()
            } else {
                vec![]
            },
            font_scale: self.font_scale,
            scroll_offset: self.scroll_offset,
            browser: self.browser_snapshot.clone(),
        }
    }

    fn scroll(&mut self, event: &ScrollWheelEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        let delta = event.delta.pixel_delta(self.cell_size.height).y;
        let alt_screen = session.terminal.is_alt_screen_active();
        let application_scroll = self.running
            && !event.modifiers.shift
            && (alt_screen || (self.scroll_offset == 0. && session.terminal.is_mouse_grabbed()));
        window.focus(&self.focus, cx);
        cx.stop_propagation();
        if !application_scroll {
            self.set_scroll_offset(
                self.scroll_offset + f32::from(delta) / f32::from(self.cell_size.height),
                cx,
            );
            return;
        }
        if event.touch_phase == TouchPhase::Started {
            self.wheel_remainder = 0.;
        }
        self.wheel_remainder += f32::from(delta) / f32::from(self.cell_size.height);
        let rows = self.wheel_remainder.trunc() as isize;
        self.wheel_remainder -= rows as f32;
        if rows == 0 {
            return;
        }
        let button = if rows > 0 {
            TerminalMouseButton::WheelUp(rows.unsigned_abs().min(20))
        } else {
            TerminalMouseButton::WheelDown(rows.unsigned_abs().min(20))
        };
        if self.send_mouse(
            MouseEventKind::Press,
            button,
            event.position,
            event.modifiers,
            cx,
        ) {
            // The application owns wheel input while mouse reporting is active.
        } else if alt_screen && !event.modifiers.shift {
            let key = if rows > 0 {
                KeyCode::UpArrow
            } else {
                KeyCode::DownArrow
            };
            for _ in 0..rows.unsigned_abs().min(20) {
                self.input(key, KeyModifiers::NONE, cx);
            }
        }
    }

    fn measure(&mut self, bounds: Bounds<Pixels>, cell_size: Size<Pixels>, cx: &mut Context<Self>) {
        let mut scrollbar = self.scrollbar.0.get();
        if let Some(offset) = scrollbar.requested_offset.take() {
            self.set_scroll_offset(offset, cx);
        }
        self.bounds = bounds;
        self.cell_size = cell_size;
        let size = TerminalSize {
            cols: (f32::from(bounds.size.width) / f32::from(cell_size.width))
                .floor()
                .clamp(2., 1000.) as usize,
            rows: (f32::from(bounds.size.height) / f32::from(cell_size.height))
                .floor()
                .clamp(1., 500.) as usize,
            pixel_width: f32::from(bounds.size.width).max(0.) as usize,
            pixel_height: f32::from(bounds.size.height).max(0.) as usize,
            dpi: 0,
        };
        let mut resized = false;
        if let Some(session) = &mut self.session {
            match session.resize(size) {
                Ok(true) => {
                    resized = true;
                    self.scroll_offset = 0.;
                    self.selection = None;
                    self.drag_selection = None;
                    cx.notify();
                }
                Ok(false) => {}
                Err(error) => {
                    let status = format!("Couldn’t resize terminal: {error}");
                    if self.status != status {
                        self.status = status;
                        cx.notify();
                    }
                }
            }
        }
        if resized {
            self.refresh_search(true, cx);
        }
        let history_rows = self.session.as_ref().map_or(0, |session| {
            let screen = session.terminal.screen();
            screen
                .scrollback_rows()
                .saturating_sub(screen.physical_rows)
        });
        scrollbar.history_height = cell_size.height * history_rows as f32;
        scrollbar.row_height = cell_size.height;
        scrollbar.offset = point(
            px(0.),
            cell_size.height * self.scroll_offset - scrollbar.history_height,
        );
        self.scrollbar.0.set(scrollbar);
    }
}

fn visible_range(session: &Session, offset: f32) -> Range<usize> {
    let screen = session.terminal.screen();
    // Saved offsets can outlive the history they referred to.
    let offset = offset.max(0.).min(
        screen
            .scrollback_rows()
            .saturating_sub(screen.physical_rows) as f32,
    );
    // Include both partial rows while the trackpad is between whole lines.
    let end = screen
        .scrollback_rows()
        .saturating_sub(offset.floor() as usize);
    let start = screen
        .scrollback_rows()
        .saturating_sub(screen.physical_rows)
        .saturating_sub(offset.ceil() as usize);
    start..end
}

fn terminal_mouse_button(button: Option<MouseButton>) -> TerminalMouseButton {
    match button {
        Some(MouseButton::Left) => TerminalMouseButton::Left,
        Some(MouseButton::Middle) => TerminalMouseButton::Middle,
        Some(MouseButton::Right) => TerminalMouseButton::Right,
        _ => TerminalMouseButton::None,
    }
}

fn screen_text(session: &Session, offset: f32) -> String {
    let mut text = String::new();
    for (row, line) in session
        .terminal
        .screen()
        .lines_in_phys_range(visible_range(session, offset))
        .iter()
        .enumerate()
    {
        if row > 0 {
            text.push('\n');
        }
        text.push_str(line.as_str().trim_end());
    }
    text
}

fn terminal_modifiers(modifiers: Modifiers) -> KeyModifiers {
    let mut result = KeyModifiers::NONE;
    if modifiers.control {
        result |= KeyModifiers::CTRL;
    }
    if modifiers.alt {
        result |= KeyModifiers::ALT;
    }
    if modifiers.shift {
        result |= KeyModifiers::SHIFT;
    }
    result
}

fn terminal_key(stroke: &Keystroke) -> Option<KeyCode> {
    Some(match stroke.key.as_str() {
        "enter" => KeyCode::Enter,
        "backspace" => KeyCode::Backspace,
        "tab" => KeyCode::Tab,
        "escape" => KeyCode::Escape,
        "up" => KeyCode::UpArrow,
        "down" => KeyCode::DownArrow,
        "left" => KeyCode::LeftArrow,
        "right" => KeyCode::RightArrow,
        "home" => KeyCode::Home,
        "end" => KeyCode::End,
        "pageup" => KeyCode::PageUp,
        "pagedown" => KeyCode::PageDown,
        "delete" => KeyCode::Delete,
        "insert" => KeyCode::Insert,
        key if key.starts_with('f')
            && key[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) =>
        {
            KeyCode::Function(key[1..].parse().ok()?)
        }
        key if stroke.modifiers.control || stroke.modifiers.alt => {
            let text = if key == "space" { " " } else { key };
            let mut chars = text.chars();
            let character = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            KeyCode::Char(character)
        }
        _ => return None,
    })
}

// These are terminal data colors supplied by applications, rather than UI decoration.
fn hsla_color(color: SrgbaTuple) -> Hsla {
    Rgba {
        r: color.0,
        g: color.1,
        b: color.2,
        a: color.3,
    }
    .into()
}

fn dropped_path_text(paths: &[std::path::PathBuf]) -> anyhow::Result<String> {
    let paths = paths
        .iter()
        .map(|path| {
            let path = path.to_str().ok_or_else(|| {
                anyhow::anyhow!("Couldn’t insert a path that is not valid UTF-8.")
            })?;
            Ok(if cfg!(windows) {
                format!("'{}'", path.replace('\'', "''"))
            } else {
                ssh::quote(path)
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(format!("{} ", paths.join(" ")))
}

impl Render for TerminalView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        let paint_entity = entity.clone();
        let scrollbar = self.scrollbar.clone();
        let font_scale = self.font_scale;
        let terminal_font = self.font();
        let configured_font_size = self.font_size;
        let line_height = self.appearance.line_height;
        let palette = self.appearance.palette();
        let menu_focus = self.focus.clone();
        let has_selection = self.selection.is_some();
        let show_download = matches!(self.source, TabSource::Ssh { .. }) && has_selection;
        let download_disabled = !self.running
            || self.downloading
            || self.ssh_profile.is_none()
            || self.store.is_none()
            || self.selected_download_path().is_err();
        let edit_disabled = self.selected_file_path().is_err()
            || (matches!(self.source, TabSource::Ssh { .. })
                && (self.ssh_profile.is_none() || self.store.is_none()));
        let show_extract = self.selected_command(true).is_ok();
        let show_run = self.selected_command(false).is_ok();
        let command_disabled = !self.running;
        let mouse_grabbed = self
            .session
            .as_ref()
            .is_some_and(|session| session.terminal.is_mouse_grabbed());
        let screen_text = self
            .session
            .as_ref()
            .map(|session| screen_text(session, self.scroll_offset))
            .unwrap_or_default();
        let show_status_bar = self.status_bar_hovered
            || self.status_bar_until.is_some()
            || self.transfer_percent.is_some();
        div()
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .bg(hsla_color(palette.background))
            .text_color(hsla_color(palette.foreground))
            .key_context("TerminalPane")
            .on_action(cx.listener(Self::find))
            .on_action(cx.listener(Self::show_status_bar))
            .on_action(cx.listener(|view, _: &FindNext, _, cx| view.navigate_search(false, cx)))
            .on_action(cx.listener(|view, _: &FindPrevious, _, cx| view.navigate_search(true, cx)))
            .child(
                div()
                    .id("terminal")
                    .test_support()
                    .role(Role::Terminal)
                    .aria_label("Terminal")
                    .aria_value(screen_text)
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .relative()
                    .p_2()
                    .pr_6()
                    .pb_8()
                    .overflow_hidden()
                    .track_focus(&self.focus)
                    .key_context("Terminal")
                    .on_key_down(cx.listener(Self::on_key_down))
                    .on_action(cx.listener(Self::copy_screen))
                    .on_action(cx.listener(Self::copy))
                    .on_action(cx.listener(Self::download_selection))
                    .on_action(cx.listener(Self::edit_selection))
                    .on_action(cx.listener(|view, _: &ExtractSelection, window, cx| {
                        view.execute_selection(true, window, cx)
                    }))
                    .on_action(cx.listener(|view, _: &RunSelection, window, cx| {
                        view.execute_selection(false, window, cx)
                    }))
                    .on_action(cx.listener(Self::search_selection))
                    .on_action(cx.listener(Self::select_all))
                    .on_action(cx.listener(Self::clear_terminal))
                    .on_action(
                        cx.listener(|view, _: &ZoomIn, _, cx| view.zoom(view.font_scale + 0.1, cx)),
                    )
                    .on_action(
                        cx.listener(|view, _: &ZoomOut, _, cx| {
                            view.zoom(view.font_scale - 0.1, cx)
                        }),
                    )
                    .on_action(cx.listener(|view, _: &ResetZoom, _, cx| view.zoom(1., cx)))
                    .on_action(cx.listener(Self::paste))
                    .on_drop(cx.listener(Self::drop_paths))
                    .on_action(cx.listener(Self::restart))
                    .cursor(if mouse_grabbed {
                        CursorStyle::Arrow
                    } else {
                        CursorStyle::IBeam
                    })
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
                    .on_mouse_down(MouseButton::Middle, cx.listener(Self::mouse_down))
                    .on_mouse_down(MouseButton::Right, cx.listener(Self::mouse_down))
                    .on_scroll_wheel(cx.listener(Self::scroll))
                    .child(
                        canvas(
                            move |bounds, window, cx| {
                                let font_size =
                                    window.rem_size() * (configured_font_size / 16.) * font_scale;
                                let font = terminal_font.clone();
                                let font_id = window.text_system().resolve_font(&font);
                                let width = window
                                    .text_system()
                                    .advance(font_id, font_size, 'M')
                                    .map(|advance| advance.width)
                                    .unwrap_or(font_size * 0.6);
                                let cell_size = size(width, font_size * line_height);
                                entity.update(cx, |view, cx| view.measure(bounds, cell_size, cx));
                                font_size
                            },
                            move |bounds, font_size, window, cx| {
                                let move_entity = paint_entity.clone();
                                window.on_mouse_event(
                                    move |event: &MouseMoveEvent, phase, window, cx| {
                                        if phase == DispatchPhase::Bubble {
                                            move_entity.update(cx, |view, cx| {
                                                view.mouse_move(event, window, cx)
                                            });
                                        }
                                    },
                                );
                                let up_entity = paint_entity.clone();
                                window.on_mouse_event(
                                    move |event: &MouseUpEvent, phase, window, cx| {
                                        if phase == DispatchPhase::Bubble {
                                            up_entity.update(cx, |view, cx| {
                                                view.mouse_up(event, window, cx)
                                            });
                                        }
                                    },
                                );
                                paint_entity.update(cx, |view, cx| {
                                    window.handle_input(
                                        &view.focus,
                                        ElementInputHandler::new(bounds, paint_entity.clone()),
                                        cx,
                                    );
                                    window.with_content_mask(
                                        Some(ContentMask { bounds }),
                                        |window| {
                                            paint_terminal(view, bounds, font_size, window, cx)
                                        },
                                    );
                                });
                            },
                        )
                        .size_full(),
                    )
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .child(
                                canvas(
                                    move |bounds, _, _| {
                                        let mut state = scrollbar.0.get();
                                        state.viewport = bounds;
                                        scrollbar.0.set(state);
                                    },
                                    |_, _, _, _| {},
                                )
                                .absolute()
                                .inset_0()
                                .size_full(),
                            )
                            .child(
                                Scrollbar::vertical(&self.scrollbar)
                                    .id("terminal-scrollbar")
                                    .mode(scrollbar_mode(cx))
                                    .viewport_from_layout(),
                            ),
                    )
                    .map(move |terminal| {
                        if mouse_grabbed {
                            terminal.into_any_element()
                        } else {
                            terminal
                                .context_menu(move |menu, _, _| {
                                    menu.action_context(menu_focus.clone())
                                        .menu_with_icon_and_disabled(
                                            "Copy",
                                            IconName::Copy,
                                            Box::new(Copy),
                                            !has_selection,
                                        )
                                        .menu_with_icon(
                                            "Paste",
                                            IconName::ClipboardPaste,
                                            Box::new(Paste),
                                        )
                                        .when(show_download, |menu| {
                                            menu.separator().menu_with_icon_and_disabled(
                                                "Download",
                                                IconName::Download,
                                                Box::new(DownloadSelection),
                                                download_disabled,
                                            )
                                        })
                                        .when(has_selection, |menu| {
                                            menu.menu_with_icon_and_disabled(
                                                "Edit",
                                                IconName::Pencil,
                                                Box::new(EditSelection),
                                                edit_disabled,
                                            )
                                        })
                                        .when(show_extract, |menu| {
                                            menu.menu_with_icon_and_disabled(
                                                "Extract archive",
                                                IconName::Archive,
                                                Box::new(ExtractSelection),
                                                command_disabled,
                                            )
                                        })
                                        .when(show_run, |menu| {
                                            menu.menu_with_icon_and_disabled(
                                                "Run",
                                                IconName::Play,
                                                Box::new(RunSelection),
                                                command_disabled,
                                            )
                                        })
                                        .when(has_selection, |menu| {
                                            menu.menu_with_icon(
                                                "Search with Google",
                                                IconName::Search,
                                                Box::new(SearchSelection),
                                            )
                                        })
                                        .separator()
                                        .menu_with_icon(
                                            "Select all",
                                            IconName::SquareDashed,
                                            Box::new(SelectAll),
                                        )
                                        .menu_with_icon(
                                            "Copy screen",
                                            IconName::Copy,
                                            Box::new(CopyScreen),
                                        )
                                        .menu_with_icon("Find…", IconName::Search, Box::new(Find))
                                        .separator()
                                        .menu_with_icon(
                                            "Clear terminal",
                                            IconName::Delete,
                                            Box::new(ClearTerminal),
                                        )
                                })
                                .into_any_element()
                        }
                    }),
            )
            .when(self.search_open, |pane| {
                let status = if self.search_input.read(cx).value().is_empty() {
                    String::new()
                } else if let Some(ix) = self.search_active {
                    format!("{} of {}", ix + 1, self.search_matches.len())
                } else if self.search_task.is_some() {
                    "Searching…".into()
                } else {
                    "No matches".into()
                };
                pane.child(
                    div()
                        .absolute()
                        .top_2()
                        .left_2()
                        .right_2()
                        .flex()
                        .justify_end()
                        .child(
                            div()
                                .id("terminal-search")
                                .test_support()
                                .occlude()
                                .w_96()
                                .max_w_full()
                                .flex()
                                .items_center()
                                .gap_2()
                                .px_2()
                                .py_2()
                                .flex_shrink_0()
                                .rounded(cx.theme().radius_tokens().lg)
                                .bg(cx.theme().popover)
                                .text_color(cx.theme().popover_foreground)
                                .shadow_sm()
                                .border_1()
                                .border_color(cx.theme().border)
                                .capture_key_down(cx.listener(Self::search_key_down))
                                .child(div().text_sm().child("Find"))
                                .child(
                                    Input::new(&self.search_input)
                                        .id("terminal-search-input")
                                        .aria_label("Search terminal output")
                                        .small()
                                        .flex_1()
                                        .min_w_0(),
                                )
                                .child(
                                    div()
                                        .id("terminal-search-status")
                                        .test_support()
                                        .role(Role::Status)
                                        .aria_label(status.clone())
                                        .text_sm()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(status),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap_1()
                                        .flex_shrink_0()
                                        .child(
                                            Button::new("terminal-search-previous")
                                                .small()
                                                .ghost()
                                                .icon(IconName::ArrowUp)
                                                .accessibility_label("Previous match")
                                                .tooltip("Previous match (Shift+Enter)")
                                                .disabled(self.search_matches.is_empty())
                                                .on_click(cx.listener(|view, _, _, cx| {
                                                    view.navigate_search(true, cx)
                                                })),
                                        )
                                        .child(
                                            Button::new("terminal-search-next")
                                                .small()
                                                .ghost()
                                                .icon(IconName::ArrowDown)
                                                .accessibility_label("Next match")
                                                .tooltip("Next match (Enter)")
                                                .disabled(self.search_matches.is_empty())
                                                .on_click(cx.listener(|view, _, _, cx| {
                                                    view.navigate_search(false, cx)
                                                })),
                                        ),
                                )
                                .child(
                                    Button::new("terminal-search-close")
                                        .ml_2()
                                        .small()
                                        .ghost()
                                        .icon(IconName::Close)
                                        .accessibility_label("Close search")
                                        .tooltip("Close search (Escape)")
                                        .on_click(cx.listener(|view, _, window, cx| {
                                            view.close_search(window, cx)
                                        })),
                                ),
                        ),
                )
            })
            .child(
                div()
                    .id("terminal-status-bar")
                    .test_support()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .on_hover(cx.listener(|view, hovered, _, cx| {
                        view.status_bar_hovered = *hovered;
                        cx.notify();
                    }))
                    .when(!show_status_bar, |bar| bar.h_1())
                    .when(show_status_bar, |bar| {
                        bar.occlude().child(
                            StatusBar::new()
                                .bg(hsla_color(palette.background))
                                .text_color(hsla_color(palette.foreground))
                                .pl_4()
                                .when_some(self.transfer_percent, |bar, percent| {
                                    bar.left(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap_2()
                                            .w_48()
                                            .flex_shrink_0()
                                            .child(transfer_indicator(
                                                "terminal-transfer-progress",
                                                percent,
                                            ))
                                            .child(
                                                Button::new("terminal-transfer-cancel")
                                                    .xsmall()
                                                    .ghost()
                                                    .icon(IconName::Close)
                                                    .accessibility_label("Cancel transfer")
                                                    .tooltip("Cancel transfer")
                                                    .on_click(cx.listener(|view, _, _, cx| {
                                                        view.cancel_transfer(cx)
                                                    })),
                                            ),
                                    )
                                })
                                .left(
                                    div()
                                        .id("terminal-status-message")
                                        .test_support()
                                        .role(Role::Status)
                                        .aria_label(self.status.clone())
                                        .child(self.status.clone()),
                                )
                                .right(
                                    self.session
                                        .as_ref()
                                        .map(|session| {
                                            format!(
                                                "{} × {}",
                                                session.terminal.screen().physical_cols,
                                                session.terminal.screen().physical_rows
                                            )
                                        })
                                        .unwrap_or_default(),
                                ),
                        )
                    }),
            )
    }
}

fn transfer_indicator(id: &'static str, percent: u8) -> impl IntoElement {
    let label = format!("{percent}%");
    div()
        .id(id)
        .test_support()
        .flex()
        .items_center()
        .gap_2()
        .flex_1()
        .min_w_0()
        .child(
            Progress::new(SharedString::from(format!("{id}-bar")))
                .small()
                .flex_1()
                .value(f32::from(percent))
                .accessibility_label("File transfer progress"),
        )
        .child(
            div()
                .id(SharedString::from(format!("{id}-percentage")))
                .test_support()
                .role(Role::Status)
                .aria_label(label.clone())
                .w_8()
                .flex_shrink_0()
                .text_right()
                .child(label),
        )
}

fn paint_terminal(
    view: &TerminalView,
    bounds: Bounds<Pixels>,
    font_size: Pixels,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(session) = &view.session else {
        return;
    };
    let terminal = &session.terminal;
    let palette = terminal.palette();
    window.paint_quad(fill(bounds, hsla_color(palette.background)));
    let cell_size = view.cell_size;
    let cursor = terminal.cursor_pos();
    let (cursor_shape, blink) = view.appearance.cursor(cursor.shape);
    let block_cursor = cursor_shape == appearance::Cursor::Block;
    let screen = terminal.screen();
    let range = visible_range(session, view.scroll_offset);
    let top = range.start;
    let origin = bounds.origin
        - point(
            px(0.),
            cell_size.height * (view.scroll_offset.ceil() - view.scroll_offset),
        );
    let cursor_visible = view.scroll_offset == 0.
        && view.running
        && view.focus.is_focused(window)
        && cursor.visibility == wezterm_surface::CursorVisibility::Visible
        && (!blink || view.cursor_on || !view.composition.is_empty());
    // ponytail: clone viewport rows; borrow when WezTerm fixes wrapped-buffer indexing.
    for (row, line) in screen.lines_in_phys_range(range).iter().enumerate() {
        let stable_row = screen.phys_to_stable_row_index(top + row);
        let first_match = view
            .search_matches
            .partition_point(|found| found.bounds().1.0 < stable_row);
        let highlights: Vec<_> = view
            .search_matches
            .iter()
            .enumerate()
            .skip(first_match)
            .take_while(|(_, found)| found.bounds().0.0 <= stable_row)
            .map(|(ix, found)| {
                (
                    found.columns(stable_row, screen.physical_cols),
                    Some(ix) == view.search_active,
                )
            })
            .collect();
        for (columns, active) in &highlights {
            window.paint_quad(fill(
                Bounds::new(
                    origin
                        + point(
                            cell_size.width * columns.start as f32,
                            cell_size.height * row as f32,
                        ),
                    size(cell_size.width * columns.len() as f32, cell_size.height),
                ),
                if *active {
                    cx.theme().primary
                } else {
                    cx.theme().selection
                },
            ));
        }
        let selected = view
            .selection
            .map(|selection| {
                selection.columns(
                    screen.phys_to_stable_row_index(top + row),
                    screen.physical_cols,
                )
            })
            .unwrap_or(0..0);
        if !selected.is_empty() {
            window.paint_quad(fill(
                Bounds::new(
                    origin
                        + point(
                            cell_size.width * selected.start as f32,
                            cell_size.height * row as f32,
                        ),
                    size(cell_size.width * selected.len() as f32, cell_size.height),
                ),
                hsla_color(palette.selection_bg),
            ));
        }
        if cursor_visible && block_cursor && cursor.y == row as i64 {
            window.paint_quad(fill(
                Bounds::new(
                    origin
                        + point(
                            cell_size.width * cursor.x as f32,
                            cell_size.height * row as f32,
                        ),
                    cell_size,
                ),
                hsla_color(palette.cursor_bg),
            ));
        }
        let mut text_run: Option<(String, TextRun, Point<Pixels>)> = None;
        let mut next_column = 0;
        for cell in line.visible_cells() {
            let attrs = cell.attrs();
            let mut foreground = hsla_color(palette.resolve_fg(attrs.foreground()));
            let mut background = hsla_color(palette.resolve_bg(attrs.background()));
            if attrs.reverse() {
                std::mem::swap(&mut foreground, &mut background);
            }
            let highlighted = highlights
                .iter()
                .find(|(columns, _)| columns.contains(&cell.cell_index()));
            if let Some((_, active)) = highlighted {
                foreground = if *active {
                    cx.theme().primary_foreground
                } else {
                    cx.theme().foreground
                };
                background = if *active {
                    cx.theme().primary
                } else {
                    cx.theme().selection
                };
            }
            if selected.contains(&cell.cell_index()) {
                foreground = hsla_color(palette.selection_fg);
                background = hsla_color(palette.selection_bg);
            }
            let at_cursor = cursor_visible
                && block_cursor
                && cursor.y == row as i64
                && cursor.x == cell.cell_index();
            if at_cursor {
                foreground = hsla_color(palette.cursor_fg);
                background = hsla_color(palette.cursor_bg);
            }
            let origin = origin
                + point(
                    cell_size.width * cell.cell_index() as f32,
                    cell_size.height * row as f32,
                );
            let cell_bounds = Bounds::new(
                origin,
                size(cell_size.width * cell.width() as f32, cell_size.height),
            );
            if background != hsla_color(palette.background)
                && ((!selected.contains(&cell.cell_index()) && highlighted.is_none()) || at_cursor)
            {
                window.paint_quad(fill(cell_bounds, background));
            }
            if attrs.invisible() {
                paint_text_run(text_run.take(), font_size, cell_size, window, cx);
                continue;
            }
            let mut font = view.font();
            if attrs.intensity() == Intensity::Bold {
                font.weight = FontWeight::BOLD;
            }
            if attrs.italic() {
                font.style = FontStyle::Italic;
            }
            let mut run = TextRun {
                len: cell.str().len(),
                font,
                color: foreground,
                background_color: None,
                underline: (attrs.underline() != Underline::None).then_some(UnderlineStyle {
                    color: Some(foreground),
                    thickness: px(1.),
                    wavy: false,
                }),
                strikethrough: attrs.strikethrough().then_some(StrikethroughStyle {
                    color: Some(foreground),
                    thickness: px(1.),
                }),
            };
            // Batch ordinary text; complex graphemes keep their terminal cell origins.
            if cell.width() == 1 && cell.str().len() == 1 && cell.str().is_ascii() {
                if let Some((text, previous, _)) = &mut text_run {
                    run.len = previous.len;
                    if run == *previous && cell.cell_index() == next_column {
                        text.push_str(cell.str());
                        previous.len += 1;
                        next_column += 1;
                        continue;
                    }
                    run.len = 1;
                }
                paint_text_run(text_run.take(), font_size, cell_size, window, cx);
                text_run = Some((cell.str().to_owned(), run, origin));
                next_column = cell.cell_index() + 1;
            } else {
                paint_text_run(text_run.take(), font_size, cell_size, window, cx);
                paint_text_run(
                    Some((cell.str().to_owned(), run, origin)),
                    font_size,
                    cell_size,
                    window,
                    cx,
                );
            }
        }
        paint_text_run(text_run.take(), font_size, cell_size, window, cx);
    }
    // Block cursors are painted behind glyphs; bars and underlines sit above them.
    if cursor_visible {
        let origin = bounds.origin
            + point(
                cell_size.width * cursor.x as f32,
                cell_size.height * cursor.y as f32,
            );
        if !block_cursor {
            let cursor_bounds = match cursor_shape {
                appearance::Cursor::Underline => Bounds::new(
                    origin + point(px(0.), cell_size.height - px(2.)),
                    size(cell_size.width, px(2.)),
                ),
                _ => Bounds::new(
                    origin,
                    size(
                        px(view.appearance.cursor_width).min(cell_size.width),
                        cell_size.height,
                    ),
                ),
            };
            window.paint_quad(fill(cursor_bounds, hsla_color(palette.cursor_bg)));
        }
        if !view.composition.is_empty() {
            let color = hsla_color(palette.foreground);
            let run = TextRun {
                len: view.composition.len(),
                font: view.font(),
                color,
                background_color: Some(hsla_color(palette.background)),
                underline: Some(UnderlineStyle {
                    color: Some(color),
                    thickness: px(1.),
                    wavy: false,
                }),
                strikethrough: None,
            };
            let shaped = window.text_system().shape_line(
                view.composition.clone().into(),
                font_size,
                &[run],
                None,
            );
            let _ = shaped.paint(origin, cell_size.height, TextAlign::Left, None, window, cx);
        }
    }
}

fn paint_text_run(
    text_run: Option<(String, TextRun, Point<Pixels>)>,
    font_size: Pixels,
    cell_size: Size<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let Some((text, run, origin)) = text_run else {
        return;
    };
    if text.trim().is_empty() {
        return;
    }
    let force_width = text.is_ascii().then_some(cell_size.width);
    let shaped = window
        .text_system()
        .shape_line(text.into(), font_size, &[run], force_width);
    let _ = shaped.paint(origin, cell_size.height, TextAlign::Left, None, window, cx);
}

impl EntityInputHandler for TerminalView {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let units: Vec<_> = self.composition.encode_utf16().collect();
        let slice = units.get(range.clone())?;
        *actual = Some(range);
        String::from_utf16(slice).ok()
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.composition.encode_utf16().count();
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.composition.is_empty()).then(|| 0..self.composition.encode_utf16().count())
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.composition.clear();
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composition.clear();
        for character in text.chars() {
            self.input(KeyCode::Char(character), KeyModifiers::NONE, cx);
        }
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composition = text.into();
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let cursor = self.session.as_ref()?.terminal.cursor_pos();
        Some(Bounds::new(
            self.bounds.origin
                + point(
                    self.cell_size.width * cursor.x as f32,
                    self.cell_size.height * cursor.y as f32,
                ),
            self.cell_size,
        ))
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(0)
    }
}

fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-shift-b", ShowStatusBar, Some("TerminalPane")),
        KeyBinding::new("ctrl-shift-b", ShowStatusBar, Some("TerminalPane")),
        KeyBinding::new("cmd-p", OpenCommandPalette, Some("Workspace")),
        KeyBinding::new("ctrl-p", OpenCommandPalette, Some("Workspace")),
        KeyBinding::new("cmd-f", Find, Some("TerminalPane")),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-f", Find, Some("TerminalPane")),
        KeyBinding::new("ctrl-shift-f", Find, Some("TerminalPane")),
        KeyBinding::new("cmd-g", FindNext, Some("TerminalPane")),
        KeyBinding::new("cmd-shift-g", FindPrevious, Some("TerminalPane")),
        KeyBinding::new("cmd-,", OpenSettings, Some("Workspace")),
        KeyBinding::new("ctrl-,", OpenSettings, Some("Workspace")),
        KeyBinding::new("cmd-shift-s", ManageSshServers, Some("Workspace")),
        KeyBinding::new("ctrl-shift-s", ManageSshServers, Some("Workspace")),
        KeyBinding::new("cmd-t", NewTab, Some("Workspace")),
        KeyBinding::new("ctrl-t", NewTab, Some("Workspace")),
        KeyBinding::new("cmd-d", SplitRight, Some("Workspace")),
        KeyBinding::new("ctrl-shift-d", SplitRight, Some("Workspace")),
        KeyBinding::new("cmd-shift-d", SplitDown, Some("Workspace")),
        KeyBinding::new("ctrl-alt-d", SplitDown, Some("Workspace")),
        KeyBinding::new("cmd-shift-w", ClosePane, Some("Workspace")),
        KeyBinding::new("ctrl-shift-w", ClosePane, Some("Workspace")),
        KeyBinding::new("cmd-alt-right", NextPane, Some("Workspace")),
        KeyBinding::new("ctrl-alt-right", NextPane, Some("Workspace")),
        KeyBinding::new("cmd-alt-left", PreviousPane, Some("Workspace")),
        KeyBinding::new("ctrl-alt-left", PreviousPane, Some("Workspace")),
        KeyBinding::new("cmd-w", CloseTab, Some("Workspace")),
        KeyBinding::new("ctrl-w", CloseTab, Some("Workspace")),
        KeyBinding::new("ctrl-tab", NextTab, Some("Workspace")),
        KeyBinding::new("ctrl-shift-tab", PreviousTab, Some("Workspace")),
        KeyBinding::new("cmd-shift-]", NextTab, Some("Workspace")),
        KeyBinding::new("cmd-shift-}", NextTab, Some("Workspace")),
        KeyBinding::new("cmd-shift-[", PreviousTab, Some("Workspace")),
        KeyBinding::new("cmd-shift-{", PreviousTab, Some("Workspace")),
        KeyBinding::new("ctrl-shift-]", NextTab, Some("Workspace")),
        KeyBinding::new("ctrl-shift-[", PreviousTab, Some("Workspace")),
        // Let terminal key events reach WezTerm instead of the root's GUI navigation.
        KeyBinding::new("tab", NoAction, Some("Terminal")),
        KeyBinding::new("shift-tab", NoAction, Some("Terminal")),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-c", NoAction, Some("Terminal")),
        KeyBinding::new("cmd-c", Copy, Some("Terminal")),
        KeyBinding::new("cmd-shift-c", Copy, Some("Terminal")),
        KeyBinding::new("cmd-alt-c", CopyScreen, Some("Terminal")),
        KeyBinding::new("cmd-a", SelectAll, Some("Terminal")),
        KeyBinding::new("cmd-v", Paste, Some("Terminal")),
        KeyBinding::new("cmd-r", Restart, Some("Terminal")),
        KeyBinding::new("ctrl-shift-c", Copy, Some("Terminal")),
        KeyBinding::new("ctrl-shift-a", SelectAll, Some("Terminal")),
        KeyBinding::new("ctrl-insert", Copy, Some("Terminal")),
        KeyBinding::new("shift-insert", Paste, Some("Terminal")),
        KeyBinding::new("ctrl-shift-v", Paste, Some("Terminal")),
        KeyBinding::new("cmd-=", ZoomIn, Some("Terminal")),
        KeyBinding::new("cmd-+", ZoomIn, Some("Terminal")),
        KeyBinding::new("cmd--", ZoomOut, Some("Terminal")),
        KeyBinding::new("cmd-0", ResetZoom, Some("Terminal")),
        KeyBinding::new("ctrl-shift-=", ZoomIn, Some("Terminal")),
        KeyBinding::new("ctrl-shift--", ZoomOut, Some("Terminal")),
        KeyBinding::new("ctrl-shift-0", ResetZoom, Some("Terminal")),
        KeyBinding::new("cmd-k", ClearTerminal, Some("Terminal")),
        KeyBinding::new("ctrl-shift-k", ClearTerminal, Some("Terminal")),
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-o", OpenFile, Some("Workspace")),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-o", OpenFile, Some("Workspace")),
        KeyBinding::new("cmd-s", editor::SaveFile, Some("FileEditor")),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-s", editor::SaveFile, Some("FileEditor")),
    ]);
}

fn startup_data(
    preview: bool,
) -> anyhow::Result<(Store, Settings, storage::Snapshot, storage::WindowState)> {
    if preview {
        let store = Store::at(std::env::temp_dir().join("RustTerminal-preview"));
        let settings = Settings {
            restore_session: false,
            default_directory: dirs::home_dir(),
            ..Settings::default()
        };
        return Ok((
            store,
            settings,
            storage::Snapshot::default(),
            storage::WindowState::default(),
        ));
    }
    let store = Store::new()?;
    let settings = store.load_settings()?;
    settings.validate()?;
    let mut snapshot: storage::Snapshot = store.load("terminal-session.json")?;
    snapshot.validate()?;
    let state: storage::WindowState = store.load("window-state.json")?;
    if !store.directory().join("settings.json").exists() {
        store.save("settings.json", &settings)?;
    }
    Ok((store, settings, snapshot, state))
}

fn main() {
    if ssh::askpass() {
        return;
    }
    let preview = std::env::args_os().any(|arg| arg == "--preview");
    let application = gpui_kit::application().with_assets(ssh_icons::Assets);
    let pending_urls = Rc::new(RefCell::new(Vec::<String>::new()));
    let url_target = Rc::new(RefCell::new(
        None::<(AnyWindowHandle, WeakEntity<Workspace>, AsyncApp)>,
    ));
    application.on_open_urls({
        let pending_urls = pending_urls.clone();
        let url_target = url_target.clone();
        move |urls| {
            pending_urls.borrow_mut().extend(urls);
            if let Some((handle, workspace, cx)) = url_target.borrow().clone() {
                let urls = std::mem::take(&mut *pending_urls.borrow_mut());
                // Apple events can arrive inside an app update; defer to avoid reentrant borrowing.
                cx.spawn(async move |cx| {
                    let _ = cx.update_window(handle, |_, window, cx| {
                        let _ = workspace.update(cx, |view, cx| view.open_urls(urls, window, cx));
                    });
                })
                .detach();
            }
        }
    });
    application.on_reopen({
        let url_target = url_target.clone();
        move |cx| {
            if let Some((handle, _, _)) = &*url_target.borrow() {
                let _ = cx.update_window(*handle, |_, window, cx| {
                    window.activate_window();
                    cx.activate(true);
                });
            }
        }
    });
    application.run(move |cx| {
            gpui_kit::init(cx);
            appearance::register_fonts(cx).expect("Couldn’t load bundled terminal fonts");
            Theme::change(ThemeMode::Dark, None, cx);

            Theme::update(cx, |theme| {
                theme.background = rgb(0x000000).into();
                theme.foreground = rgb(0xeef4ff).into();
                theme.popover = rgb(0x1a1a1a).into();
                theme.popover_foreground = theme.foreground;
                theme.radius = theme.radius_tokens().lg;
                theme.muted_foreground = rgb(0x94a8c3).into();
                theme.title_bar = rgb(0x080c12).into();
                theme.tab = rgba(0xffffff0a).into();
                theme.tab_active = rgba(0xffffff1a).into();
                theme.tab_foreground = rgb(0xcfd9ea).into();
                theme.tab_active_foreground = rgb(0xeef4ff).into();
                theme.primary = rgb(0x77d7ff).into();
                theme.success = rgb(0x7bf2b0).into();
                theme.warning = rgb(0xffd479).into();
                theme.danger = rgb(0xff8d89).into();
                theme.border = rgba(0x7096bd38).into();
                theme.input = rgba(0xffffff38).into();
            });
            bind_keys(cx);
            cx.on_action(|_: &Quit, cx| {
                if !editor::prevent_quit(cx) { cx.quit(); }
            });
            #[cfg(target_os = "macos")]
            updater::init(cx);
            cx.set_menus(vec![
                Menu {
                    name: "TerminalFlow".into(),
                    disabled: false,
                    items: vec![
                        MenuItem::action("New tab", NewTab),
                        MenuItem::action("Open local file…", OpenFile),
                        MenuItem::action("Command palette…", OpenCommandPalette),
                        MenuItem::action("Close tab", CloseTab),
                        MenuItem::separator(),
                        MenuItem::action("Add SSH server…", AddSshServer),
                        MenuItem::action("SSH servers…", ManageSshServers),
                        MenuItem::action("Settings…", OpenSettings),
                        #[cfg(target_os = "macos")]
                        MenuItem::action("Check for Updates…", CheckForUpdates),
                        MenuItem::separator(),
                        MenuItem::action("Quit", Quit),
                    ],
                },
                Menu {
                    name: "Edit".into(),
                    disabled: false,
                    items: vec![
                        MenuItem::action("Copy", Copy),
                        MenuItem::action("Copy screen", CopyScreen),
                        MenuItem::action("Paste", Paste),
                        MenuItem::action("Select all", SelectAll),
                        MenuItem::separator(),
                        MenuItem::action("Find…", Find),
                        MenuItem::action("Find next", FindNext),
                        MenuItem::action("Find previous", FindPrevious),
                        MenuItem::separator(),
                        MenuItem::action("Clear terminal", ClearTerminal),
                    ],
                },
                Menu {
                    name: "View".into(),
                    disabled: false,
                    items: vec![
                        MenuItem::action("Zoom in", ZoomIn),
                        MenuItem::action("Zoom out", ZoomOut),
                        MenuItem::action("Actual size", ResetZoom),
                        MenuItem::action("Show status bar", ShowStatusBar),
                        MenuItem::separator(),
                        MenuItem::action("Split right", SplitRight),
                        MenuItem::action("Split down", SplitDown),
                        MenuItem::action("Close pane", ClosePane),
                        MenuItem::action("Next pane", NextPane),
                        MenuItem::action("Previous pane", PreviousPane),
                        MenuItem::separator(),
                        MenuItem::action("Next tab", NextTab),
                        MenuItem::action("Previous tab", PreviousTab),
                    ],
                },
            ]);
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            let loaded = startup_data(preview);
            let (store, settings, snapshot, state, error) = match loaded {
                Ok((store, settings, snapshot, state)) => (Some(store), settings, snapshot, state, None),
                Err(error) => (None, Settings::default(), storage::Snapshot::default(), storage::WindowState::default(), Some(format!("Couldn’t load app data: {error:#}. Existing files have been preserved; saving is disabled."))),
            };
            let width = if state.width.is_finite() && state.width > 0. { state.width.clamp(640., 4000.) } else { 1000. };
            let height = if state.height.is_finite() && state.height > 0. { state.height.clamp(480., 2400.) } else { 600. };
            let mut bounds = Bounds::centered(None, size(px(width), px(height)), cx);
            if state.x.is_finite() && state.y.is_finite() && state.width > 0. {
                let saved = Bounds::new(point(px(state.x), px(state.y)), size(px(width), px(height)));
                // Keep the title bar reachable after a monitor is removed.
                if cx.displays().iter().any(|display| display.bounds().contains(&point(saved.origin.x + px(100.), saved.origin.y + px(20.)))) { bounds = saved; }
            }
            // Native window geometry is a physical platform boundary.
            let options = WindowOptions {
                window_bounds: Some(if state.maximized { WindowBounds::Maximized(bounds) } else { WindowBounds::Windowed(bounds) }),
                window_min_size: Some(size(px(640.), px(480.))),
                titlebar: Some(TitlebarOptions {
                    title: Some("TerminalFlow".into()),
                    ..TitleBar::title_bar_options()
                }),
                ..TitleBar::window_options()
            };
            match gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| Workspace::restore(store, settings, snapshot, error, window, cx))
            }) {
                Ok((handle, workspace)) => {
                    *url_target.borrow_mut() = Some((handle, workspace.downgrade(), cx.to_async()));
                    let urls = std::mem::take(&mut *pending_urls.borrow_mut());
                    if !urls.is_empty() {
                        let _ = cx.update_window(handle, |_, window, cx| {
                            workspace.update(cx, |view, cx| view.open_urls(urls, window, cx));
                        });
                    }
                }
                Err(error) => {
                eprintln!("Couldn’t open the terminal window: {error:#}");
                cx.quit();
                }
            }
            cx.activate(true);
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn preview_starts_fresh_without_loading_personal_app_data() {
        let (store, settings, snapshot, _) = super::startup_data(true).unwrap();
        assert_eq!(
            store.directory(),
            std::env::temp_dir().join("RustTerminal-preview")
        );
        assert!(!settings.restore_session);
        assert_eq!(settings.default_directory, dirs::home_dir());
        assert!(settings.ssh_servers.is_empty());
        assert!(settings.quick_commands.is_empty());
        assert!(snapshot.tabs.is_empty());
    }

    use super::{TerminalView, Workspace, bind_keys};
    use gpui_kit::{
        AppContext, ClipboardItem, Entity, ExternalPaths, FileDropEvent, InputEvent, Keystroke,
        Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ScrollDelta,
        TestAppContext, WindowHandle,
        component::{Root, Theme, WindowExt},
        point, px, size,
        test::{TestAppContextExt, TestWindowExt},
    };
    use std::{
        io::Write,
        sync::{
            Arc,
            mpsc::{self, Receiver, Sender},
        },
        time::Duration,
    };
    use wezterm_term::{Terminal, TerminalConfiguration, TerminalSize, color::ColorPalette};

    #[derive(Debug)]
    pub(super) struct Configuration;
    impl TerminalConfiguration for Configuration {
        fn color_palette(&self) -> ColorPalette {
            ColorPalette::default()
        }
    }

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

    pub(super) fn open_terminal(
        cx: &mut TestAppContext,
    ) -> (WindowHandle<Root>, Entity<TerminalView>, Receiver<Vec<u8>>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            bind_keys(cx);
        });
        let (sender, bytes) = mpsc::channel();
        let mut view = None;
        let handle = cx.open_window(size(px(640.), px(480.)), |window, cx| {
            let terminal = cx.new(|cx| {
                let mut view = TerminalView::new(window, cx);
                // Capture the actual encoder output at the PTY writer boundary.
                view.session.as_mut().expect("shell started").terminal = Terminal::new(
                    TerminalSize::default(),
                    Arc::new(Configuration),
                    "test",
                    "1",
                    Box::new(Writer(sender)),
                );
                view
            });
            view = Some(terminal.clone());
            let workspace = cx.new(|cx| Workspace::with_terminal(terminal, window, cx));
            Root::new(workspace, window, cx)
        });
        (handle, view.unwrap(), bytes)
    }

    #[gpui_kit::test]
    fn visual_status_bar_auto_hides_without_resizing_terminal(cx: &mut TestAppContext) {
        let (handle, view, _bytes) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            view.update(cx, |view, cx| {
                view.running = false;
                view.connecting = true;
                cx.notify();
            });
            window.render_frame(cx);
            assert!(window.try_find("terminal-status-message").is_none());
            view.update(cx, |view, cx| {
                view.running = true;
                view.connecting = false;
                cx.notify();
            });
            window.render_frame(cx);
            let terminal_bounds = window.find("terminal").bounds();
            let terminal_size = view.read(cx).session.as_ref().unwrap().terminal.get_size();

            window.hover("terminal-status-bar", cx);
            assert!(window.find("terminal-status-message").visible());
            assert!(
                view.read(cx).bounds.bottom() < window.find("terminal-status-bar").bounds().top()
            );
            window.hover("terminal-status-message", cx);
            assert!(window.find("terminal-status-message").visible());
            assert_eq!(window.find("terminal").bounds(), terminal_bounds);
            assert_eq!(
                view.read(cx).session.as_ref().unwrap().terminal.get_size(),
                terminal_size
            );
            window.hover("terminal", cx);
            assert!(window.try_find("terminal-status-message").is_none());

            window.press("secondary-shift-b", cx);
            assert!(window.find("terminal-status-message").visible());
            view.update(cx, |view, cx| {
                view.status_bar_until = Some(std::time::Instant::now());
                view.update_status_bar(cx);
            });
            window.render_frame(cx);
            assert!(window.try_find("terminal-status-message").is_none());

            view.update(cx, |view, cx| {
                view.status = "Couldn’t download: connection closed".into();
                view.update_status_bar(cx);
            });
            window.render_frame(cx);
            assert_eq!(
                window.find("terminal-status-message").label(),
                Some("Couldn’t download: connection closed")
            );
            view.update(cx, |view, cx| {
                view.update_status_bar(cx);
            });
            window.render_frame(cx);
            assert!(window.find("terminal-status-message").visible());

            view.update(cx, |view, cx| {
                view.status_bar_until = Some(std::time::Instant::now());
                view.update_status_bar(cx);
                view.transfer_percent = Some(25);
                cx.notify();
            });
            window.render_frame(cx);
            assert!(window.find("terminal-transfer-cancel").visible());
            assert!(
                view.read(cx).bounds.bottom() < window.find("terminal-status-bar").bounds().top()
            );
            view.update(cx, |view, cx| {
                view.transfer_percent = None;
                view.connecting = true;
                cx.notify();
            });
            window.render_frame(cx);
            assert!(window.try_find("terminal-status-message").is_none());
            view.update(cx, |view, cx| {
                view.connecting = false;
                view.running = false;
                cx.notify();
            });
            window.render_frame(cx);
            assert!(window.try_find("terminal-status-message").is_none());
            view.update(cx, |view, cx| {
                view.start(cx);
                view.update_status_bar(cx);
            });
            window.render_frame(cx);
            assert!(window.try_find("terminal-status-message").is_none());
        })
        .unwrap();
    }

    #[cfg(unix)]
    #[gpui_kit::test]
    fn visual_transfer_progress_cancels_a_blocked_request(cx: &mut TestAppContext) {
        let (handle, view, _) = open_terminal(cx);
        let connection = Arc::new(crate::sftp::Connection::default());
        let worker = connection.clone();
        let (started, ready) = mpsc::channel();
        let work = std::thread::spawn(move || {
            worker.run(
                || {
                    let mut command = std::process::Command::new("sh");
                    command.args(["-c", "exec sleep 10"]);
                    started.send(()).unwrap();
                    Ok(command)
                },
                false,
                |_| Ok(()),
            )
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        cx.update_window(handle.into(), |_, window, cx| {
            view.update(cx, |view, cx| {
                view.transfer_connection = Some(connection.clone());
                view.transfer_percent = Some(50);
                view.downloading = true;
                view.status = "Downloading file (1.5 KiB / 3.0 KiB)".into();
                cx.notify();
            });
            window.render_frame(cx);
            let progress = window.find("terminal-transfer-progress");
            assert!(progress.visible());
            assert!(progress.bounds().size.width > px(50.));
            assert_eq!(
                window.find("terminal-transfer-progress-percentage").label(),
                Some("50%")
            );
            assert_eq!(
                window.find("terminal-transfer-cancel").label(),
                Some("Cancel transfer")
            );
            window.click("terminal-transfer-cancel", cx);
            assert!(window.try_find("terminal-transfer-progress").is_none());
            assert_eq!(view.read(cx).status, "Transfer cancelled");
            assert!(!view.read(cx).downloading);
        })
        .unwrap();
        assert!(work.join().unwrap().is_err());
        assert!(
            connection
                .run(
                    || panic!("Cancelled transfers must not reconnect"),
                    false,
                    |_| Ok(())
                )
                .is_err()
        );
    }

    #[gpui_kit::test]
    async fn search_shortcuts_navigate_history_without_sending_shell_input(
        cx: &mut TestAppContext,
    ) {
        let (handle, view, bytes) = open_terminal(cx);
        let (output, receiver) = mpsc::channel();
        let find_key = if cfg!(target_os = "macos") {
            "cmd-f"
        } else {
            "ctrl-f"
        };
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                view.session.as_mut().unwrap().output = receiver;
                let text = format!("old AbC\r\n{}new abc abc\r\n", "filler\r\n".repeat(60));
                output
                    .send(crate::session::Output::Bytes(text.into_bytes()))
                    .unwrap();
                view.read_output(cx);
            });
            window.render_frame(cx);
            let terminal_bounds = window.find("terminal").bounds();
            let terminal_size = view.read(cx).session.as_ref().unwrap().terminal.get_size();
            window.press(find_key, cx);
            assert_eq!(window.find("terminal-search-input").focused(), Some(true));
            let overlay = window.find("terminal-search").bounds();
            let bar = window.find("terminal-search-close").bounds();
            let input = window.find("terminal-search-input").bounds();
            assert_eq!(window.find("terminal").bounds(), terminal_bounds);
            assert_eq!(
                view.read(cx).session.as_ref().unwrap().terminal.get_size(),
                terminal_size
            );
            assert!(overlay.left() > terminal_bounds.left());
            assert!(overlay.right() <= terminal_bounds.right());
            assert!(overlay.top() > terminal_bounds.top());
            assert!(overlay.bottom() < terminal_bounds.bottom());
            assert!(bar.right() <= overlay.right());
            assert_eq!(bar.center().y, input.center().y);
            assert!(input.top() >= overlay.top() && input.bottom() <= overlay.bottom());
            window.input("ABC", cx);
        })
        .unwrap();
        cx.wait_for(handle.into(), Duration::from_secs(2), |window, _| {
            window.find("terminal-search-status").label() == Some("3 of 3")
        })
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                window.find("terminal-search-status").label(),
                Some("3 of 3")
            );
            window.press("enter", cx);
            assert_eq!(
                window.find("terminal-search-status").label(),
                Some("1 of 3")
            );
            assert!(view.read(cx).scroll_offset > 0.);
            assert!(window.find("terminal").value().unwrap().contains("old AbC"));
            let before = view.read(cx).scroll_offset;
            view.update(cx, |view, cx| {
                output
                    .send(crate::session::Output::Bytes(b"live abc\r\n".to_vec()))
                    .unwrap();
                view.read_output(cx);
            });
            assert!(view.read(cx).scroll_offset >= before);
        })
        .unwrap();
        cx.wait_for(handle.into(), Duration::from_secs(2), |window, _| {
            window.find("terminal-search-status").label() == Some("1 of 4")
        })
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press("shift-enter", cx);
            assert_eq!(
                window.find("terminal-search-status").label(),
                Some("4 of 4")
            );
            window.click("terminal-search-previous", cx);
            assert_eq!(
                window.find("terminal-search-status").label(),
                Some("3 of 4")
            );
            window.click("terminal-search-next", cx);
            assert_eq!(
                window.find("terminal-search-status").label(),
                Some("4 of 4")
            );
            window.press(find_key, cx);
            window.input("missing", cx);
        })
        .unwrap();
        cx.wait_for(handle.into(), Duration::from_secs(2), |window, _| {
            window.find("terminal-search-status").label() == Some("No matches")
        })
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                window.find("terminal-search-status").label(),
                Some("No matches")
            );
            window.click("terminal-search-next", cx);
            assert!(view.read(cx).search_active.is_none());
            window.click("terminal-search-input", cx);
            window.press("enter", cx);
            window.press("escape", cx);
            assert!(window.try_find("terminal-search-input").is_none());
            assert!(view.read(cx).focus.is_focused(window));
            assert!(
                bytes.try_recv().is_err(),
                "search keys must not reach the PTY"
            );
            window.input("x", cx);
            assert_eq!(bytes.recv_timeout(Duration::from_secs(1)).unwrap(), b"x");
            window.press(find_key, cx);
            assert_eq!(
                window.find("terminal-search-input").value(),
                Some("missing")
            );
            window.input("abc", cx);
        })
        .unwrap();
        cx.wait_for(handle.into(), Duration::from_secs(2), |window, _| {
            window.find("terminal-search-status").label() == Some("4 of 4")
        })
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            if cfg!(target_os = "macos") {
                window.press("cmd-g", cx);
                assert_eq!(
                    window.find("terminal-search-status").label(),
                    Some("1 of 4")
                );
                window.press("cmd-shift-g", cx);
                assert_eq!(
                    window.find("terminal-search-status").label(),
                    Some("4 of 4")
                );
            }
            window.click("terminal-search-close", cx);
            assert!(view.read(cx).focus.is_focused(window));
            assert!(view.read(cx).search_matches.is_empty());
        })
        .unwrap();
        for (width, font_size) in [(320., 16.), (640., 20.)] {
            cx.update(|cx| Theme::update(cx, |theme| theme.font_size = px(font_size)));
            cx.simulate_window_resize(handle.into(), size(px(width), px(480.)));
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                let terminal = window.find("terminal").bounds();
                window.press(find_key, cx);
                let overlay = window.find("terminal-search").bounds();
                let input = window.find("terminal-search-input").bounds();
                assert_eq!(window.find("terminal").bounds(), terminal);
                assert!(overlay.left() >= terminal.left());
                assert_eq!(overlay.right(), terminal.right() - window.rem_size() * 0.5);
                assert!(input.size.width > window.rem_size() * 2.);
                window.click("terminal-search-input", cx);
                assert!(view.read(cx).selection.is_none());
                window.press("escape", cx);
                assert!(view.read(cx).focus.is_focused(window));
            })
            .unwrap();
        }
    }

    #[gpui_kit::test]
    async fn search_edits_debounce_and_cancel_without_blocking_input(cx: &mut TestAppContext) {
        let (handle, view, _) = open_terminal(cx);
        cx.simulate_window_resize(handle.into(), size(px(1600.), px(600.)));
        cx.run_until_parked();
        let (output, receiver) = mpsc::channel();
        let find_key = if cfg!(target_os = "macos") {
            "cmd-f"
        } else {
            "ctrl-f"
        };
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                view.session.as_mut().unwrap().output = receiver;
                output
                    .send(crate::session::Output::Bytes(
                        format!("{}abc\r\n", "0123456789".repeat(15))
                            .repeat(3500)
                            .into_bytes(),
                    ))
                    .unwrap();
                view.read_output(cx);
            });
            window.render_frame(cx);
            window.press(find_key, cx);
            window.input("abcx", cx);
            window.press("backspace", cx);
            assert_eq!(window.find("terminal-search-input").value(), Some("abc"));
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                window.find("terminal-search-status").label(),
                Some("Searching…")
            );
            assert!(view.read(cx).search_matches.is_empty());
        })
        .unwrap();
        cx.wait_for(handle.into(), Duration::from_secs(2), |window, _| {
            window.find("terminal-search-status").label() == Some("3500 of 3500")
        })
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            window.press(find_key, cx);
            window.input("missing", cx);
            window.press(find_key, cx);
            window.press("backspace", cx);
            assert_eq!(window.find("terminal-search-input").value(), Some(""));
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(view.read(cx).search_matches.is_empty());
            assert!(view.read(cx).search_task.is_none());
            window.input("abc", cx);
            window.press("escape", cx);
            assert!(view.read(cx).search_task.is_none());
        })
        .unwrap();
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(200));
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("terminal-search-input").is_none());
            assert!(view.read(cx).search_matches.is_empty());
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn file_drops_insert_local_paths_and_require_a_remote_directory(cx: &mut TestAppContext) {
        let (handle, view, bytes) = open_terminal(cx);
        let paths = [
            std::path::PathBuf::from("/tmp/a file's $HOME.txt"),
            std::path::PathBuf::from("/tmp/folder"),
        ];
        cx.update_window(handle.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            let position = window.find("terminal").bounds().center();
            for remote in [false, true] {
                if remote {
                    view.update(cx, |view, _| {
                        view.source = crate::storage::TabSource::Ssh {
                            profile_id: String::new(),
                            directory: "/stale/directory".into(),
                        };
                    });
                }
                window.dispatch_event(
                    FileDropEvent::Entered {
                        position,
                        paths: ExternalPaths(paths.clone().into_iter().collect()),
                    }
                    .to_platform_input(),
                    cx,
                );
                window.draw(cx).clear(cx);
                window.dispatch_event(FileDropEvent::Submit { position }.to_platform_input(), cx);
                window.draw(cx).clear(cx);
                assert!(view.read(cx).focus.is_focused(window));
                if remote {
                    assert!(
                        view.read(cx)
                            .status
                            .contains("remote working directory is not available")
                    );
                    assert!(bytes.try_recv().is_err());
                } else {
                    let text = crate::dropped_path_text(&paths).unwrap();
                    assert_eq!(
                        bytes.recv_timeout(Duration::from_secs(1)).unwrap(),
                        text.as_bytes()
                    );
                    #[cfg(unix)]
                    {
                        let output = std::process::Command::new("/bin/sh")
                            .args(["-c", &format!("printf '%s\\0' {text}")])
                            .output()
                            .unwrap();
                        assert!(output.status.success());
                        assert_eq!(output.stdout, b"/tmp/a file's $HOME.txt\0/tmp/folder\0");
                    }
                }
            }
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn session_snapshots_do_not_accumulate_live_prompts(cx: &mut TestAppContext) {
        let (handle, view, _) = open_terminal(cx);
        cx.update_window(handle.into(), |_, _, cx| {
            view.update(cx, |view, _| {
                let prompt = "mustafa@MacBookPro Downloads %";
                let history = "mustafa@MacBookPro ~ % cd Downloads";
                let terminal = &mut view.session.as_mut().unwrap().terminal;
                terminal.advance_bytes(format!("{history}\r\n{prompt}\r\n{prompt}\r\n{prompt} "));
                assert_eq!(view.snapshot().output, vec![history]);

                for _ in 0..3 {
                    let saved = view.snapshot().output;
                    let terminal = &mut view.session.as_mut().unwrap().terminal;
                    terminal.erase_scrollback_and_viewport();
                    terminal.advance_bytes(b"\x1b[H");
                    for line in saved {
                        terminal.advance_bytes(format!("{line}\r\n"));
                    }
                    terminal.advance_bytes(format!("{prompt} "));
                    assert_eq!(view.snapshot().output, vec![history]);
                }

                let terminal = &mut view.session.as_mut().unwrap().terminal;
                terminal.advance_bytes(b"echo test\r\nrepeat\r\nrepeat\r\n");
                terminal.advance_bytes(format!("{prompt} "));
                assert_eq!(
                    view.snapshot().output,
                    vec![history, &format!("{prompt} echo test"), "repeat", "repeat"]
                );
                view.running = false;
                assert_eq!(view.snapshot().output.last().unwrap(), prompt);

                view.running = true;
                let terminal = &mut view.session.as_mut().unwrap().terminal;
                terminal.resize(TerminalSize {
                    rows: 3,
                    cols: 20,
                    ..TerminalSize::default()
                });
                terminal.erase_scrollback_and_viewport();
                terminal.advance_bytes(b"\x1b[H");
                terminal.advance_bytes(format!("cd Downloads\r\n{prompt} "));
                assert_eq!(view.snapshot().output, vec!["cd Downloads"]);
            });
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn terminal_keys_reach_the_shell_without_moving_focus(cx: &mut TestAppContext) {
        let (handle, view, bytes) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            for (key, expected) in [
                ("tab", b"\t".as_slice()),
                ("shift-tab", b"\x1b[Z"),
                ("enter", b"\r"),
                ("up", b"\x1b[A"),
                ("ctrl-c", b"\x03"),
            ] {
                window.press(key, cx);
                assert!(
                    view.read(cx).focus.is_focused(window),
                    "focus moved for {key}"
                );
                assert_eq!(
                    bytes.recv_timeout(Duration::from_secs(1)).unwrap(),
                    expected,
                    "{key}"
                );
            }
            cx.write_to_clipboard(ClipboardItem::new_string("hello".into()));
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-v"
                } else {
                    "ctrl-shift-v"
                },
                cx,
            );
            assert_eq!(
                bytes.recv_timeout(Duration::from_secs(1)).unwrap(),
                b"hello"
            );
            assert!(view.read(cx).focus.is_focused(window));
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn mouse_selection_copies_words_lines_unicode_and_preserves_shell_shortcuts(
        cx: &mut TestAppContext,
    ) {
        let (handle, view, bytes) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes("alpha beta\r\n你好 café");
                cx.notify();
            });
            window.render_frame(cx);
            let bounds = view.read(cx).bounds;
            let cell = view.read(cx).cell_size;
            let at = |column: f32, row: f32| {
                bounds.origin + point(cell.width * column, cell.height * row)
            };
            let copy_key = if cfg!(target_os = "macos") {
                "cmd-c"
            } else {
                "ctrl-shift-c"
            };
            let clipboard = |cx: &gpui_kit::App| {
                cx.read_from_clipboard()
                    .and_then(|item| item.text())
                    .unwrap()
            };

            window.drag(at(0.5, 0.5), at(4.5, 0.5), cx);
            window.press(copy_key, cx);
            assert_eq!(clipboard(cx), "alpha");
            assert!(
                bytes.try_recv().is_err(),
                "selection must not type into the shell"
            );
            assert!(window.find("terminal").focused().unwrap());

            window.drag(at(9.5, 0.5), at(6.5, 0.5), cx);
            window.press(copy_key, cx);
            assert_eq!(clipboard(cx), "beta");

            // A word selected at an explicit cell, through native pointer dispatch.
            for count in 1..=2 {
                window.dispatch_event(
                    MouseDownEvent {
                        button: MouseButton::Left,
                        position: at(7.5, 0.5),
                        click_count: count,
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
                window.dispatch_event(
                    MouseUpEvent {
                        button: MouseButton::Left,
                        position: at(7.5, 0.5),
                        click_count: count,
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            }
            window.press(copy_key, cx);
            assert_eq!(clipboard(cx), "beta");

            window.drag(at(0.5, 1.5), at(8.5, 1.5), cx);
            window.press(copy_key, cx);
            assert_eq!(clipboard(cx), "你好 café");
            for count in 1..=3 {
                window.dispatch_event(
                    MouseDownEvent {
                        button: MouseButton::Left,
                        position: at(2.5, 0.5),
                        click_count: count,
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
                window.dispatch_event(
                    MouseUpEvent {
                        button: MouseButton::Left,
                        position: at(2.5, 0.5),
                        click_count: count,
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            }
            window.press(copy_key, cx);
            assert_eq!(clipboard(cx), "alpha beta");

            window.press("escape", cx);
            assert!(view.read(cx).selection.is_none());
            assert!(bytes.try_recv().is_err());
            window.press("ctrl-c", cx);
            assert_eq!(bytes.recv_timeout(Duration::from_secs(1)).unwrap(), b"\x03");
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-a"
                } else {
                    "ctrl-shift-a"
                },
                cx,
            );
            window.press(copy_key, cx);
            assert_eq!(clipboard(cx), "alpha beta\n你好 café");
            window.click("workspace-menu", cx);
            window.press("down", cx);
            window.press("down", cx);
            window.press("enter", cx);
            assert_eq!(clipboard(cx), "alpha beta\n你好 café");
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn wrapped_scrollback_renders_scrolls_and_copies(cx: &mut TestAppContext) {
        let (handle, view, _bytes) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                let session = view.session.as_mut().unwrap();
                for row in 0..7200 {
                    session.terminal.advance_bytes(format!("row-{row:04}\r\n"));
                }
                let rows = session.terminal.screen().physical_rows;
                let expected = (7201 - rows..7200)
                    .map(|row| format!("row-{row:04}\n"))
                    .collect::<String>();
                assert_eq!(super::screen_text(session, 0.), expected);
                cx.notify();
            });
            window.render_frame(cx);
            window.click("terminal", cx);
            window.press("shift-home", cx);
            let terminal = view.read(cx);
            let session = terminal.session.as_ref().unwrap();
            assert_eq!(terminal.scroll_offset, 3500.);
            let rows = session.terminal.screen().physical_rows;
            let expected = (3701 - rows..3701)
                .map(|row| format!("row-{row:04}"))
                .collect::<Vec<_>>()
                .join("\n");
            assert_eq!(
                super::screen_text(session, terminal.scroll_offset),
                expected
            );
            window.press("shift-end", cx);
            window.press("cmd-alt-c", cx);
            let session = view.read(cx).session.as_ref().unwrap();
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                super::screen_text(session, 0.)
            );
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn scrollbar_is_visible_and_drags_terminal_history(cx: &mut TestAppContext) {
        let (handle, view, _bytes) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let thumb = |window: &gpui_kit::Window| {
                let viewport = window.find("terminal").bounds();
                window.painted_quads().into_iter().find_map(|quad| {
                    let bounds = quad
                        .bounds
                        .map(|value| px(value.as_f32() / window.scale_factor()));
                    (bounds.left() >= viewport.right() - px(16.)
                        && bounds.size.width > px(0.)
                        && bounds.size.width <= px(8.)
                        && bounds.size.height >= px(48.)
                        && bounds.top() >= viewport.top()
                        && bounds.bottom() <= viewport.bottom())
                    .then_some(bounds)
                })
            };
            assert!(thumb(window).is_none(), "empty history has no scrollbar");
            view.update(cx, |view, cx| {
                let terminal = &mut view.session.as_mut().unwrap().terminal;
                for row in 0..terminal.screen().physical_rows * 4 {
                    terminal.advance_bytes(format!("row-{row:03}\r\n"));
                }
                cx.notify();
            });
            window.render_frame(cx);
            let bottom_thumb = thumb(window).expect("history should show a scrollbar thumb");
            window.scroll("terminal", ScrollDelta::Lines(point(0., 3.)), cx);
            let scrolled_thumb = thumb(window).expect("scrolling keeps the thumb visible");
            assert!(scrolled_thumb.top() < bottom_thumb.top());

            let viewport = window.find("terminal").bounds();
            window.drag(
                scrolled_thumb.center(),
                point(viewport.right() - px(8.), viewport.top()),
                cx,
            );
            let history_rows = {
                let screen = view.read(cx).session.as_ref().unwrap().terminal.screen();
                screen.scrollback_rows() - screen.physical_rows
            };
            assert_eq!(view.read(cx).scroll_offset, history_rows as f32);
            assert!(view.read(cx).selection.is_none());
            assert!(view.read(cx).focus.is_focused(window));
            window.click_at(
                "terminal",
                point(viewport.size.width - px(8.), viewport.size.height - px(2.)),
                cx,
            );
            assert_eq!(view.read(cx).scroll_offset, 0.);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-k"
                } else {
                    "ctrl-shift-k"
                },
                cx,
            );
            assert!(
                thumb(window).is_none(),
                "clearing history hides the scrollbar"
            );
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn trackpad_scroll_moves_less_than_a_row_and_selection_follows(cx: &mut TestAppContext) {
        let (handle, view, _bytes) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                let terminal = &mut view.session.as_mut().unwrap().terminal;
                for row in 0..terminal.screen().physical_rows * 2 {
                    terminal.advance_bytes(format!("row-{row:03}\r\n"));
                }
                cx.notify();
            });
            window.render_frame(cx);
            let bounds = view.read(cx).bounds;
            let cell = view.read(cx).cell_size;
            let previous_row = {
                let screen = view.read(cx).session.as_ref().unwrap().terminal.screen();
                let top = screen.scrollback_rows() - screen.physical_rows;
                screen.lines_in_phys_range(top - 1..top)[0]
                    .as_str()
                    .trim_end()
                    .to_owned()
            };
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), cell.height * 0.25)),
                cx,
            );
            assert_eq!(view.read(cx).scroll_offset, 0.25);
            let terminal_mask = bounds.scale(window.scale_factor());
            assert_eq!(
                window
                    .painted_quads()
                    .iter()
                    .filter(|quad| quad.content_mask.bounds == terminal_mask)
                    .count(),
                1,
                "plain text needs one viewport background, not a quad per cell",
            );
            let at = |column: f32| bounds.origin + point(cell.width * column, cell.height * 0.1);
            window.drag(at(0.5), at(previous_row.len() as f32 - 0.5), cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-c"
                } else {
                    "ctrl-shift-c"
                },
                cx,
            );
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                previous_row
            );
            let selection_top = (bounds.origin - point(px(0.), cell.height * 0.75))
                .scale(window.scale_factor())
                .y;
            assert!(
                window.painted_quads().iter().any(|quad| {
                    quad.background
                        == crate::hsla_color(
                            view.read(cx)
                                .session
                                .as_ref()
                                .unwrap()
                                .terminal
                                .palette()
                                .selection_bg,
                        )
                        .into()
                        && (quad.bounds.origin.y - selection_top).0.abs() <= 0.5
                        && quad.content_mask.bounds == terminal_mask
                }),
                "selection should paint on the partially visible row"
            );

            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), cell.height * 0.75)),
                cx,
            );
            assert_eq!(view.read(cx).scroll_offset, 1.);
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), -cell.height * 1000.)),
                cx,
            );
            assert_eq!(view.read(cx).scroll_offset, 0.);
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), cell.height * 0.25)),
                cx,
            );
            assert_eq!(view.read(cx).scroll_offset, 0.25);
            window.input("x", cx);
            assert_eq!(view.read(cx).scroll_offset, 0.);
            window.press("shift-home", cx);
            let oldest = view.read(cx).scroll_offset;
            window.scroll("terminal", ScrollDelta::Lines(point(0., 1000.)), cx);
            assert_eq!(view.read(cx).scroll_offset, oldest);
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), -cell.height * 0.25)),
                cx,
            );
            assert_eq!(view.read(cx).scroll_offset, oldest - 0.25);
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn selection_spans_wrapped_lines_scrollback_and_survives_new_output(cx: &mut TestAppContext) {
        let (handle, view, _) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let cols = view
                .read(cx)
                .session
                .as_ref()
                .unwrap()
                .terminal
                .screen()
                .physical_cols;
            let text = "x".repeat(cols + 5);
            view.update(cx, |view, cx| {
                view.session.as_mut().unwrap().terminal.advance_bytes(&text);
                cx.notify();
            });
            window.render_frame(cx);
            let bounds = view.read(cx).bounds;
            let cell = view.read(cx).cell_size;
            let at = |column: f32, row: f32| {
                bounds.origin + point(cell.width * column, cell.height * row)
            };
            window.drag(at(0.5, 0.5), at(4.5, 1.5), cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-c"
                } else {
                    "ctrl-shift-c"
                },
                cx,
            );
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), text);

            view.update(cx, |view, cx| {
                let rows = view
                    .session
                    .as_ref()
                    .unwrap()
                    .terminal
                    .screen()
                    .physical_rows;
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes(format!("\r\n{}", "history\r\n".repeat(rows * 2)));
                cx.notify();
            });
            window.press("shift-pageup", cx);
            assert!(view.read(cx).scroll_offset > 0.);
            window.drag(at(0.5, 1.5), at(6.5, 1.5), cx);
            let before = view
                .read(cx)
                .selection
                .unwrap()
                .text(&view.read(cx).session.as_ref().unwrap().terminal);
            assert_eq!(before, "history");
            let pinned_offset = view.read(cx).scroll_offset;
            view.update(cx, |view, cx| {
                let (sender, output) = mpsc::channel();
                view.session.as_mut().unwrap().output = output;
                sender
                    .send(super::Output::Bytes(b"new output\r\n".to_vec()))
                    .unwrap();
                view.read_output(cx);
            });
            assert_eq!(view.read(cx).scroll_offset, pinned_offset + 1.);
            window.scroll("terminal", ScrollDelta::Lines(point(0., 3.)), cx);
            assert_eq!(
                view.read(cx)
                    .selection
                    .unwrap()
                    .text(&view.read(cx).session.as_ref().unwrap().terminal),
                before
            );
            window.press("shift-end", cx);
            assert_eq!(view.read(cx).scroll_offset, 0.);
            window.press("cmd-=", cx);
            assert!(view.read(cx).font_scale > 1.);
            window.press("cmd-0", cx);
            assert_eq!(view.read(cx).font_scale, 1.);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-k"
                } else {
                    "ctrl-shift-k"
                },
                cx,
            );
            let screen = view.read(cx).session.as_ref().unwrap().terminal.screen();
            assert_eq!(screen.scrollback_rows(), screen.physical_rows);
            assert!(view.read(cx).selection.is_none());
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn tui_mouse_reporting_and_shift_selection_use_the_correct_input_paths(
        cx: &mut TestAppContext,
    ) {
        let (handle, view, bytes) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes(b"mouse\x1b[?1000h\x1b[?1006h");
                cx.notify();
            });
            window.render_frame(cx);
            let bounds = view.read(cx).bounds;
            let cell = view.read(cx).cell_size;
            let at = |col| bounds.origin + point(cell.width * col, cell.height * 0.5);
            window.dispatch_event(
                MouseDownEvent {
                    button: MouseButton::Left,
                    position: at(0.5),
                    click_count: 1,
                    ..Default::default()
                }
                .to_platform_input(),
                cx,
            );
            window.dispatch_event(
                MouseUpEvent {
                    button: MouseButton::Left,
                    position: at(0.5),
                    click_count: 1,
                    ..Default::default()
                }
                .to_platform_input(),
                cx,
            );
            assert_eq!(
                bytes.recv_timeout(Duration::from_secs(1)).unwrap(),
                b"\x1b[<0;1;1M"
            );
            assert_eq!(
                bytes.recv_timeout(Duration::from_secs(1)).unwrap(),
                b"\x1b[<0;1;1m"
            );
            assert!(view.read(cx).selection.is_none());
            let modifiers = Modifiers {
                shift: true,
                ..Default::default()
            };
            window.dispatch_event(
                MouseDownEvent {
                    button: MouseButton::Left,
                    position: at(0.5),
                    click_count: 1,
                    modifiers,
                    ..Default::default()
                }
                .to_platform_input(),
                cx,
            );
            window.dispatch_event(
                MouseMoveEvent {
                    position: at(4.5),
                    pressed_button: Some(MouseButton::Left),
                    modifiers,
                }
                .to_platform_input(),
                cx,
            );
            window.dispatch_event(
                MouseUpEvent {
                    button: MouseButton::Left,
                    position: at(4.5),
                    click_count: 1,
                    modifiers,
                }
                .to_platform_input(),
                cx,
            );
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-c"
                } else {
                    "ctrl-shift-c"
                },
                cx,
            );
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), "mouse");
            assert!(bytes.try_recv().is_err());
            window.scroll("terminal", ScrollDelta::Lines(point(0., 1.)), cx);
            let wheel = bytes.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(wheel.starts_with(b"\x1b[<64;"));
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), cell.height * 0.5)),
                cx,
            );
            assert!(bytes.try_recv().is_err());
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), cell.height * 0.5)),
                cx,
            );
            assert!(
                bytes
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .starts_with(b"\x1b[<64;")
            );
            assert_eq!(view.read(cx).scroll_offset, 0.);

            view.update(cx, |view, cx| {
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes(b"\x1b[?1000l\x1b[?1006l\x1b[?1049h");
                cx.notify();
            });
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), -cell.height * 0.5)),
                cx,
            );
            assert!(bytes.try_recv().is_err());
            window.scroll(
                "terminal",
                ScrollDelta::Pixels(point(px(0.), -cell.height * 0.5)),
                cx,
            );
            assert_eq!(
                bytes.recv_timeout(Duration::from_secs(1)).unwrap(),
                b"\x1b[B"
            );
            assert_eq!(view.read(cx).scroll_offset, 0.);
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn selection_menu_extracts_runs_and_searches_in_local_and_ssh_panes(cx: &mut TestAppContext) {
        for remote in [false, true] {
            for (text, label, extract) in [
                ("file's $HOME; &.tar.gz", "Extract archive", Some(true)),
                ("file's $HOME; &.zst", "Extract archive", Some(true)),
                ("file's $HOME; &.zip", "Extract archive", Some(true)),
                ("file's $HOME; &.sh", "Run", Some(false)),
                ("café & Rust + #?\r\nnext", "Search with Google", None),
            ] {
                let (handle, view, bytes) = open_terminal(cx);
                let (_output, receiver) = mpsc::channel();
                cx.update_window(handle.into(), |_, window, cx| {
                    view.update(cx, |view, cx| {
                        let session = view.session.as_mut().unwrap();
                        session.output = receiver;
                        session.current_directory = Some("/tmp".into());
                        session.terminal.advance_bytes(
                            format!("\x1b]7;file://localhost/tmp\x07\x1b[?2004h{text}").as_bytes(),
                        );
                        if remote {
                            view.source = crate::storage::TabSource::Ssh {
                                profile_id: String::new(),
                                directory: "/stale".into(),
                            };
                        }
                        // Keep background SSH retries from replacing the captured session.
                        view.closed = true;
                        cx.notify();
                    });
                    window.render_frame(cx);
                    window.press(
                        if cfg!(target_os = "macos") {
                            "cmd-a"
                        } else {
                            "ctrl-shift-a"
                        },
                        cx,
                    );
                })
                .unwrap();
                let expected = view.read_with(cx, |view, _| {
                    extract.map(|extract| view.selected_command(extract).unwrap())
                });
                let ix = if remote { 5usize } else { 3usize };
                // Commands remain visible but cannot type into a closed shell.
                if extract.is_some() {
                    cx.update_window(handle.into(), |_, window, cx| {
                        view.update(cx, |view, cx| {
                            view.running = false;
                            cx.notify();
                        });
                        window.right_click("terminal", cx);
                    })
                    .unwrap();
                    cx.run_until_parked();
                    cx.update_window(handle.into(), |_, window, cx| {
                        window.render_frame(cx);
                        assert_eq!(window.within("popup-menu").find(ix).label(), Some(label));
                        window.within("popup-menu").click(ix, cx);
                        assert!(bytes.try_recv().is_err());
                        assert!(view.read(cx).selection.is_some());
                        window.press("escape", cx);
                        view.update(cx, |view, cx| {
                            view.running = true;
                            cx.notify();
                        });
                    })
                    .unwrap();
                    cx.run_until_parked();
                }
                cx.update_window(handle.into(), |_, window, cx| {
                    window.right_click("terminal", cx)
                })
                .unwrap();
                cx.run_until_parked();
                cx.update_window(handle.into(), |_, window, cx| {
                    window.render_frame(cx);
                    assert_eq!(window.within("popup-menu").find(ix).label(), Some(label));
                    window.within("popup-menu").click(ix, cx);
                })
                .unwrap();
                cx.run_until_parked();
                cx.update_window(handle.into(), |_, window, cx| {
                    window.render_frame(cx);
                    assert!(view.read(cx).focus.is_focused(window));
                    assert!(window.try_find("popup-menu").is_none());
                    if let Some(command) = &expected {
                        let sent: Vec<_> = bytes.try_iter().flatten().collect();
                        assert_eq!(
                            sent,
                            format!("\x1b[200~{command}\x1b[201~\r").as_bytes(),
                            "remote={remote}, status={}",
                            view.read(cx).status
                        );
                        assert!(view.read(cx).selection.is_none());
                    } else {
                        assert!(bytes.try_recv().is_err());
                    }
                    view.update(cx, |view, _| view.close());
                })
                .unwrap();
                if extract.is_none() {
                    assert_eq!(
                        cx.opened_url(),
                        crate::selection::google_search_url("café & Rust + #?\nnext")
                    );
                }
            }
        }
    }

    #[gpui_kit::test]
    async fn terminal_context_edit_opens_selected_local_and_remote_files(cx: &mut TestAppContext) {
        use gpui_kit::test::TestAppContextExt;
        let server = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server"]
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file());
        let root = std::env::temp_dir().join(format!("terminal-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let filename = "notes file.txt";
        std::fs::write(root.join(filename), "selected file contents").unwrap();
        for remote in [false, true] {
            if remote && server.is_none() {
                continue;
            }
            let (handle, view, bytes) = open_terminal(cx);
            let (_output, receiver) = mpsc::channel();
            cx.update_window(handle.into(), |_, window, cx| {
                view.update(cx, |view, cx| {
                    let session = view.session.as_mut().unwrap();
                    session.output = receiver;
                    session.current_directory = Some(root.clone());
                    session.terminal.advance_bytes(
                        format!(
                            "\x1b]7;file://localhost/{}\x07'{filename}'",
                            root.to_string_lossy().trim_start_matches('/')
                        )
                        .as_bytes(),
                    );
                    if remote {
                        let profile = crate::storage::SshProfile {
                            name: "Editor test".into(),
                            host: "localhost".into(),
                            ..Default::default()
                        };
                        let store = crate::storage::Store::at(root.join("unused-store"));
                        let browser = cx.new(|cx| {
                            crate::sftp_browser::SftpBrowser::new(
                                profile.clone(),
                                store.clone(),
                                Default::default(),
                                window,
                                cx,
                            )
                        });
                        browser
                            .read(cx)
                            .connection()
                            .run(
                                || Ok(std::process::Command::new(server.unwrap())),
                                true,
                                |_| Ok(()),
                            )
                            .unwrap();
                        view.source = crate::storage::TabSource::Ssh {
                            profile_id: profile.id.clone(),
                            directory: "/stale".into(),
                        };
                        view.ssh_profile = Some(profile);
                        view.store = Some(store);
                        view.browser = Some(browser);
                    }
                    cx.notify();
                });
                window.render_frame(cx);
                window.press(
                    if cfg!(target_os = "macos") {
                        "cmd-a"
                    } else {
                        "ctrl-shift-a"
                    },
                    cx,
                );
                assert_eq!(
                    view.read(cx).selected_file_path().unwrap(),
                    root.join(filename)
                );
                window.right_click("terminal", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                let ix = if remote { 4usize } else { 2usize };
                assert_eq!(window.within("popup-menu").find(ix).label(), Some("Edit"));
                window.within("popup-menu").click(ix, cx);
            })
            .unwrap();
            cx.wait_for(handle.into(), Duration::from_secs(5), |window, cx| {
                window.render_frame(cx);
                window.try_find("file-editor-status").is_some_and(|status| {
                    status.label().is_some_and(|label| label.ends_with("Saved"))
                })
            })
            .await;
            cx.update_window(handle.into(), |_, window, cx| {
                assert_eq!(window.find("file-editor-cancel").label(), Some("Cancel"));
                assert_eq!(window.find("file-editor-save").label(), Some("Save"));
                window.click("file-editor-cancel", cx);
                assert!(!window.has_active_dialog(cx));
                assert!(view.read(cx).focus.is_focused(window));
                assert!(
                    bytes.try_recv().is_err(),
                    "Editing must not type a command into the shell"
                );
            })
            .unwrap();
            cx.update(|cx| view.update(cx, |view, _| view.close()));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[gpui_kit::test]
    fn ssh_download_menu_uses_current_directory_and_reports_authentication_errors(
        cx: &mut TestAppContext,
    ) {
        let (handle, view, bytes) = open_terminal(cx);
        let (_output, receiver) = mpsc::channel();
        let filename = format!("download-test-{}.txt", uuid::Uuid::new_v4());
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                let session = view.session.as_mut().unwrap();
                session.output = receiver;
                session.terminal.advance_bytes(filename.as_bytes());
                view.ssh_profile = Some(crate::storage::SshProfile {
                    name: "Download test".into(),
                    host: "localhost".into(),
                    authentication: crate::storage::Authentication::Password,
                    ..crate::storage::SshProfile::default()
                });
                view.store = Some(crate::storage::Store::at(
                    std::env::temp_dir().join(&filename),
                ));
                cx.notify();
            });
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-a"
                } else {
                    "ctrl-shift-a"
                },
                cx,
            );
        })
        .unwrap();
        let selected = view.read_with(cx, |view, _| view.selection.unwrap());
        // Local selections and unselected SSH terminals keep the ordinary menu.
        // A relative path is disabled until OSC 7 reports the current directory.
        for (remote, selection, directory, downloading) in [
            (false, true, false, false),
            (true, false, false, false),
            (true, true, false, false),
            (true, true, true, true),
            (true, true, true, false),
        ] {
            cx.update_window(handle.into(), |_, window, cx| {
                view.update(cx, |view, cx| {
                    view.source = if remote {
                        crate::storage::TabSource::Ssh {
                            profile_id: String::new(),
                            directory: "/stale/directory".into(),
                        }
                    } else {
                        crate::storage::TabSource::default()
                    };
                    view.selection = selection.then_some(selected);
                    view.downloading = downloading;
                    if directory {
                        view.session
                            .as_mut()
                            .unwrap()
                            .terminal
                            .advance_bytes(b"\x1b]7;file://localhost/srv/current\x07");
                        assert_eq!(
                            view.selected_download_path().unwrap(),
                            format!("/srv/current/{filename}")
                        );
                    }
                    cx.notify();
                });
                window.right_click("terminal", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                let item = window.within("popup-menu").find(3usize);
                if remote && selection {
                    assert_eq!(item.label(), Some("Download"));
                    assert_eq!(
                        window.within("popup-menu").find(4usize).label(),
                        Some("Edit")
                    );
                    if !directory {
                        let status = view.read(cx).status.clone();
                        window.within("popup-menu").click(4usize, cx);
                        assert!(!window.has_active_dialog(cx));
                        assert_eq!(view.read(cx).status, status);
                    }
                    if directory && !downloading {
                        window.within("popup-menu").click(3usize, cx);
                        return;
                    }
                    let status = view.read(cx).status.clone();
                    window.within("popup-menu").click(3usize, cx);
                    assert_eq!(view.read(cx).status, status);
                    assert_eq!(view.read(cx).downloading, downloading);
                } else if selection {
                    assert_eq!(
                        window.within("popup-menu").find(2usize).label(),
                        Some("Edit")
                    );
                } else {
                    assert_eq!(item.label(), Some("Select all"));
                }
                window.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx);
            })
            .unwrap();
            cx.run_until_parked();
        }
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(
                view.read(cx).status.contains("Enter a password"),
                "{}",
                view.read(cx).status
            );
            assert!(!view.read(cx).downloading);
            assert!(view.read(cx).focus.is_focused(window));
            assert!(window.try_find("popup-menu").is_none());
            assert!(
                bytes.try_recv().is_err(),
                "downloading must not type into the shell"
            );
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn context_menu_copies_selection_and_restores_terminal_focus(cx: &mut TestAppContext) {
        let (handle, view, _) = open_terminal(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |view, cx| {
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes(b"menu text");
                cx.notify();
            });
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-a"
                } else {
                    "ctrl-shift-a"
                },
                cx,
            );
            window.right_click("terminal", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("popup-menu").is_some());
            window.press("down", cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                "menu text"
            );
            assert!(view.read(cx).focus.is_focused(window));
            window.right_click("terminal", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            // Let deferred dismissal close the menu before rendering the next frame.
            window.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("popup-menu").is_none());
            assert!(
                view.read(cx).focus.is_focused(window),
                "terminal {:?}, focused {:?}",
                view.read(cx).focus,
                window.focused(cx)
            );
        })
        .unwrap();
    }
}
