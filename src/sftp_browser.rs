use crate::{
    sftp::{self, Client, Connection, Entry, TransferProgress, file_size},
    ssh,
    storage::{BrowserSnapshot, SshProfile, Store},
};
use anyhow::Result;
use gpui_kit::{
    assets::IconName,
    component::{
        ActiveTheme, Disableable, Icon, IndexPath, Sizable, WindowExt,
        button::{Button, ButtonVariant, ButtonVariants},
        dialog::{DialogAction, DialogFooter},
        input::{Input, InputEvent, InputState},
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
        menu::{ContextMenuExt, DropdownMenu, PopupMenuItem},
        resizable::ResizableState,
        spinner::Spinner,
    },
    prelude::FluentBuilder,
    *,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

struct Files {
    owner: WeakEntity<SftpBrowser>,
    directory: String,
    entries: Vec<Entry>,
    visible: Vec<usize>,
    selected: Option<String>,
    query: String,
    loading: bool,
}
impl Files {
    fn filter(&mut self) {
        let query = self.query.to_lowercase();
        self.visible = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.name.to_lowercase().contains(&query))
            .map(|(ix, _)| ix)
            .collect();
    }
    fn entry(&self, ix: IndexPath) -> Option<&Entry> {
        self.visible
            .get(ix.row)
            .and_then(|ix| self.entries.get(*ix))
    }
    fn selected(&self) -> Option<&Entry> {
        self.selected
            .as_ref()
            .and_then(|name| self.entries.iter().find(|entry| &entry.name == name))
    }
}
impl ListDelegate for Files {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.visible.len()
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix
            .and_then(|ix| self.entry(ix))
            .map(|entry| entry.name.clone());
    }
    fn perform_search(
        &mut self,
        query: &str,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Task<()> {
        self.query = query.to_owned();
        self.filter();
        cx.defer_in(window, |list, window, cx| {
            list.set_selected_index(None, window, cx);
            cx.notify();
        });
        Task::ready(())
    }
    fn loading(&self, _: &App) -> bool {
        self.loading
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .p_4()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child(if self.query.is_empty() {
                "This folder is empty"
            } else {
                "No matching files"
            })
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let entry = self.entry(ix)?;
        let details = format!(
            "{} · {} · {}",
            entry.permission_text(),
            if entry.is_directory() {
                "Folder".into()
            } else {
                file_size(entry.size)
            },
            modified_time(entry.modified)
        );
        let owner = self.owner.clone();
        let name = entry.name.clone();
        let directory = self.directory.clone();
        let open_label = if entry.is_directory() || entry.is_symlink() {
            "Open"
        } else {
            "Edit"
        };
        Some(
            ListItem::new(SharedString::from(format!("sftp-entry-{}", entry.name)))
                .accessibility_label(format!("{}, {details}", entry.name))
                .on_click(cx.listener(move |list, event: &ClickEvent, window, cx| {
                    cx.stop_propagation();
                    list.set_selected_index(Some(ix), window, cx);
                    cx.emit(ListEvent::Select(ix));
                    if event.click_count() == 2 {
                        cx.emit(ListEvent::Confirm(ix));
                    }
                    list.focus(window, cx);
                    cx.notify();
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .w_full()
                        .child(Icon::new(file_icon(entry)).size_4().flex_shrink_0())
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .py_1()
                                .child(div().truncate().text_sm().child(entry.name.clone()))
                                .child(
                                    div()
                                        .truncate()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(details),
                                ),
                        )
                        .context_menu(move |menu, _, _| {
                            let item = |label: &'static str,
                                        action: fn(
                                &mut SftpBrowser,
                                &mut Window,
                                &mut Context<SftpBrowser>,
                            )| {
                                let owner = owner.clone();
                                let name = name.clone();
                                let directory = directory.clone();
                                PopupMenuItem::new(label).on_click(move |_, window, cx| {
                                    let _ = owner.update(cx, |browser, cx| {
                                        if browser.busy || browser.directory != directory {
                                            return;
                                        }
                                        let ix = browser
                                            .list
                                            .read(cx)
                                            .delegate()
                                            .visible
                                            .iter()
                                            .position(|ix| {
                                                browser.list.read(cx).delegate().entries[*ix].name
                                                    == name
                                            });
                                        if let Some(ix) = ix {
                                            browser.list.update(cx, |list, cx| {
                                                list.set_selected_index(
                                                    Some(IndexPath::new(ix)),
                                                    window,
                                                    cx,
                                                )
                                            });
                                            action(browser, window, cx);
                                        }
                                    });
                                })
                            };
                            menu.item(item(open_label, SftpBrowser::open_selected))
                                .item(item("Download…", SftpBrowser::download_picker))
                                .item(item("Rename…", |browser, window, cx| {
                                    browser.name_dialog(true, false, window, cx)
                                }))
                                .separator()
                                .item(item("Delete…", SftpBrowser::delete_dialog))
                        }),
                ),
        )
    }
}
fn file_icon(entry: &Entry) -> IconName {
    if entry.is_directory() {
        return IconName::Folder;
    }
    if entry.is_symlink() {
        return IconName::Link;
    }
    match Path::new(&entry.name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "zip" | "gz" | "tar" | "xz" | "bz2" | "7z" | "rar" => IconName::Archive,
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" => IconName::Image,
        "mp3" | "wav" | "ogg" | "flac" => IconName::Music,
        "mp4" | "mov" | "webm" | "mkv" => IconName::Video,
        "rs" | "js" | "ts" | "py" | "sh" | "go" | "html" | "css" | "json" | "toml" | "yaml" => {
            IconName::Code
        }
        _ => IconName::File,
    }
}
fn modified_time(seconds: u32) -> String {
    if seconds == 0 {
        return "Modified time unavailable".into();
    }
    // Gregorian civil date from Unix days; SFTP v3 timestamps are UTC seconds.
    let days = i64::from(seconds / 86400) + 719468;
    let era = days / 146097;
    let day = days - era * 146097;
    let year = (day - day / 1460 + day / 36524 - day / 146096) / 365;
    let ordinal = day - (365 * year + year / 4 - year / 100);
    let month = (5 * ordinal + 2) / 153;
    let date = ordinal - (153 * month + 2) / 5 + 1;
    let month = month + if month < 10 { 3 } else { -9 };
    let year = year + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{date:02} {:02}:{:02} UTC",
        seconds / 3600 % 24,
        seconds / 60 % 60
    )
}

#[derive(Clone)]
enum Operation {
    Create { name: String, directory: bool },
    Rename { name: String, destination: String },
    Delete { name: String },
    Upload(Vec<PathBuf>),
    Download { name: String, destination: PathBuf },
}
impl Operation {
    fn label(&self) -> &'static str {
        match self {
            Self::Create { .. } => "Creating…",
            Self::Rename { .. } => "Renaming…",
            Self::Delete { .. } => "Deleting…",
            Self::Upload(_) => "Uploading…",
            Self::Download { .. } => "Downloading…",
        }
    }
}

pub(crate) struct SftpBrowser {
    focus: FocusHandle,
    profile: SshProfile,
    store: Store,
    connection: Arc<Connection>,
    saved: BrowserSnapshot,
    open: bool,
    directory: String,
    path: Entity<InputState>,
    list: Entity<ListState<Files>>,
    pub(crate) resize: Entity<ResizableState>,
    busy: bool,
    transfer_percent: Option<u8>,
    status: String,
    error: Option<String>,
    completion: Option<String>,
    revision: u64,
    _subscriptions: Vec<Subscription>,
}
impl SftpBrowser {
    pub(crate) fn new(
        profile: SshProfile,
        store: Store,
        saved: BrowserSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let path = cx.new(|cx| InputState::new(window, cx).placeholder("Remote folder"));
        let owner = cx.entity().downgrade();
        let list = cx.new(|cx| {
            ListState::new(
                Files {
                    owner,
                    directory: String::new(),
                    entries: vec![],
                    visible: vec![],
                    selected: None,
                    query: String::new(),
                    loading: false,
                },
                window,
                cx,
            )
            .searchable(true)
        });
        let subscriptions = vec![
            cx.subscribe_in(&path, window, |browser, input, event, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    browser.navigate(input.read(cx).value().to_string(), window, cx);
                }
            }),
            cx.subscribe_in(&list, window, |browser, list, event, window, cx| {
                if let ListEvent::Confirm(ix) = event
                    && let Some(entry) = list.read(cx).delegate().entry(*ix).cloned()
                {
                    browser.open_entry(&entry, window, cx);
                }
                cx.notify();
            }),
            cx.observe(&list, |_, _, cx| cx.notify()),
        ];
        Self {
            focus: cx.focus_handle(),
            profile,
            store,
            connection: Arc::new(Connection::default()),
            saved,
            open: false,
            directory: String::new(),
            path,
            list,
            resize: cx.new(|_| ResizableState::default()),
            busy: false,
            transfer_percent: None,
            status: String::new(),
            error: None,
            completion: None,
            revision: 0,
            _subscriptions: subscriptions,
        }
    }
    pub(crate) fn is_open(&self) -> bool {
        self.open
    }
    pub(crate) fn has_focus(&self, window: &Window, cx: &App) -> bool {
        self.focus.contains_focused(window, cx)
    }
    pub(crate) fn snapshot(&self) -> BrowserSnapshot {
        self.saved.clone()
    }
    fn open_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(entry) = self.list.read(cx).delegate().selected().cloned() {
            self.open_entry(&entry, window, cx);
        }
    }
    fn open_entry(&mut self, entry: &Entry, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Ok(path) = sftp::child_path(&self.directory, &entry.name) else {
            return;
        };
        if entry.is_directory() || entry.is_symlink() {
            self.navigate(path, window, cx);
        } else {
            self.list.update(cx, |list, cx| list.focus(window, cx));
            crate::editor::open(
                crate::editor::Target::Remote {
                    path,
                    profile: Arc::new(self.profile.clone()),
                    store: self.store.clone(),
                    connection: self.connection.clone(),
                },
                window,
                cx,
            );
        }
    }
    pub(crate) fn connection(&self) -> Arc<Connection> {
        self.connection.clone()
    }
    pub(crate) fn configure(&mut self, profile: SshProfile, cx: &mut Context<Self>) {
        if self.profile != profile {
            self.close(cx);
            if self.profile.host != profile.host
                || self.profile.port != profile.port
                || self.profile.username != profile.username
            {
                self.directory.clear();
            }
            self.list.update(cx, |list, cx| {
                let files = list.delegate_mut();
                files.loading = false;
                files.entries.clear();
                files.visible.clear();
                files.selected = None;
                cx.notify();
            });
        }
        self.profile = profile;
        cx.notify();
    }
    fn close(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        self.connection.close();
        self.connection = Arc::new(Connection::default());
        self.revision += 1;
        self.busy = false;
        self.transfer_percent = None;
        self.list.update(cx, |list, cx| {
            list.delegate_mut().loading = false;
            cx.notify();
        });
        cx.notify();
    }
    pub(crate) fn cancel_transfer(&mut self, cx: &mut Context<Self>) {
        let open = self.open;
        self.close(cx);
        self.open = open;
        self.status = "Transfer cancelled".into();
        self.completion = None;
        self.error = None;
        cx.notify();
    }
    pub(crate) fn toggle(
        &mut self,
        current_directory: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.open {
            self.close(cx);
        } else {
            self.open = true;
            self.list.update(cx, |list, cx| list.focus(window, cx));
            if !self.busy {
                let directory = current_directory
                    .filter(|path| !path.is_empty())
                    .unwrap_or_else(|| {
                        if self.profile.remote_directory.is_empty() {
                            ".".into()
                        } else {
                            self.profile.remote_directory.clone()
                        }
                    });
                self.navigate(directory, window, cx);
            }
        }
        cx.notify();
    }
    pub(crate) fn record_width(&mut self, width: Pixels, window: &Window, cx: &mut Context<Self>) {
        self.saved.width = (f32::from(width) / f32::from(window.rem_size())).clamp(15., 40.);
        cx.notify();
    }
    fn navigate(&mut self, directory: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.revision += 1;
        let revision = self.revision;
        self.busy = true;
        self.transfer_percent = None;
        self.error = None;
        self.status = "Loading folder…".into();
        self.list.update(cx, |list, cx| {
            list.delegate_mut().loading = true;
            cx.notify();
        });
        let profile = self.profile.clone();
        let store = self.store.clone();
        let connection = self.connection.clone();
        let work = cx.background_spawn(async move {
            connection.run(
                || ssh::sftp_command(&profile, &store),
                true,
                |client| {
                    client.list(if directory.is_empty() {
                        "."
                    } else {
                        &directory
                    })
                },
            )
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = work.await;
            let _ = this.update_in(cx, |browser, window, cx| {
                if browser.revision != revision {
                    return;
                }
                browser.finish_listing(result, window, cx);
            });
        })
        .detach();
        cx.notify();
    }
    fn finish_listing(
        &mut self,
        result: Result<(String, Vec<Entry>)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.busy = false;
        self.list.update(cx, |list, cx| {
            list.delegate_mut().loading = false;
            cx.notify();
        });
        match result {
            Ok((directory, entries)) => {
                let changed_directory = self.directory != directory;
                self.directory = directory.clone();
                self.status = format!("{} items", entries.len());
                self.path
                    .update(cx, |path, cx| path.set_value(directory, window, cx));
                self.list.update(cx, |list, cx| {
                    let selected = if changed_directory {
                        None
                    } else {
                        list.delegate().selected.clone()
                    };
                    list.delegate_mut().entries = entries;
                    list.delegate_mut().directory = self.directory.clone();
                    if changed_directory {
                        list.set_query("", window, cx);
                    }
                    list.delegate_mut().filter();
                    let selected = selected
                        .and_then(|name| {
                            list.delegate()
                                .visible
                                .iter()
                                .position(|ix| list.delegate().entries[*ix].name == name)
                        })
                        .map(IndexPath::new);
                    list.set_selected_index(selected, window, cx);
                    cx.notify();
                });
            }
            Err(error) => {
                if !self.directory.is_empty() {
                    self.path.update(cx, |path, cx| {
                        path.set_value(self.directory.clone(), window, cx)
                    });
                }
                self.error = Some(format!("{error:#}"));
                self.status = "Couldn’t load folder".into();
            }
        }
        cx.notify();
    }
    fn run(&mut self, operation: Operation, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open || self.busy || self.directory.is_empty() {
            return;
        }
        self.busy = true;
        self.error = None;
        self.completion = None;
        self.status = operation.label().into();
        self.transfer_percent =
            matches!(operation, Operation::Upload(_) | Operation::Download { .. }).then_some(0);
        self.revision += 1;
        let revision = self.revision;
        let directory = self.directory.clone();
        let profile = self.profile.clone();
        let store = self.store.clone();
        let connection = self.connection.clone();
        let progress = Arc::new(TransferProgress::new(match operation {
            Operation::Download { .. } => "Downloading",
            _ => "Uploading",
        }));
        let reported = progress.clone();
        let work = cx.background_spawn(async move {
            connection.run(
                || ssh::sftp_command(&profile, &store),
                matches!(operation, Operation::Download { .. }),
                |client| {
                    execute(
                        client,
                        &directory,
                        &operation,
                        &mut |path, transferred, total| reported.update(path, transferred, total),
                    )
                },
            )
        });
        let progress_task = cx.spawn(async move |this, cx| {
            loop {
                if this
                    .update(cx, |browser, cx| {
                        if browser.revision != revision {
                            return false;
                        }
                        if let Some((status, percent)) = progress.take_status() {
                            browser.status = status;
                            browser.transfer_percent = Some(percent);
                            cx.notify();
                        }
                        true
                    })
                    .ok()
                    != Some(true)
                {
                    return;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = work.await;
            drop(progress_task);
            let _ = this.update_in(cx, |browser, window, cx| {
                if browser.revision != revision {
                    return;
                }
                browser.busy = false;
                browser.transfer_percent = None;
                match result {
                    Ok(message) => {
                        browser.completion = Some(message);
                        browser.navigate(browser.directory.clone(), window, cx);
                    }
                    Err(error) => {
                        browser.status = "Operation failed".into();
                        browser.error = Some(format!("{error:#}"));
                        cx.notify();
                    }
                }
            });
        })
        .detach();
        cx.notify();
    }
    fn upload_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.directory.is_empty() {
            return;
        }
        let picker = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: true,
            prompt: Some("Upload".into()),
        });
        let directory = self.directory.clone();
        let revision = self.revision;
        cx.spawn_in(window, async move |this, cx| {
            let result = picker.await;
            let _ = this.update_in(cx, |browser, window, cx| match result {
                Ok(Ok(Some(paths)))
                    if browser.revision == revision && browser.directory == directory =>
                {
                    browser.run(Operation::Upload(paths), window, cx)
                }
                Ok(Err(error)) if browser.revision == revision => {
                    browser.error = Some(format!("Couldn’t choose files: {error}"));
                    cx.notify();
                }
                _ => {}
            });
        })
        .detach();
    }
    fn download_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(entry) = self.list.read(cx).delegate().selected().cloned() else {
            return;
        };
        let directory = self.directory.clone();
        let revision = self.revision;
        let start = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        if entry.is_directory() {
            let picker = cx.prompt_for_paths(PathPromptOptions {
                files: false,
                directories: true,
                multiple: false,
                prompt: Some("Download into folder".into()),
            });
            cx.spawn_in(window, async move |this, cx| {
                let result = picker.await;
                let _ = this.update_in(cx, |browser, window, cx| match result {
                    Ok(Ok(Some(paths)))
                        if browser.revision == revision && browser.directory == directory =>
                    {
                        if let Some(parent) = paths.first() {
                            browser.run(
                                Operation::Download {
                                    destination: parent.join(&entry.name),
                                    name: entry.name,
                                },
                                window,
                                cx,
                            );
                        }
                    }
                    Ok(Err(error)) if browser.revision == revision => {
                        browser.error = Some(format!("Couldn’t choose a folder: {error}"));
                        cx.notify();
                    }
                    _ => {}
                });
            })
            .detach();
        } else {
            let picker = cx.prompt_for_new_path(&start, Some(&entry.name));
            cx.spawn_in(window, async move |this, cx| {
                let result = picker.await;
                let _ = this.update_in(cx, |browser, window, cx| match result {
                    Ok(Ok(Some(destination)))
                        if browser.revision == revision && browser.directory == directory =>
                    {
                        browser.run(
                            Operation::Download {
                                name: entry.name,
                                destination,
                            },
                            window,
                            cx,
                        )
                    }
                    Ok(Err(error)) if browser.revision == revision => {
                        browser.error = Some(format!("Couldn’t choose a destination: {error}"));
                        cx.notify();
                    }
                    _ => {}
                });
            })
            .detach();
        }
    }
    fn name_dialog(
        &mut self,
        rename: bool,
        directory: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy || self.directory.is_empty() {
            return;
        }
        let old_name = if rename {
            self.list
                .read(cx)
                .delegate()
                .selected()
                .map(|entry| entry.name.clone())
        } else {
            None
        };
        if rename && old_name.is_none() {
            return;
        }
        let owner = cx.entity().downgrade();
        let parent = self.directory.clone();
        let revision = self.revision;
        let form = cx.new(|cx| NameForm {
            name: cx.new(|cx| {
                let mut input = InputState::new(window, cx).placeholder("Name");
                input.set_value(old_name.clone().unwrap_or_default(), window, cx);
                input
            }),
            owner,
            parent,
            revision,
            old_name,
            directory,
            error: None,
        });
        window.open_dialog(cx, move |dialog, window, _| {
            let confirm = form.clone();
            dialog
                .title(if rename {
                    "Rename entry"
                } else if directory {
                    "New folder"
                } else {
                    "New file"
                })
                .width(window.rem_size() * 26.)
                .child(form.clone())
                .footer(
                    DialogFooter::new()
                        .child(
                            Button::new("sftp-name-cancel")
                                .label("Cancel")
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        )
                        .child(DialogAction::new().child(
                            Button::new("sftp-name-save").primary().label(if rename {
                                "Rename"
                            } else {
                                "Create"
                            }),
                        )),
                )
                .on_ok(move |_, window, cx| confirm.update(cx, |form, cx| form.submit(window, cx)))
        });
    }
    fn delete_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(entry) = self.list.read(cx).delegate().selected().cloned() else {
            return;
        };
        let owner = cx.entity().downgrade();
        let directory = self.directory.clone();
        let revision = self.revision;
        window.open_alert_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone(); let directory = directory.clone(); let name = entry.name.clone();
            dialog.title(format!("Delete “{}”?", entry.name))
                .description(if entry.is_directory() { "This permanently deletes the remote folder and everything inside it. Symbolic links are removed without deleting their targets." } else { "This permanently deletes the remote entry." })
                .confirm().ok_text("Delete").ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let _ = owner.update(cx, |browser, cx| { if browser.revision == revision && browser.directory == directory { browser.run(Operation::Delete { name: name.clone() }, window, cx); } }); true
                })
        });
    }
}
fn execute(
    client: &mut Client,
    directory: &str,
    operation: &Operation,
    progress: &mut dyn FnMut(&str, u64, u64),
) -> Result<String> {
    match operation {
        Operation::Create {
            name,
            directory: is_directory,
        } => client.create(&sftp::child_path(directory, name)?, *is_directory)?,
        Operation::Rename { name, destination } => client.rename(
            &sftp::child_path(directory, name)?,
            &sftp::child_path(directory, destination)?,
        )?,
        Operation::Delete { name } => client.delete(&sftp::child_path(directory, name)?, 0)?,
        Operation::Download { name, destination } => {
            client.download_to(&sftp::child_path(directory, name)?, destination, progress)?;
            return Ok(format!("Downloaded to {}", destination.display()));
        }
        Operation::Upload(paths) => {
            client.upload(directory, paths, progress)?;
            return Ok("Upload complete".into());
        }
    }
    Ok("Done".into())
}
impl Drop for SftpBrowser {
    fn drop(&mut self) {
        self.connection.close();
    }
}
struct NameForm {
    name: Entity<InputState>,
    owner: WeakEntity<SftpBrowser>,
    parent: String,
    revision: u64,
    old_name: Option<String>,
    directory: bool,
    error: Option<String>,
}
impl NameForm {
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let name = self.name.read(cx).value().to_string();
        if let Err(error) = sftp::child_path(&self.parent, &name) {
            self.error = Some(error.to_string());
            cx.notify();
            return false;
        }
        let operation = if let Some(old_name) = &self.old_name {
            Operation::Rename {
                name: old_name.clone(),
                destination: name,
            }
        } else {
            Operation::Create {
                name,
                directory: self.directory,
            }
        };
        self.owner
            .update(cx, |browser, cx| {
                if !browser.open
                    || browser.busy
                    || browser.revision != self.revision
                    || browser.directory != self.parent
                {
                    return false;
                }
                browser.run(operation, window, cx);
                true
            })
            .unwrap_or(false)
    }
}
impl Render for NameForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_sm().child("Name"))
            .child(Input::new(&self.name).id("sftp-name"))
            .when_some(self.error.clone(), |form, error| {
                form.child(div().text_sm().text_color(cx.theme().danger).child(error))
            })
    }
}
impl Render for SftpBrowser {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.list.read(cx).delegate().selected().cloned();
        let busy = self.busy;
        let ready = !busy && !self.directory.is_empty();
        div()
            .id("sftp-browser")
            .test_support()
            .track_focus(&self.focus)
            .occlude()
            .role(Role::Group)
            .aria_label("SFTP browser")
            .flex()
            .flex_col()
            .size_full()
            .min_w_0()
            .min_h_0()
            .bg(cx.theme().sidebar)
            .text_color(cx.theme().foreground)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .p_3()
                    .child(crate::ssh_icons::image(&self.profile.icon).size_5())
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(self.profile.name.clone()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .truncate()
                                    .child(format!(
                                        "{}@{}:{}",
                                        self.profile.username, self.profile.host, self.profile.port
                                    )),
                            ),
                    )
                    .child(
                        Button::new("sftp-close")
                            .ghost()
                            .small()
                            .icon(IconName::Close)
                            .accessibility_label("Close SFTP browser")
                            .tooltip("Close SFTP browser")
                            .on_click(cx.listener(|browser, _, _, cx| {
                                browser.close(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_3()
                    .pb_2()
                    .child(
                        Button::new("sftp-parent")
                            .ghost()
                            .small()
                            .icon(IconName::ArrowUp)
                            .accessibility_label("Parent folder")
                            .tooltip("Parent folder")
                            .disabled(!ready || self.directory == "/")
                            .on_click(cx.listener(|browser, _, window, cx| {
                                let parent = browser
                                    .directory
                                    .rsplit_once('/')
                                    .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
                                    .unwrap_or("/")
                                    .to_owned();
                                browser.navigate(parent, window, cx);
                            })),
                    )
                    .child(
                        Input::new(&self.path)
                            .id("sftp-path")
                            .aria_label("Remote folder")
                            .small()
                            .flex_1()
                            .min_w_0()
                            .disabled(busy),
                    )
                    .child(
                        Button::new("sftp-refresh")
                            .ghost()
                            .small()
                            .icon(IconName::RefreshCw)
                            .accessibility_label("Refresh folder")
                            .tooltip("Refresh folder")
                            .disabled(busy)
                            .on_click(cx.listener(|browser, _, window, cx| {
                                browser.navigate(
                                    browser.path.read(cx).value().to_string(),
                                    window,
                                    cx,
                                )
                            })),
                    )
                    .child(
                        Button::new("sftp-upload")
                            .ghost()
                            .small()
                            .icon(IconName::Upload)
                            .accessibility_label("Upload files…")
                            .tooltip("Upload files…")
                            .disabled(!ready)
                            .on_click(cx.listener(|browser, _, window, cx| {
                                browser.upload_picker(window, cx)
                            })),
                    )
                    .child(
                        Button::new("sftp-actions")
                            .ghost()
                            .small()
                            .icon(IconName::Ellipsis)
                            .accessibility_label("Actions")
                            .tooltip("Actions")
                            .dropdown_menu({
                                let owner = cx.entity().downgrade();
                                move |menu, _, _| {
                                    let item = |label: &'static str,
                                                disabled: bool,
                                                action: fn(
                                        &mut SftpBrowser,
                                        &mut Window,
                                        &mut Context<SftpBrowser>,
                                    )| {
                                        let owner = owner.clone();
                                        PopupMenuItem::new(label).disabled(disabled).on_click(
                                            move |_, window, cx| {
                                                let _ = owner.update(cx, |browser, cx| {
                                                    action(browser, window, cx)
                                                });
                                            },
                                        )
                                    };
                                    menu.item(item(
                                        if selected.as_ref().is_some_and(|entry| {
                                            !entry.is_directory() && !entry.is_symlink()
                                        }) {
                                            "Edit"
                                        } else {
                                            "Open"
                                        },
                                        !ready || selected.is_none(),
                                        SftpBrowser::open_selected,
                                    ))
                                    .item(item(
                                        "Download…",
                                        !ready || selected.is_none(),
                                        SftpBrowser::download_picker,
                                    ))
                                    .separator()
                                    .item(item("New file…", !ready, |browser, window, cx| {
                                        browser.name_dialog(false, false, window, cx)
                                    }))
                                    .item(item("New folder…", !ready, |browser, window, cx| {
                                        browser.name_dialog(false, true, window, cx)
                                    }))
                                    .item(item(
                                        "Rename…",
                                        !ready || selected.is_none(),
                                        |browser, window, cx| {
                                            browser.name_dialog(true, false, window, cx)
                                        },
                                    ))
                                    .separator()
                                    .item(item(
                                        "Delete…",
                                        !ready || selected.is_none(),
                                        SftpBrowser::delete_dialog,
                                    ))
                                }
                            }),
                    ),
            )
            .when_some(self.error.clone(), |panel, error| {
                panel.child(
                    div()
                        .id("sftp-error")
                        .test_support()
                        .role(Role::Status)
                        .aria_label(error.clone())
                        .px_3()
                        .pb_2()
                        .text_sm()
                        .text_color(cx.theme().danger)
                        .child(error),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .on_drop(cx.listener(|browser, paths: &ExternalPaths, window, cx| {
                        browser.run(Operation::Upload(paths.paths().to_vec()), window, cx);
                    }))
                    .child(
                        List::new(&self.list)
                            .small()
                            .search_placeholder("Filter files…")
                            .h_full(),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_3()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .when(busy && self.transfer_percent.is_none(), |status| {
                                status.child(Spinner::new().small())
                            })
                            .child(
                                div()
                                    .id("sftp-status")
                                    .flex_1()
                                    .min_w_0()
                                    .test_support()
                                    .role(Role::Status)
                                    .aria_label(
                                        self.completion
                                            .clone()
                                            .filter(|_| !busy)
                                            .unwrap_or_else(|| self.status.clone()),
                                    )
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(
                                        self.completion
                                            .clone()
                                            .filter(|_| !busy)
                                            .unwrap_or_else(|| self.status.clone()),
                                    ),
                            ),
                    )
                    .when_some(self.transfer_percent, |footer, percent| {
                        footer.child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(crate::transfer_indicator("sftp-transfer-progress", percent))
                                .child(
                                    Button::new("sftp-transfer-cancel")
                                        .xsmall()
                                        .ghost()
                                        .icon(IconName::Close)
                                        .accessibility_label("Cancel transfer")
                                        .tooltip("Cancel transfer")
                                        .on_click(cx.listener(|browser, _, _, cx| {
                                            browser.cancel_transfer(cx)
                                        })),
                                ),
                        )
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{SftpBrowser, file_size, modified_time};
    use crate::{
        sftp::Entry,
        storage::{BrowserSnapshot, SshProfile, Store},
    };
    use gpui_kit::{
        AppContext, Entity, TestAppContext, WindowHandle, component::Root, px, size,
        test::TestWindowExt,
    };

    fn open(cx: &mut TestAppContext) -> (WindowHandle<Root>, Entity<SftpBrowser>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_reduce_motion(true);
        });
        let mut browser = None;
        let handle = cx.open_window(size(px(400.), px(650.)), |window, cx| {
            let view = cx.new(|cx| {
                let mut browser = SftpBrowser::new(
                    SshProfile {
                        name: "Test server".into(),
                        host: "localhost".into(),
                        ..SshProfile::default()
                    },
                    Store::at(std::env::temp_dir().join("sftp-ui-unused")),
                    BrowserSnapshot::default(),
                    window,
                    cx,
                );
                browser.open = true;
                browser.finish_listing(
                    Ok((
                        "/srv".into(),
                        vec![
                            Entry {
                                name: "documents".into(),
                                size: 0,
                                permissions: 0o040755,
                                modified: 1704067200,
                            },
                            Entry {
                                name: "notes.txt".into(),
                                size: 42,
                                permissions: 0o100644,
                                modified: 1704067200,
                            },
                        ],
                    )),
                    window,
                    cx,
                );
                browser
            });
            browser = Some(view.clone());
            Root::new(view, window, cx)
        });
        (handle, browser.unwrap())
    }
    fn settle(cx: &mut TestAppContext) {
        cx.run_until_parked();
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(300));
        cx.run_until_parked();
    }
    #[gpui_kit::test]
    fn visual_percentage_and_cancel_keep_the_browser_open(cx: &mut TestAppContext) {
        let (handle, browser) = open(cx);
        settle(cx);
        let connection = browser.read_with(cx, |browser, _| browser.connection());
        cx.update_window(handle.into(), |_, window, cx| {
            browser.update(cx, |browser, cx| {
                browser.busy = true;
                browser.transfer_percent = Some(50);
                browser.status = "Uploading file (1.5 KiB / 3.0 KiB)".into();
                cx.notify();
            });
            window.render_frame(cx);
            let progress = window.find("sftp-transfer-progress");
            let cancel = window.find("sftp-transfer-cancel");
            assert!(progress.visible());
            assert!(progress.bounds().size.width > px(50.));
            assert_eq!(
                window.find("sftp-transfer-progress-percentage").label(),
                Some("50%")
            );
            assert_eq!(cancel.label(), Some("Cancel transfer"));
            assert!(cancel.bounds().left() >= progress.bounds().right());
            assert!(cancel.bounds().right() <= window.find("sftp-browser").bounds().right());
            window.click("sftp-transfer-cancel", cx);
            assert!(window.find("sftp-browser").visible());
            assert!(window.try_find("sftp-transfer-progress").is_none());
            assert_eq!(
                window.find("sftp-status").label(),
                Some("Transfer cancelled")
            );
            assert!(!browser.read(cx).busy);
            assert!(!std::sync::Arc::ptr_eq(
                &connection,
                &browser.read(cx).connection()
            ));
        })
        .unwrap();
        assert!(
            connection
                .run(
                    || panic!("Cancelled transfers must not reconnect"),
                    false,
                    |_| Ok(())
                )
                .is_err()
        );
        let fresh = browser.read_with(cx, |browser, _| browser.connection());
        assert_eq!(
            fresh
                .run(
                    || Err(anyhow::anyhow!("ready to reconnect")),
                    false,
                    |_| Ok(())
                )
                .unwrap_err()
                .to_string(),
            "ready to reconnect"
        );
    }
    #[gpui_kit::test]
    async fn reopening_uses_the_terminal_directory(cx: &mut TestAppContext) {
        use gpui_kit::test::TestAppContextExt;
        use std::{path::Path, process::Command, time::Duration};

        let Some(server) = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
        else {
            eprintln!("No local OpenSSH sftp-server installed; skipping browser integration test");
            return;
        };
        let root = std::env::temp_dir().join(format!("sftp-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("terminal folder 'one'")).unwrap();
        std::fs::create_dir(root.join("terminal folder two")).unwrap();
        let root = root.canonicalize().unwrap();
        let (handle, browser) = open(cx);
        settle(cx);
        for folder in ["terminal folder 'one'", "terminal folder two"] {
            let directory = root.join(folder).to_str().unwrap().to_string();
            cx.update_window(handle.into(), |_, window, cx| {
                browser.update(cx, |browser, cx| browser.close(cx));
                browser
                    .read(cx)
                    .connection()
                    .run(|| Ok(Command::new(server)), true, |_| Ok(()))
                    .unwrap();
                browser.update(cx, |browser, cx| {
                    browser.toggle(Some(directory.clone()), window, cx)
                });
            })
            .unwrap();
            cx.wait_for(handle.into(), Duration::from_secs(5), |_, cx| {
                !browser.read(cx).busy
            })
            .await;
            cx.update_window(handle.into(), |_, window, cx| {
                assert!(browser.read(cx).error.is_none());
                assert_eq!(browser.read(cx).directory, directory);
                window.render_frame(cx);
                assert_eq!(window.find("sftp-path").value(), Some(directory.as_str()));
            })
            .unwrap();
        }
        cx.update(|cx| browser.update(cx, |browser, cx| browser.close(cx)));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[gpui_kit::test]
    async fn remote_files_open_with_enter_double_click_and_context_menu(cx: &mut TestAppContext) {
        use gpui_kit::{InputEvent as _, test::TestAppContextExt};
        use std::{path::Path, process::Command, time::Duration};
        let Some(server) = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
        else {
            return;
        };
        let root = std::env::temp_dir().join(format!("sftp-editor-ui-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("notes.txt"), b"remote\n").unwrap();
        let root = root.canonicalize().unwrap();
        let (handle, browser) = open(cx);
        cx.update(crate::bind_keys);
        cx.update(|cx| {
            let browser = browser.read(cx);
            browser
                .connection
                .run(|| Ok(Command::new(server)), true, |_| Ok(()))
                .unwrap();
        });
        cx.update_window(handle.into(), |_, window, cx| {
            browser.update(cx, |browser, cx| {
                browser.finish_listing(
                    Ok((
                        root.to_string_lossy().into_owned(),
                        vec![Entry {
                            name: "notes.txt".into(),
                            size: 7,
                            permissions: 0o100644,
                            modified: 0,
                        }],
                    )),
                    window,
                    cx,
                )
            });
        })
        .unwrap();
        settle(cx);
        for mode in 0..3 {
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                match mode {
                    0 => {
                        window.click("sftp-entry-notes.txt", cx);
                        window.press("enter", cx);
                    }
                    1 => window.double_click("sftp-entry-notes.txt", cx),
                    _ => {
                        let bounds = window.find("sftp-entry-notes.txt").bounds();
                        let position = gpui_kit::point(bounds.left() + px(16.), bounds.center().y);
                        window.dispatch_event(
                            gpui_kit::MouseDownEvent {
                                button: gpui_kit::MouseButton::Right,
                                position,
                                ..Default::default()
                            }
                            .to_platform_input(),
                            cx,
                        );
                        window.dispatch_event(
                            gpui_kit::MouseUpEvent {
                                button: gpui_kit::MouseButton::Right,
                                position,
                                ..Default::default()
                            }
                            .to_platform_input(),
                            cx,
                        );
                    }
                }
            })
            .unwrap();
            if mode == 2 {
                settle(cx);
                cx.update_window(handle.into(), |_, window, cx| {
                    window.render_frame(cx);
                    assert_eq!(window.find(0usize).label(), Some("Edit"));
                    window.click(0usize, cx)
                })
                .unwrap();
            }
            cx.wait_for(handle.into(), Duration::from_secs(5), |window, cx| {
                window.render_frame(cx);
                window.try_find("file-editor-status").is_some_and(|status| {
                    status.label().is_some_and(|label| label.ends_with("Saved"))
                })
            })
            .await;
            cx.update_window(handle.into(), |_, window, cx| {
                if mode == 0 {
                    window.press(
                        if cfg!(target_os = "macos") {
                            "cmd-a"
                        } else {
                            "ctrl-a"
                        },
                        cx,
                    );
                    window.input("saved remotely", cx);
                }
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                if mode == 0 {
                    window.press(
                        if cfg!(target_os = "macos") {
                            "cmd-s"
                        } else {
                            "ctrl-s"
                        },
                        cx,
                    );
                } else {
                    window.click("file-editor-cancel", cx);
                    assert!(
                        gpui_kit::Focusable::focus_handle(browser.read(cx).list.read(cx), cx)
                            .contains_focused(window, cx)
                    );
                }
            })
            .unwrap();
            if mode == 0 {
                cx.wait_for(handle.into(), Duration::from_secs(5), |window, cx| {
                    window.render_frame(cx);
                    window
                        .find("file-editor-status")
                        .label()
                        .is_some_and(|label| label.ends_with("Saved"))
                })
                .await;
                assert_eq!(
                    std::fs::read(root.join("notes.txt")).unwrap(),
                    b"saved remotely"
                );
                cx.update_window(handle.into(), |_, window, cx| {
                    window.click("file-editor-cancel", cx)
                })
                .unwrap();
            }
        }
        cx.update(|cx| browser.update(cx, |browser, cx| browser.close(cx)));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[gpui_kit::test]
    fn browser_selects_with_pointer_and_keyboard_and_validates_rename(cx: &mut TestAppContext) {
        let (handle, browser) = open(cx);
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.find("sftp-browser").visible());
            assert_eq!(window.find("sftp-path").value(), Some("/srv"));
            window.click("sftp-entry-documents", cx);
            assert_eq!(
                browser
                    .read(cx)
                    .list
                    .read(cx)
                    .delegate()
                    .selected()
                    .unwrap()
                    .name,
                "documents"
            );
            assert!(
                !browser.read(cx).busy,
                "A single click should select, not open, a folder"
            );
            window.press("down", cx);
            assert_eq!(
                browser
                    .read(cx)
                    .list
                    .read(cx)
                    .delegate()
                    .selected()
                    .unwrap()
                    .name,
                "notes.txt"
            );
            window.click("sftp-actions", cx);
            window.click(5usize, cx); // Rename, after Open, Download, separator, New file, New folder.
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("sftp-name").value(), Some("notes.txt"));
            window.click("sftp-name", cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-a"
                } else {
                    "ctrl-a"
                },
                cx,
            );
            window.input("../escape", cx);
            window.click("sftp-name-save", cx);
            assert!(window.try_find("dialog").is_some());
            assert!(!browser.read(cx).busy);
            window.press("escape", cx);
            assert!(window.try_find("dialog").is_none());
            window.click("sftp-actions", cx);
            window.click(7usize, cx); // Delete after the separator.
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_some());
            window.press("escape", cx);
            assert!(window.try_find("dialog").is_none());
            assert!(!browser.read(cx).busy, "Cancel must not start a deletion");
            window.click("sftp-entry-notes.txt", cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-a"
                } else {
                    "ctrl-a"
                },
                cx,
            );
            window.input("NOTES", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("sftp-entry-documents").is_none());
            assert!(window.find("sftp-entry-notes.txt").visible());
            assert_eq!(browser.read(cx).list.read(cx).delegate().visible.len(), 1);
            browser.update(cx, |browser, cx| {
                browser.busy = true;
                cx.notify();
            });
            window.render_frame(cx);
            let revision = browser.read(cx).revision;
            window.click("sftp-upload", cx);
            window.click("sftp-refresh", cx);
            assert_eq!(
                browser.read(cx).revision,
                revision,
                "Busy controls must not start another request"
            );
            window.click("sftp-close", cx);
            assert!(!browser.read(cx).is_open());
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn workspace_mounts_resizes_and_closes_the_browser_at_desktop_widths(cx: &mut TestAppContext) {
        use crate::{
            TerminalView,
            storage::{Settings, TabSnapshot, TabSource},
            workspace::Workspace,
        };
        use gpui_kit::component::Theme;
        cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_reduce_motion(true);
        });
        for (width, font_size) in [(1000., 16.), (640., 16.), (1100., 20.)] {
            cx.update(|cx| Theme::update(cx, |theme| theme.font_size = px(font_size)));
            let mut terminal = None;
            let mut browser = None;
            let handle = cx.open_window(size(px(width), px(650.)), |window, cx| {
                let profile = SshProfile {
                    name: "Layout test".into(),
                    host: String::new(),
                    ..SshProfile::default()
                };
                let view = cx.new(|cx| {
                    TerminalView::configured(
                        TabSnapshot {
                            id: uuid::Uuid::new_v4().to_string(),
                            source: TabSource::Ssh {
                                profile_id: profile.id.clone(),
                                directory: "/srv".into(),
                            },
                            output: vec![],
                            font_scale: 1.,
                            scroll_offset: 0.,
                            browser: BrowserSnapshot { width: 20. },
                        },
                        Some(profile),
                        Some(Store::at(std::env::temp_dir().join("sftp-layout-unused"))),
                        &Settings::default(),
                        window,
                        cx,
                    )
                });
                let panel = view.read(cx).browser.clone().unwrap();
                panel.update(cx, |panel, cx| {
                    panel.open = true;
                    panel.busy = true;
                    cx.notify();
                });
                let workspace = cx.new(|cx| Workspace::with_terminal(view.clone(), window, cx));
                terminal = Some(view);
                browser = Some(panel);
                Root::new(workspace, window, cx)
            });
            settle(cx);
            let terminal = terminal.unwrap();
            let browser = browser.unwrap();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                let bounds = window.find("sftp-browser").bounds();
                let path = window.find("sftp-path").bounds();
                let upload = window.find("sftp-upload");
                let actions = window.find("sftp-actions");
                assert_eq!(upload.label(), Some("Upload files…"));
                assert_eq!(actions.label(), Some("Actions"));
                assert!(upload.bounds().left() >= path.right());
                assert!(actions.bounds().left() >= upload.bounds().right());
                for button in [upload, actions] {
                    assert!(button.visible());
                    assert!((button.bounds().center().y - path.center().y).abs() < px(1.));
                    assert!(
                        (button.bounds().size.width - button.bounds().size.height).abs() < px(1.)
                    );
                    assert!(button.bounds().right() <= bounds.right());
                }
                assert!(
                    (bounds.size.width - px(font_size * 20.)).abs() < px(2.),
                    "Panel width should follow rem"
                );
                assert!(
                    bounds.size.height > px(400.),
                    "Panel should fill the remaining workspace height"
                );
                if width >= font_size * 56.25 {
                    assert!(window.find("terminal").bounds().size.width >= px(font_size * 20.));
                    browser.read(cx).resize.clone().update(cx, |state, cx| {
                        state.resize_panel(
                            1,
                            bounds.size.width + window.rem_size() * 2.,
                            window,
                            cx,
                        )
                    });
                    window.render_frame(cx);
                    assert!(window.find("sftp-browser").bounds().size.width > bounds.size.width);
                }
                window.click("sftp-close", cx);
            })
            .unwrap();
            settle(cx);
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                assert!(window.try_find("sftp-browser").is_none());
                assert!(terminal.read(cx).focus.is_focused(window));
            })
            .unwrap();
        }
    }

    #[gpui_kit::test]
    fn closing_panel_and_changing_profiles_cancel_connections(cx: &mut TestAppContext) {
        use std::sync::Arc;
        let (handle, browser) = open(cx);
        let connection = browser.read_with(cx, |browser, _| browser.connection());
        cx.update_window(handle.into(), |_, window, cx| {
            let revision = browser.read(cx).revision;
            browser.update(cx, |browser, cx| {
                browser.busy = true;
                browser
                    .list
                    .update(cx, |list, _| list.delegate_mut().loading = true);
            });
            window.render_frame(cx);
            window.click("sftp-close", cx);
            assert!(!browser.read(cx).is_open());
            assert!(!browser.read(cx).busy);
            assert!(!browser.read(cx).list.read(cx).delegate().loading);
            assert!(
                browser.read(cx).revision > revision,
                "Closed operations must not apply stale results"
            );
            assert!(
                connection
                    .run(
                        || panic!("Closed browser must not reconnect"),
                        true,
                        |_| Ok(())
                    )
                    .is_err()
            );
            let fresh = browser.read(cx).connection();
            assert!(!Arc::ptr_eq(&connection, &fresh));
            // A fresh connection can start on the next operation; avoid network access in this UI test.
            assert_eq!(
                fresh
                    .run(|| Err(anyhow::anyhow!("factory reached")), true, |_| Ok(()))
                    .unwrap_err()
                    .to_string(),
                "factory reached"
            );
            browser.update(cx, |browser, cx| {
                browser.open = true;
                browser.toggle(None, window, cx);
            });
            assert!(!browser.read(cx).is_open());
            assert!(
                fresh
                    .run(
                        || panic!("Toolbar close must not reconnect"),
                        true,
                        |_| Ok(())
                    )
                    .is_err()
            );
            let connection = browser.read(cx).connection();
            let mut profile = browser.read(cx).profile.clone();
            profile.host = "updated.example.com".into();
            browser.update(cx, |browser, cx| browser.configure(profile, cx));
            assert!(!Arc::ptr_eq(&connection, &browser.read(cx).connection()));
            assert!(
                connection
                    .run(
                        || panic!("Old credentials must not be used"),
                        true,
                        |_| Ok(())
                    )
                    .is_err()
            );
        })
        .unwrap();
    }

    #[test]
    fn metadata_formats_utc_dates_and_sizes() {
        assert_eq!(modified_time(1704067200), "2024-01-01 00:00 UTC");
        assert_eq!(modified_time(951782400), "2000-02-29 00:00 UTC");
        assert_eq!(file_size(1536), "1.5 KiB");
    }
}
