#!/bin/sh
set -eu

command -v rustup >/dev/null 2>&1 || {
    printf '%s\n' 'rustup is required. Install it from https://rustup.rs.' >&2
    exit 1
}

app_name=$(basename "$PWD")
case "$app_name" in
    ''|[!a-z]*|*[!a-z0-9_-]*)
        printf '%s\n' 'Invalid folder name: use lowercase letters, digits, - or _, starting with a letter.' >&2
        exit 1
        ;;
esac

rustup update stable
mkdir -p src

cat > rust-toolchain.toml <<'EOF'
[toolchain]
channel = "stable"
EOF

cat > Cargo.toml <<EOF
[package]
name = "$app_name"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
dirs = "6"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
gpui-kit = { git = "https://github.com/longbridge/gpui-kit", rev = "dc00da1837f16a6da42280535d76a2d7acc4a40e", features = ["gpui-fast"] }

[dev-dependencies]
gpui-kit = { git = "https://github.com/longbridge/gpui-kit", rev = "dc00da1837f16a6da42280535d76a2d7acc4a40e", features = ["test-support"] }

[profile.dev]
debug = 0
incremental = false
EOF

cat > src/main.rs <<'EOF'
mod settings;
mod settings_view;

use gpui_kit::component::{ActiveTheme, Theme};
use gpui_kit::*;
use settings::Settings;

impl Global for Settings {}

actions!(base_app, [Quit, OpenSettings]);

struct AppView;

impl Render for AppView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(cx.theme().background)
    }
}

fn main() {
    let loaded = Settings::path().and_then(|path| {
        Settings::load(&path)
            .map(|settings| (path.clone(), settings))
            .map_err(|error| {
                std::io::Error::new(error.kind(), format!("{}: {error}", path.display()))
            })
    });
    let (settings_path, settings, startup_error) = match loaded {
        Ok((path, settings)) => (Some(path), settings, None),
        Err(error) => (
            None,
            Settings::default(),
            Some(format!(
                "Couldn’t load settings: {error}. Existing files are preserved and saving is disabled. Fix the file or folder permissions, then restart the app."
            )),
        ),
    };
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            cx.set_global(settings);
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();

            let options = WindowOptions {
                window_bounds: Some(WindowBounds::centered(size(px(1200.), px(800.)), cx)),
                titlebar: Some(TitlebarOptions {
                    title: Some(env!("CARGO_PKG_NAME").into()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            let (handle, _) = gpui_kit::open_window(options, cx, |window, cx| {
                Theme::sync_system_appearance(Some(window), cx);
                window
                    .observe_window_appearance(|window, cx| {
                        Theme::sync_system_appearance(Some(window), cx);
                    })
                    .detach();
                cx.new(|_| AppView)
            })
            .expect("Failed to open app window");
            cx.bind_keys([
                KeyBinding::new("cmd-q", Quit, None),
                KeyBinding::new("cmd-,", OpenSettings, None),
                #[cfg(not(target_os = "macos"))]
                KeyBinding::new("ctrl-q", Quit, None),
                #[cfg(not(target_os = "macos"))]
                KeyBinding::new("ctrl-,", OpenSettings, None),
            ]);
            cx.on_action(|_: &Quit, cx| cx.quit());
            settings_view::register_action(handle, settings_path, startup_error.clone(), cx);
            cx.set_menus(vec![Menu {
                name: env!("CARGO_PKG_NAME").into(),
                disabled: false,
                items: vec![
                    MenuItem::action("Settings…", OpenSettings),
                    MenuItem::separator(),
                    MenuItem::action("Quit", Quit),
                ],
            }]);
            if let Some(error) = startup_error {
                let _ = cx.update_window(handle, |_, window, cx| {
                    settings_view::show_error(error, window, cx);
                });
            }
            cx.activate(true);
        });
}
EOF

cat > src/settings.rs <<'EOF'
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const MAX_SETTINGS_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Settings {
    // Replace these examples with your app's settings.
    pub(crate) display_name: String,
    pub(crate) notifications_enabled: bool,
    pub(crate) recent_items_limit: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            display_name: "Guest".into(),
            notifications_enabled: true,
            recent_items_limit: 10,
        }
    }
}

impl Settings {
    pub(crate) fn path() -> io::Result<PathBuf> {
        let directory = dirs::data_local_dir()
            .ok_or_else(|| io::Error::other("Could not find the application data directory"))?;
        Ok(directory.join(env!("CARGO_PKG_NAME")).join("settings.json"))
    }

    pub(crate) fn load(path: &Path) -> io::Result<Self> {
        match Self::read(path) {
            Ok(settings) => Ok(settings),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let settings = Self::default();
                settings.save(path)?;
                Ok(settings)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn read(path: &Path) -> io::Result<Self> {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_SETTINGS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_SETTINGS_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Settings JSON exceeds 1 MiB",
            ));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub(crate) fn save(&self, path: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self)?;
        if bytes.len() > MAX_SETTINGS_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Settings JSON exceeds 1 MiB",
            ));
        }
        let directory = path
            .parent()
            .ok_or_else(|| io::Error::other("Invalid settings path"))?;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(directory)?;
        let temporary = directory.join(format!(".settings-{}.tmp", std::process::id()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_persist_defaults_changes_and_preserve_invalid_files() -> io::Result<()> {
        let directory = std::env::temp_dir().join(format!(
            "{}-settings-test-{}",
            env!("CARGO_PKG_NAME"),
            std::process::id()
        ));
        fs::create_dir(&directory)?;
        let path = directory.join("app/settings.json");
        let result = (|| -> io::Result<()> {
            let mut settings = Settings::load(&path)?;
            assert_eq!(settings, Settings::default());
            assert!(path.exists());
            let missing = directory.join("missing.json");
            assert!(Settings::read(&missing).is_err());
            assert!(!missing.exists());
            settings.display_name = "Ada".into();
            settings.notifications_enabled = false;
            settings.recent_items_limit = 3;
            settings.save(&path)?;
            assert_eq!(Settings::load(&path)?, settings);
            fs::write(&path, r#"{"display_name":"Lin"}"#)?;
            assert_eq!(
                Settings::load(&path)?,
                Settings {
                    display_name: "Lin".into(),
                    ..Settings::default()
                }
            );
            for invalid in ["invalid JSON", r#"{"recent_items_limit":-1}"#] {
                fs::write(&path, invalid)?;
                assert!(Settings::load(&path).is_err());
                assert_eq!(fs::read_to_string(&path)?, invalid);
            }
            let oversized = directory.join("oversized.json");
            fs::write(&oversized, vec![b' '; MAX_SETTINGS_BYTES + 1])?;
            assert_eq!(
                Settings::read(&oversized).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            let huge = Settings {
                display_name: "x".repeat(MAX_SETTINGS_BYTES),
                ..Settings::default()
            };
            assert!(huge.save(&path).is_err());
            assert_eq!(fs::read_to_string(&path)?, r#"{"recent_items_limit":-1}"#);
            let temporary = path
                .parent()
                .unwrap()
                .join(format!(".settings-{}.tmp", std::process::id()));
            fs::write(&temporary, "existing temporary file")?;
            assert!(settings.save(&path).is_err());
            assert_eq!(fs::read_to_string(&path)?, r#"{"recent_items_limit":-1}"#);
            assert_eq!(fs::read_to_string(&temporary)?, "existing temporary file");
            assert!(
                Settings::path()?
                    .ends_with(Path::new(env!("CARGO_PKG_NAME")).join("settings.json"))
            );
            Ok(())
        })();
        fs::remove_dir_all(directory)?;
        result
    }
}
EOF

cat > src/settings_view.rs <<'EOF'
use crate::settings::Settings;
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, WindowExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        dialog::{DialogAction, DialogFooter},
        form::{Field, Form},
        input::{Input, InputState},
    },
    *,
};
use std::path::PathBuf;

pub(crate) fn register_action(
    handle: AnyWindowHandle,
    path: Option<PathBuf>,
    error: Option<String>,
    cx: &mut App,
) {
    cx.on_action(move |_: &crate::OpenSettings, cx| {
        let path = path.clone();
        let error = error.clone();
        // Action dispatch already borrows the window; open after it completes.
        cx.defer(move |cx| {
            if let Err(error) = cx.update_window(handle, |_, window, cx| {
                open(path, error, window, cx);
            }) {
                eprintln!("Couldn’t open settings: {error}");
            }
        });
    });
}

pub(crate) fn show_error(message: String, window: &mut Window, cx: &mut App) {
    window.open_alert_dialog(cx, move |dialog, _, _| {
        dialog.title("Couldn’t load settings").description(
            div()
                .id("startup-error")
                .test_support()
                .role(Role::Status)
                .aria_label(message.clone())
                .child(message.clone()),
        )
    });
}

pub(crate) fn open(
    path: Option<PathBuf>,
    error: Option<String>,
    window: &mut Window,
    cx: &mut App,
) {
    // A second shortcut invocation should keep the current draft.
    if window.has_active_dialog(cx) {
        return;
    }
    let Some(path) = path else {
        show_error(
            error.unwrap_or_else(|| {
                "Settings saving is disabled. Restart after fixing the settings file.".into()
            }),
            window,
            cx,
        );
        return;
    };
    let settings = cx.global::<Settings>().clone();
    let form = cx.new(|cx| SettingsForm::new(path, settings, window, cx));
    window.open_dialog(cx, move |dialog, window, _| {
        let confirm = form.clone();
        dialog
            .title("Settings")
            .width(window.rem_size() * 28.)
            .child(form.clone())
            .on_ok(move |_, _, cx| confirm.update(cx, |form, cx| form.save(cx)))
    });
}

struct SettingsForm {
    path: PathBuf,
    name: Entity<InputState>,
    limit: Entity<InputState>,
    enabled: bool,
    error: Option<String>,
    transfer_busy: bool,
    status: Option<String>,
}

impl SettingsForm {
    fn new(path: PathBuf, settings: Settings, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("Display name");
            state.set_value(settings.display_name, window, cx);
            state
        });
        let limit = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("Recent items limit");
            state.set_value(settings.recent_items_limit.to_string(), window, cx);
            state
        });
        Self {
            path,
            name,
            limit,
            enabled: settings.notifications_enabled,
            error: None,
            transfer_busy: false,
            status: None,
        }
    }

    fn save(&mut self, cx: &mut Context<Self>) -> bool {
        if self.transfer_busy {
            return false;
        }
        let result = (|| -> Result<Settings, String> {
            let limit = self
                .limit
                .read(cx)
                .value()
                .trim()
                .parse::<u32>()
                .map_err(|_| {
                    "Enter a whole number from 0 to 4294967295 for the recent items limit."
                        .to_string()
                })?;
            let settings = Settings {
                display_name: self.name.read(cx).value().to_string(),
                notifications_enabled: self.enabled,
                recent_items_limit: limit,
            };
            settings.save(&self.path).map_err(|error| {
                format!(
                    "Couldn’t save {}: {error}. Your changes have not been saved.",
                    self.path.display()
                )
            })?;
            Ok(settings)
        })();
        match result {
            Ok(settings) => {
                cx.set_global(settings);
                cx.refresh_windows();
                true
            }
            Err(error) => {
                self.error = Some(error);
                cx.notify();
                false
            }
        }
    }

    fn transfer(&mut self, importing: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.transfer_busy {
            return;
        }
        let picker: Task<Result<Option<PathBuf>>> = if importing {
            let picker = cx.prompt_for_paths(PathPromptOptions {
                files: true,
                directories: false,
                multiple: false,
                prompt: Some("Import settings".into()),
            });
            cx.background_spawn(async move {
                Ok(picker.await??.and_then(|paths| paths.into_iter().next()))
            })
        } else {
            let directory = dirs::download_dir()
                .or_else(dirs::home_dir)
                .unwrap_or_else(|| ".".into());
            let picker = cx.prompt_for_new_path(&directory, Some("settings.json"));
            cx.background_spawn(async move { picker.await? })
        };
        let saved = cx.global::<Settings>().clone();
        self.transfer_busy = true;
        self.error = None;
        self.status = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result: Result<Option<Settings>> = async {
                let Some(path) = picker.await? else {
                    return Ok(None);
                };
                let settings = cx
                    .background_spawn(async move {
                        if importing {
                            Settings::read(&path)
                        } else {
                            saved.save(&path).map(|_| saved)
                        }
                    })
                    .await?;
                Ok(Some(settings))
            }
            .await;
            let _ = this.update_in(cx, |form, window, cx| {
                form.transfer_busy = false;
                match result {
                    Ok(Some(settings)) => {
                        if importing {
                            form.name.update(cx, |state, cx| {
                                state.set_value(settings.display_name, window, cx)
                            });
                            form.limit.update(cx, |state, cx| {
                                state.set_value(settings.recent_items_limit.to_string(), window, cx)
                            });
                            form.enabled = settings.notifications_enabled;
                        }
                        form.status = Some(
                            if importing {
                                "Settings imported. Review them and choose Save."
                            } else {
                                "Saved settings exported."
                            }
                            .into(),
                        );
                    }
                    Ok(None) => {}
                    Err(error) => {
                        form.error = Some(format!(
                            "Couldn’t {} settings: {error}.",
                            if importing { "import" } else { "export" }
                        ))
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for SettingsForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                Form::new()
                    .child(
                        Field::new()
                            .label("Display name")
                            .child(Input::new(&self.name).id("display-name")),
                    )
                    .child(
                        Field::new().label_indent(false).child(
                            Checkbox::new("notifications-enabled")
                                .label("Enable notifications")
                                .checked(self.enabled)
                                .on_change(cx.listener(|this, value, _, cx| {
                                    this.enabled = *value;
                                    cx.notify();
                                })),
                        ),
                    )
                    .child(
                        Field::new()
                            .label("Recent items limit")
                            .child(Input::new(&self.limit).id("recent-items-limit")),
                    ),
            )
            .child(
                div()
                    .id("settings-transfer-status")
                    .test_support()
                    .role(Role::Status)
                    .aria_label(self.status.clone().unwrap_or_default())
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .children(self.status.clone()),
            )
            .child(
                div()
                    .id("settings-error")
                    .test_support()
                    .role(Role::Status)
                    .aria_label(self.error.clone().unwrap_or_default())
                    .text_sm()
                    .text_color(cx.theme().danger)
                    .children(self.error.clone()),
            )
            .child(
                DialogFooter::new()
                    .child(
                        Button::new("cancel")
                            .label("Cancel")
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(DialogAction::new().child(Button::new("save").primary().label("Save"))),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .pt_3()
                    .child(
                        Button::new("import-settings")
                            .outline()
                            .label("Import…")
                            .disabled(self.transfer_busy)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.transfer(true, window, cx)),
                            ),
                    )
                    .child(
                        Button::new("export-settings")
                            .outline()
                            .label("Export…")
                            .disabled(self.transfer_busy)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.transfer(false, window, cx)),
                            ),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use crate::{AppView, OpenSettings, settings::Settings};
    use gpui_kit::{
        App, AppContext, KeyBinding, TestAppContext, Window,
        component::Root,
        px, size,
        test::{TestAppContextExt, TestWindowExt},
    };

    fn fill(window: &mut Window, id: &'static str, value: &str, cx: &mut App) {
        window.click(id, cx);
        window.press("secondary-a", cx);
        window.input(value, cx);
    }

    #[gpui_kit::test]
    async fn settings_dialog_validates_saves_cancels_and_reports_errors(cx: &mut TestAppContext) {
        let directory =
            std::env::temp_dir().join(format!("base-app-ui-test-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("settings.json");
        Settings::default().save(&path).unwrap();
        let original = std::fs::read(&path).unwrap();
        cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_global(Settings::default());
        });
        let handle = cx.open_window(size(px(800.), px(600.)), |window, cx| {
            let view = cx.new(|_| AppView);
            Root::new(view, window, cx)
        });
        cx.update(|cx| {
            super::register_action(handle.into(), Some(path.clone()), None, cx);
            cx.bind_keys([KeyBinding::new("cmd-,", OpenSettings, None)]);
        });
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press("cmd-,", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let import = window.find("import-settings");
            let export = window.find("export-settings");
            assert_eq!(import.bounds().top(), export.bounds().top());
            assert!(import.bounds().top() > window.find("save").bounds().bottom());
            fill(window, "display-name", "Discarded", cx);
            window.click("export-settings", cx);
        })
        .unwrap();
        cx.run_until_parked();
        let backup = directory.join("backup.json");
        cx.simulate_new_path_selection(|_| Some(backup.clone()));
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| {
                window
                    .find("settings-transfer-status")
                    .label()
                    .unwrap()
                    .contains("exported")
            },
        )
        .await;
        assert_eq!(Settings::read(&backup).unwrap(), Settings::default());
        std::fs::write(&backup, r#"{"recent_items_limit":-1}"#).unwrap();
        cx.update_window(handle.into(), |_, window, cx| {
            window.click("import-settings", cx)
        })
        .unwrap();
        cx.run_until_parked();
        cx.simulate_path_prompt_response(|options| {
            assert!(options.files && !options.directories && !options.multiple);
            Some(vec![backup.clone()])
        });
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| {
                window
                    .find("settings-error")
                    .label()
                    .unwrap()
                    .contains("Couldn’t import")
            },
        )
        .await;
        cx.update_window(handle.into(), |_, window, _| {
            assert_eq!(window.find("display-name").value(), Some("Discarded"));
        })
        .unwrap();
        let imported = Settings {
            display_name: "Imported".into(),
            notifications_enabled: false,
            recent_items_limit: 5,
        };
        imported.save(&backup).unwrap();
        cx.update_window(handle.into(), |_, window, cx| {
            window.click("import-settings", cx)
        })
        .unwrap();
        cx.run_until_parked();
        cx.simulate_path_prompt_response(|_| Some(vec![backup.clone()]));
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| {
                window
                    .find("settings-transfer-status")
                    .label()
                    .unwrap()
                    .contains("imported")
            },
        )
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            assert_eq!(window.find("display-name").value(), Some("Imported"));
            assert_eq!(window.find("recent-items-limit").value(), Some("5"));
            assert_eq!(window.find("notifications-enabled").checked(), Some(false));
            assert_eq!(cx.global::<Settings>(), &Settings::default());
            assert_eq!(std::fs::read(&path).unwrap(), original);
            window.click("import-settings", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.simulate_path_prompt_response(|_| None);
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| window.find("import-settings").disabled() != Some(true),
        )
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            assert_eq!(window.find("display-name").value(), Some("Imported"));
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        cx.update_window(handle.into(), |_, window, cx| {
            window.dispatch_action(Box::new(OpenSettings), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            fill(window, "display-name", "Ada", cx);
            window.click("notifications-enabled", cx);
            fill(window, "recent-items-limit", "-1", cx);
            window.click("save", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(
                window
                    .find("settings-error")
                    .label()
                    .unwrap()
                    .contains("whole number")
            );
            assert_eq!(cx.global::<Settings>(), &Settings::default());
            fill(window, "recent-items-limit", "3", cx);
            std::fs::create_dir(
                path.with_file_name(format!(".settings-{}.tmp", std::process::id())),
            )
            .unwrap();
            window.click("save", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(
                window
                    .find("settings-error")
                    .label()
                    .unwrap()
                    .contains("Couldn’t save")
            );
            assert_eq!(cx.global::<Settings>(), &Settings::default());
            assert_eq!(std::fs::read(&path).unwrap(), original);
            std::fs::remove_dir(
                path.with_file_name(format!(".settings-{}.tmp", std::process::id())),
            )
            .unwrap();
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        let saved = Settings::load(&path).unwrap();
        assert_eq!(saved.display_name, "Ada");
        assert!(!saved.notifications_enabled);
        assert_eq!(saved.recent_items_limit, 3);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("save").is_none());
            assert_eq!(cx.global::<Settings>(), &saved);
            super::open(
                None,
                Some("Fix settings.json, then restart.".into()),
                window,
                cx,
            );
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("display-name").is_none());
            assert!(window.try_find("ok").is_some());
            assert!(
                window
                    .find("startup-error")
                    .label()
                    .unwrap()
                    .contains("Fix settings.json")
            );
        })
        .unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
EOF

cat > run.sh <<'EOF'
#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec rustup run stable cargo run -- "$@"
EOF
cat > build.sh <<'EOF'
#!/bin/sh
set -eu
cd "$(dirname "$0")"
EOF
printf 'app_name="%s"\n' "$app_name" >> build.sh
cat >> build.sh <<'EOF'

if [ "$(uname -s)" != Darwin ]; then
    printf '%s\n' 'build.sh requires macOS to create an .app bundle.' >&2
    exit 1
fi

host=$(rustup run stable rustc -vV | sed -n 's/^host: //p')
rustup run stable cargo build --release --target "$host" --target-dir target

bundle="target/release/$app_name.app"
identifier="local.$(printf '%s' "$app_name" | tr '_' '-')"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp "target/$host/release/$app_name" "$bundle/Contents/MacOS/$app_name.new"
mv "$bundle/Contents/MacOS/$app_name.new" "$bundle/Contents/MacOS/$app_name"
cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>$app_name</string>
<key>CFBundleDisplayName</key><string>$app_name</string>
<key>CFBundleIdentifier</key><string>$identifier</string>
<key>CFBundleExecutable</key><string>$app_name</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
plutil -lint "$bundle/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$bundle"
codesign --verify --deep --strict "$bundle"
printf 'Built %s\nOpen it with: open "%s"\n' "$bundle" "$bundle"
EOF
chmod +x run.sh build.sh
cat > .gitignore <<'EOF'
# Generated by Cargo
# will have compiled files and executables
debug
target

# These are backup files generated by rustfmt
**/*.rs.bk

# MSVC Windows builds of rustc generate these, which store debugging information
*.pdb

# Generated by cargo mutants
# Contains mutation testing data
**/mutants.out*/

# rustc will dump stack traces when hitting an internal compiler error to PWD
rustc-ice-*.txt

# RustRover
#  JetBrains specific template is maintained in a separate JetBrains.gitignore that can
#  be found at https://github.com/github/gitignore/blob/main/Global/JetBrains.gitignore
#  and can be added to the global gitignore or merged into this file.  For a more nuclear
#  option (not recommended) you can uncomment the following to ignore the entire idea folder.
#.idea/
.DS_Store
EOF
printf 'Created %s in %s. Run ./run.sh to open the app or ./build.sh to build a macOS .app bundle.\n' "$app_name" "$PWD"
