//! A single quick-edit dialog backed by GPUI Kit's native code editor.
use crate::{
    sftp::Connection,
    ssh,
    storage::{SshProfile, Store},
};
use anyhow::{Context as _, Result, ensure};
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, RopeExt, WindowExt,
        button::{Button, ButtonVariants},
        highlighter::LanguageRegistry,
        input::{Editor, EditorState, InputEvent},
    },
    prelude::FluentBuilder,
    *,
};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

const LOCAL_LIMIT: usize = 100 * 1024 * 1024;
pub(crate) const REMOTE_LIMIT: usize = 16 * 1024 * 1024;
actions!(file_editor, [SaveFile]);

#[derive(Clone)]
pub(crate) enum Target {
    Local(PathBuf),
    Remote {
        path: String,
        profile: Arc<SshProfile>,
        store: Store,
        connection: Arc<Connection>,
    },
}
impl Target {
    fn path(&self) -> &Path {
        match self {
            Self::Local(path) => path,
            Self::Remote { path, .. } => Path::new(path),
        }
    }
    fn limit(&self) -> usize {
        match self {
            Self::Local(_) => LOCAL_LIMIT,
            Self::Remote { .. } => REMOTE_LIMIT,
        }
    }
    fn read(&self) -> Result<Document> {
        let bytes = match self {
            Self::Local(path) => {
                let metadata = std::fs::symlink_metadata(path)?;
                ensure!(
                    metadata.is_file(),
                    "Choose a regular file, not a folder or symbolic link"
                );
                ensure!(
                    metadata.len() <= self.limit() as u64,
                    "This file exceeds the 100 MiB local limit"
                );
                let mut bytes = Vec::new();
                std::fs::File::open(path)?
                    .take((self.limit() + 1) as u64)
                    .read_to_end(&mut bytes)?;
                bytes
            }
            Self::Remote {
                path,
                profile,
                store,
                connection,
            } => connection.run(
                || ssh::sftp_command(profile, store),
                true,
                |client| client.read_file(path, self.limit()).map(|(bytes, _)| bytes),
            )?,
        };
        Document::new(bytes, self.limit())
    }
    fn save(&self, bytes: &[u8], original: &[u8]) -> Result<()> {
        ensure!(
            bytes.len() <= self.limit(),
            "The edited file exceeds the size limit"
        );
        match self {
            Self::Local(path) => save_local(path, bytes, original),
            Self::Remote {
                path,
                profile,
                store,
                connection,
            } => connection.run(
                || ssh::sftp_command(profile, store),
                false,
                |client| client.save_file(path, bytes, original),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum LineEnding {
    Lf,
    Crlf,
    Cr,
}
impl LineEnding {
    fn label(self) -> &'static str {
        match self {
            Self::Lf => "LF",
            Self::Crlf => "CRLF",
            Self::Cr => "CR",
        }
    }
    fn encode(self, text: &str) -> Vec<u8> {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        match self {
            Self::Lf => text.into_bytes(),
            Self::Crlf => text.replace('\n', "\r\n").into_bytes(),
            Self::Cr => text.replace('\n', "\r").into_bytes(),
        }
    }
}
struct Document {
    original: Arc<Vec<u8>>,
    text: SharedString,
    ending: LineEnding,
}
impl Document {
    fn new(bytes: Vec<u8>, limit: usize) -> Result<Self> {
        ensure!(
            bytes.len() <= limit,
            "This file exceeds the editor’s size limit"
        );
        ensure!(
            !bytes
                .iter()
                .any(|b| *b < 32 && !matches!(b, b'\t' | b'\n' | b'\r' | 12) || *b == 127),
            "This appears to be a binary file"
        );
        let text = std::str::from_utf8(&bytes).context("Only UTF-8 text files can be edited")?;
        let ending = match text.find(['\r', '\n']) {
            Some(ix) if text[ix..].starts_with("\r\n") => LineEnding::Crlf,
            Some(ix) if text.as_bytes()[ix] == b'\r' => LineEnding::Cr,
            _ => LineEnding::Lf,
        };
        // A mixed-ending file uses its first detected ending after an explicit save.
        let text = text.replace("\r\n", "\n").replace('\r', "\n").into();
        Ok(Self {
            original: Arc::new(bytes),
            text,
            ending,
        })
    }
}
fn save_local(path: &Path, bytes: &[u8], original: &[u8]) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file(),
        "The original is no longer a regular file"
    );
    ensure!(
        metadata.len() == original.len() as u64 && std::fs::read(path)? == original,
        "The file changed since it was opened. Cancel and reopen it before saving"
    );
    let temporary = path.with_file_name(format!(".terminal-edit-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::File::options();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.set_permissions(metadata.permissions())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path).context("Couldn’t replace the original file")?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temporary);
    result
}
fn language(path: &Path) -> &'static str {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let candidate = match name.as_str() {
        "makefile" | "gnumakefile" => "make",
        "cmakelists.txt" => "cmake",
        ".bashrc" | ".bash_profile" | ".profile" | ".zshrc" => "bash",
        _ => match path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "js" | "mjs" | "cjs" | "jsx" => "javascript",
            "ts" | "mts" | "cts" => "typescript",
            "tsx" => "tsx",
            "html" | "htm" => "html",
            "css" | "scss" => "css",
            "json" | "jsonc" => "json",
            "md" | "mdx" | "markdown" => "markdown",
            "py" | "pyi" => "python",
            "java" => "java",
            "sql" => "sql",
            "yaml" | "yml" => "yaml",
            "sh" | "bash" | "zsh" => "bash",
            "toml" => "toml",
            "diff" | "patch" => "diff",
            "rs" => "rust",
            "go" => "go",
            "c" | "h" => "c",
            "cpp" | "hpp" | "cc" => "cpp",
            "rb" => "ruby",
            "php" => "php",
            "swift" => "swift",
            "lua" => "lua",
            "zig" => "zig",
            "svelte" => "svelte",
            _ => "text",
        },
    };
    if LanguageRegistry::singleton().language(candidate).is_some() {
        candidate
    } else {
        "text"
    }
}

#[derive(Default)]
struct ActiveEditor(Option<WeakEntity<FileEditor>>);
impl Global for ActiveEditor {}
#[derive(Clone, Copy)]
enum Discard {
    Close,
    Quit,
    #[cfg(target_os = "macos")]
    Restart,
}
struct FileEditor {
    target: Target,
    input: Entity<EditorState>,
    document: Option<Document>,
    busy: bool,
    dirty: bool,
    discard: Option<Discard>,
    error: Option<String>,
    _subscription: Subscription,
    dirty_task: Option<Task<()>>,
}
impl FileEditor {
    fn new(target: Target, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| EditorState::new(window, cx).language(language(target.path())));
        let subscription = cx.subscribe(&input, |view, input, event, cx| {
            if matches!(event, InputEvent::Change) {
                let Some(doc) = &view.document else {
                    return;
                };
                view.dirty = true;
                let text = input.read(cx).text().clone();
                let saved = doc.text.clone();
                // Keep full-document comparisons off the typing path, including Undo.
                view.dirty_task = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(120))
                        .await;
                    let dirty = cx
                        .background_spawn(async move { text != saved.as_ref() })
                        .await;
                    let _ = this.update(cx, |view, cx| {
                        view.dirty = dirty;
                        cx.notify();
                    });
                }));
                cx.notify();
            }
        });
        Self {
            target,
            input,
            document: None,
            busy: false,
            dirty: false,
            discard: None,
            error: None,
            _subscription: subscription,
            dirty_task: None,
        }
    }
    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.dirty_task.take();
        self.busy = true;
        self.input
            .update(cx, |input, cx| input.set_disabled(true, cx));
        self.error = None;
        self.discard = None;
        let target = self.target.clone();
        let read = cx.background_spawn(async move { target.read() });
        cx.spawn_in(window, async move |this, cx| {
            let result = read.await;
            let _ = this.update_in(cx, |view, window, cx| {
                view.busy = false;
                match result {
                    Ok(document) => {
                        let text = document.text.clone();
                        view.document = Some(document);
                        view.dirty = false;
                        view.input.update(cx, |input, cx| {
                            input.set_value(text, window, cx);
                        });
                    }
                    Err(error) => view.error = Some(format!("Couldn’t open file: {error:#}")),
                }
                let available = view.document.is_some();
                view.input.update(cx, |input, cx| {
                    input.set_disabled(!available, cx);
                    if available {
                        input.focus(window, cx);
                    }
                });
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn save(&mut self, _: &SaveFile, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || !self.dirty {
            return;
        }
        let Some(doc) = &self.document else {
            return;
        };
        self.dirty_task.take();
        self.busy = true;
        self.input
            .update(cx, |input, cx| input.set_disabled(true, cx));
        self.error = None;
        self.discard = None;
        let snapshot = self.input.read(cx).text().clone();
        let ending = doc.ending;
        let original = doc.original.clone();
        let target = self.target.clone();
        let work = cx.background_spawn(async move {
            let text: SharedString = snapshot.to_string().into();
            let bytes = ending.encode(&text);
            target.save(&bytes, &original)?;
            Ok::<_, anyhow::Error>(Document {
                original: Arc::new(bytes),
                text,
                ending,
            })
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = work.await;
            let _ = this.update_in(cx, |view, window, cx| {
                view.busy = false;
                match result {
                    Ok(doc) => {
                        view.document = Some(doc);
                        view.dirty = false;
                    }
                    Err(error) => view.error = Some(format!("Couldn’t save: {error:#}")),
                }
                view.input.update(cx, |input, cx| {
                    input.set_disabled(false, cx);
                    input.focus(window, cx);
                });
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn request_discard(&mut self, action: Discard, cx: &mut Context<Self>) -> bool {
        if self.busy {
            return false;
        }
        if self.dirty {
            self.discard = Some(action);
            cx.notify();
            false
        } else {
            true
        }
    }
    fn finish_discard(&mut self, action: Discard, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.discard = None;
        match action {
            Discard::Close => close(window, cx),
            Discard::Quit => cx.quit(),
            #[cfg(target_os = "macos")]
            Discard::Restart => cx.restart(),
        }
    }
}
impl Render for FileEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let metadata = if let Some(doc) = &self.document {
            format!(
                "{} bytes · {} lines · {} · {} · {}",
                self.input.read(cx).text().len()
                    + if doc.ending == LineEnding::Crlf {
                        self.input.read(cx).text().lines_len().saturating_sub(1)
                    } else {
                        0
                    },
                self.input.read(cx).text().lines_len(),
                self.input.read(cx).language_name(),
                doc.ending.label(),
                if self.busy {
                    "Working…"
                } else if self.dirty {
                    "Unsaved"
                } else {
                    "Saved"
                }
            )
        } else if self.busy {
            "Opening…".into()
        } else {
            "File unavailable".into()
        };
        div()
            .id("file-editor")
            .key_context("FileEditor")
            .size_full()
            .min_h_0()
            .flex()
            .flex_col()
            .gap_3()
            .on_action(cx.listener(Self::save))
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap_3()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(self.target.path().display().to_string()),
                    )
                    .child(
                        div()
                            .id("file-editor-status")
                            .test_support()
                            .role(Role::Status)
                            .flex_shrink_0()
                            .whitespace_nowrap()
                            .aria_label(metadata.clone())
                            .child(metadata),
                    ),
            )
            .when_some(self.error.clone(), |el, error| {
                el.child(
                    div()
                        .id("file-editor-error")
                        .test_support()
                        .role(Role::Alert)
                        .flex_shrink_0()
                        .text_sm()
                        .text_color(cx.theme().danger)
                        .aria_label(error.clone())
                        .child(error),
                )
            })
            .child(
                Editor::new(&self.input)
                    .h(relative(1.))
                    .flex_1()
                    .min_h_0()
                    .disabled(self.busy || self.document.is_none())
                    .aria_label("File contents"),
            )
            .when_some(self.discard, |el, _| {
                el.child(
                    div()
                        .flex()
                        .flex_shrink_0()
                        .items_center()
                        .gap_2()
                        .child(div().flex_1().text_sm().child("Discard unsaved changes?")),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .justify_end()
                    .gap_2()
                    .when_some(self.discard, |footer, action| {
                        footer
                            .child(
                                Button::new("file-editor-keep")
                                    .label("Keep editing")
                                    .on_click(cx.listener(|view, _, window, cx| {
                                        view.discard = None;
                                        view.input.update(cx, |input, cx| input.focus(window, cx));
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("file-editor-discard")
                                    .danger()
                                    .label("Discard")
                                    .on_click(cx.listener(move |view, _, window, cx| {
                                        view.finish_discard(action, window, cx)
                                    })),
                            )
                    })
                    .when(self.discard.is_none(), |footer| {
                        footer
                            .child(
                                Button::new("file-editor-cancel")
                                    .label("Cancel")
                                    .disabled(self.busy)
                                    .on_click(cx.listener(|view, _, window, cx| {
                                        if view.request_discard(Discard::Close, cx) {
                                            close(window, cx);
                                        }
                                    })),
                            )
                            .child(
                                Button::new("file-editor-save")
                                    .primary()
                                    .label("Save")
                                    .disabled(self.busy || !self.dirty)
                                    .on_click(cx.listener(|view, _, window, cx| {
                                        view.save(&SaveFile, window, cx)
                                    })),
                            )
                    }),
            )
    }
}

fn close(window: &mut Window, cx: &mut App) {
    cx.set_global(ActiveEditor(None));
    window.close_dialog(cx);
}

pub(crate) fn open(target: Target, window: &mut Window, cx: &mut App) {
    if window.has_active_dialog(cx) {
        return;
    }
    let view = cx.new(|cx| FileEditor::new(target, window, cx));
    cx.set_global(ActiveEditor(Some(view.downgrade())));
    let title = view
        .read(cx)
        .target
        .path()
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let editor = view.clone();
    window.open_dialog(cx, move |dialog, window, _| {
        let cancel = editor.clone();
        dialog
            .title(
                div()
                    .w_full()
                    .window_control_area(WindowControlArea::Drag)
                    .on_mouse_down(MouseButton::Left, |_, window, _| {
                        window.start_window_move();
                    })
                    .child(title.clone()),
            )
            .width(window.viewport_size().width - window.rem_size() * 2.)
            .h(window.viewport_size().height - window.rem_size() * 3.)
            .margin_top(window.rem_size() * 2.)
            .gap_0()
            .overlay_closable(false)
            .content({
                let editor = editor.clone();
                move |content, _, _| content.min_h_0().child(editor.clone())
            })
            .footer(div())
            .on_ok(|_, _, _| false)
            .on_cancel(move |_, _, cx| {
                cancel.update(cx, |view, cx| view.request_discard(Discard::Close, cx))
            })
            .on_close(|_, _, cx| {
                cx.set_global(ActiveEditor(None));
            })
    });
    view.update(cx, |view, cx| view.load(window, cx));
}
pub(crate) fn open_picker(window: &mut Window, cx: &mut App) {
    if window.has_active_dialog(cx) {
        return;
    }
    let picker = cx.prompt_for_paths(PathPromptOptions {
        files: true,
        directories: false,
        multiple: false,
        prompt: Some("Edit".into()),
    });
    window
        .spawn(cx, async move |cx| {
            if let Ok(Ok(Some(paths))) = picker.await
                && let Some(path) = paths.into_iter().next()
            {
                let _ = cx.update(|window, cx| open(Target::Local(path), window, cx));
            }
        })
        .detach();
}
/// The dialog owns the editor; the weak global only guards application/window quit.
pub(crate) fn prevent_quit(cx: &mut App) -> bool {
    prevent_exit(Discard::Quit, cx)
}
#[cfg(target_os = "macos")]
pub(crate) fn prevent_restart(cx: &mut App) -> bool {
    prevent_exit(Discard::Restart, cx)
}
fn prevent_exit(action: Discard, cx: &mut App) -> bool {
    let active = cx
        .try_global::<ActiveEditor>()
        .and_then(|active| active.0.clone());
    active.is_some_and(|editor| {
        editor
            .update(cx, |view, cx| !view.request_discard(action, cx))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::{ActiveEditor, Document, LOCAL_LIMIT, LineEnding, Target, save_local};
    use gpui_kit::{
        AppContext, Context, IntoElement, Render, Styled, TestAppContext, Window,
        component::{Root, WindowExt},
        div, px, size,
        test::{TestAppContextExt, TestWindowExt},
    };
    use std::time::Duration;

    #[test]
    fn text_round_trips_and_local_saves_preserve_content_on_conflict() -> anyhow::Result<()> {
        for (bytes, ending) in [
            ("hello\n你好\n", LineEnding::Lf),
            ("hello\r\n你好\r\n", LineEnding::Crlf),
            ("hello\r你好\r", LineEnding::Cr),
            ("", LineEnding::Lf),
        ] {
            let doc = Document::new(bytes.as_bytes().to_vec(), LOCAL_LIMIT)?;
            assert_eq!(doc.ending, ending);
            assert_eq!(doc.ending.encode(&doc.text), bytes.as_bytes());
            assert!(!doc.text.contains('\r'));
        }
        assert_eq!(LineEnding::Crlf.encode("a\r\nb\rc\n"), b"a\r\nb\r\nc\r\n");
        assert_eq!(super::language(std::path::Path::new("app.tsx")), "tsx");
        assert_eq!(
            super::language(std::path::Path::new("notes.unknown")),
            "text"
        );
        for bytes in [vec![0], vec![0xff], vec![1, 2]] {
            assert!(Document::new(bytes, LOCAL_LIMIT).is_err());
        }
        assert!(Document::new(b"1234".to_vec(), 3).is_err());
        let dir = std::env::temp_dir().join(format!("editor-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir)?;
        let path = dir.join("notes.txt");
        std::fs::write(&path, "original")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751))?;
        }
        save_local(&path, b"edited", b"original")?;
        assert_eq!(std::fs::read(&path)?, b"edited");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)?.permissions().mode() & 0o777,
                0o751
            );
        }
        std::fs::write(&path, "external")?;
        assert!(save_local(&path, b"lost", b"edited").is_err());
        assert_eq!(std::fs::read(&path)?, b"external");
        assert_eq!(
            std::fs::read_dir(&dir)?.count(),
            1,
            "Staging files must be cleaned up"
        );
        #[cfg(unix)]
        {
            let link = dir.join("link");
            std::os::unix::fs::symlink(&path, &link)?;
            assert!(Target::Local(link).read().is_err());
        }
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    struct Host;
    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full()
        }
    }
    #[gpui_kit::test]
    async fn editor_saves_and_guards_discard_through_native_controls(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::bind_keys(cx);
            cx.set_reduce_motion(true);
        });
        let path = std::env::temp_dir().join(format!("editor-ui-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"original\r\nsecond").unwrap();
        let handle = cx.open_window(size(px(1000.), px(800.)), |window, cx| {
            let host = cx.new(|_| Host);
            Root::new(host, window, cx)
        });
        cx.update_window(handle.into(), |_, window, cx| {
            super::open_picker(window, cx)
        })
        .unwrap();
        cx.simulate_path_prompt_response(|options| {
            assert!(options.files && !options.directories && !options.multiple);
            Some(vec![path.clone()])
        });
        cx.wait_for(handle.into(), Duration::from_secs(5), |_, cx| {
            cx.try_global::<ActiveEditor>()
                .and_then(|active| active.0.as_ref())
                .and_then(|view| view.upgrade())
                .is_some_and(|view| !view.read(cx).busy)
        })
        .await;
        let view = cx.update(|cx| {
            cx.global::<ActiveEditor>()
                .0
                .as_ref()
                .unwrap()
                .upgrade()
                .unwrap()
        });
        for (width, height) in [(1000., 600.), (1600., 1000.), (640., 480.), (1000., 800.)] {
            cx.simulate_window_resize(handle.into(), size(px(width), px(height)));
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                let contents = window
                    .find(("input", view.read(cx).input.entity_id()))
                    .bounds();
                assert!(contents.size.width > window.viewport_size().width * 0.85);
                assert!(contents.size.height > window.viewport_size().height * 0.6);
                let dialog = window.find(0usize).bounds();
                assert!(
                    (dialog.bottom() - (window.viewport_size().height - window.rem_size())).abs()
                        < px(1.)
                );
                for id in ["file-editor-cancel", "file-editor-save"] {
                    let button = window.find(id);
                    assert!(button.visible());
                    assert!(
                        button.bounds().bottom()
                            >= window.viewport_size().height - window.rem_size() * 3.
                    );
                    assert!(
                        button.bounds().bottom()
                            <= window.viewport_size().height - window.rem_size()
                    );
                }
            })
            .unwrap();
        }
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("file-editor-cancel").label(), Some("Cancel"));
            assert_eq!(window.find("file-editor-save").label(), Some("Save"));
            assert!(window.try_find("file-editor-revert").is_none());
            assert_eq!(view.read(cx).input.read(cx).value(), "original\nsecond");
            window.click("file-editor-save", cx);
            assert!(
                !view.read(cx).busy,
                "Saving unchanged content must do nothing"
            );
            window.click(("input", view.read(cx).input.entity_id()), cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-a"
                } else {
                    "ctrl-a"
                },
                cx,
            );
            window.input("edited", cx);
            window.press("enter", cx);
            window.input("second", cx);
            assert!(
                window.has_active_dialog(cx),
                "Enter must insert a newline without closing the dialog"
            );
            assert_eq!(view.read(cx).input.read(cx).value(), "edited\nsecond");
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            assert!(view.read(cx).dirty);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-s"
                } else {
                    "ctrl-s"
                },
                cx,
            );
            assert!(
                view.read(cx).busy,
                "The save key must reach the editor action"
            );
            window.input("must not be inserted", cx);
            assert_eq!(view.read(cx).input.read(cx).value(), "edited\nsecond");
            window.click("file-editor-cancel", cx);
            assert!(
                window.has_active_dialog(cx),
                "Cancel must be disabled while saving"
            );
        })
        .unwrap();
        cx.wait_for(handle.into(), Duration::from_secs(5), |_, cx| {
            !view.read(cx).busy
        })
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(view.read(cx).error.is_none(), "{:?}", view.read(cx).error);
            assert!(!view.read(cx).dirty);
            assert_eq!(std::fs::read(&path).unwrap(), b"edited\r\nsecond");
            window.input(" changed", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.click("file-editor-cancel", cx);
            assert!(window.find("file-editor-discard").visible());
            assert!(window.try_find("file-editor-cancel").is_none());
            assert!(window.try_find("file-editor-save").is_none());
            assert!(window.has_active_dialog(cx));
            let keep = window.find("file-editor-keep");
            assert!(keep.visible(), "Keep editing must fit: {:?}", keep.bounds());
            assert!(
                keep.bounds().bottom() <= window.viewport_size().height,
                "Keep editing must fit: {:?}",
                keep.bounds()
            );
            window.click("file-editor-keep", cx);
            assert!(window.try_find("file-editor-discard").is_none());
            assert!(super::prevent_quit(cx), "Quit must guard dirty files");
            window.render_frame(cx);
            window.click("file-editor-keep", cx);
            #[cfg(target_os = "macos")]
            {
                assert!(super::prevent_restart(cx), "Restart must guard dirty files");
                window.render_frame(cx);
                window.click("file-editor-keep", cx);
            }
            window.press("escape", cx);
            assert!(window.find("file-editor-discard").visible());
            window.click("file-editor-discard", cx);
            assert!(!window.has_active_dialog(cx));
            assert_eq!(std::fs::read(&path).unwrap(), b"edited\r\nsecond");
        })
        .unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
