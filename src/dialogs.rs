use crate::{
    storage::{Authentication, QuickCommand, SshProfile},
    workspace::Workspace,
};
use anyhow::{Result, ensure};
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, Icon, IconName, IndexPath, Sizable, WindowExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        color_picker::{ColorPicker, ColorPickerEvent, ColorPickerState},
        dialog::{DialogAction, DialogFooter},
        form::{Field, Form},
        input::{Input, InputEvent, InputState, Textarea, TextareaState},
        menu::{DropdownMenu, PopupMenuItem},
        radio::Radio,
        select::{Select, SelectEvent, SelectState},
        table::{Table, TableBody, TableCell, TableHead, TableHeader, TableRow},
    },
    prelude::FluentBuilder,
    *,
};

fn input(
    value: &str,
    placeholder: &str,
    masked: bool,
    window: &mut Window,
    cx: &mut App,
) -> Entity<InputState> {
    cx.new(|cx| {
        let mut state = InputState::new(window, cx)
            .placeholder(placeholder.to_string())
            .masked(masked);
        state.set_value(value.to_string(), window, cx);
        state
    })
}

fn error(message: &Option<String>, cx: &App) -> AnyElement {
    div()
        .id("form-error")
        .test_support()
        .role(Role::Status)
        .aria_label(message.clone().unwrap_or_default())
        .text_sm()
        .text_color(cx.theme().danger)
        .children(message.clone())
        .into_any_element()
}

fn footer(label: &'static str, cancel: bool, busy: bool) -> DialogFooter {
    DialogFooter::new()
        .when(cancel, |footer| {
            footer.child(
                Button::new("cancel")
                    .label("Cancel")
                    .on_click(|_, window, cx| window.close_dialog(cx)),
            )
        })
        .child(DialogAction::new().child(Button::new("ok").primary().label(label).disabled(busy)))
}

pub(super) fn open_ssh(
    workspace: &Entity<Workspace>,
    profile: Option<SshProfile>,
    window: &mut Window,
    cx: &mut App,
) {
    let editing = profile.is_some();
    let owner = workspace.downgrade();
    let form = cx.new(|cx| SshForm::new(owner, profile.unwrap_or_default(), window, cx));
    let confirm = form.clone();
    window.open_dialog(cx, move |dialog, window, _| {
        let confirm = confirm.clone();
        dialog
            .title(if editing {
                "Edit SSH server"
            } else {
                "Add SSH server"
            })
            .width(window.rem_size() * 32.)
            .footer(footer("Save", true, false))
            .child(form.clone())
            .on_ok(move |_, _, cx| confirm.update(cx, |form, cx| form.save(cx)))
    });
}

struct SshForm {
    owner: WeakEntity<Workspace>,
    original: SshProfile,
    name: Entity<InputState>,
    host: Entity<InputState>,
    port: Entity<InputState>,
    username: Entity<InputState>,
    password: Entity<InputState>,
    key: Entity<InputState>,
    directory: Entity<InputState>,
    authentication: Authentication,
    icon: String,
    error: Option<String>,
}

impl SshForm {
    fn new(
        owner: WeakEntity<Workspace>,
        profile: SshProfile,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            name: input(&profile.name, "Production API", false, window, cx),
            host: input(&profile.host, "server.example.com", false, window, cx),
            port: input(&profile.port.to_string(), "22", false, window, cx),
            username: input(&profile.username, "root", false, window, cx),
            password: input(
                "",
                if profile.secret.is_some() {
                    "Leave blank to keep the saved password"
                } else {
                    "Password or key passphrase"
                },
                true,
                window,
                cx,
            ),
            key: input(
                &profile
                    .private_key
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                "Default SSH keys / agent",
                false,
                window,
                cx,
            ),
            directory: input(
                &profile.remote_directory,
                "Default remote directory",
                false,
                window,
                cx,
            ),
            authentication: profile.authentication,
            icon: profile.icon.clone(),
            owner,
            original: profile,
            error: None,
        }
    }

    fn save(&mut self, cx: &mut Context<Self>) -> bool {
        let result = (|| -> Result<()> {
            let mut profile = self.original.clone();
            profile.name = self.name.read(cx).value().trim().to_string();
            profile.icon = self.icon.clone();
            profile.host = self.host.read(cx).value().trim().to_string();
            profile.username = self.username.read(cx).value().trim().to_string();
            profile.port = self
                .port
                .read(cx)
                .value()
                .trim()
                .parse()
                .map_err(|_| anyhow::anyhow!("Port must be between 1 and 65535."))?;
            profile.authentication = self.authentication;
            profile.remote_directory = self.directory.read(cx).value().trim().to_string();
            let key = self.key.read(cx).value().trim().to_string();
            profile.private_key =
                if profile.authentication == Authentication::PrivateKey && !key.is_empty() {
                    Some(expand_home(&key))
                } else {
                    None
                };
            if let Some(path) = &profile.private_key {
                ensure!(path.is_file(), "Choose an existing private key file.");
            }
            if profile.authentication != self.original.authentication {
                profile.secret = None;
            }
            profile.validate()?;
            let password = self.password.read(cx).value().to_string();
            ensure!(
                !password.contains(['\0', '\n', '\r']),
                "Password must not contain line breaks."
            );
            let owner = self
                .owner
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("The workspace was closed."))?;
            let store = owner
                .read(cx)
                .store
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Application storage is unavailable."))?;
            if !password.is_empty() {
                profile.secret = Some(store.encrypt(&profile.id, &password)?);
            }
            ensure!(
                profile.authentication != Authentication::Password || profile.secret.is_some(),
                "Enter a password for password authentication."
            );
            owner.update(cx, |view, cx| {
                let mut settings = view.settings.clone();
                if let Some(existing) = settings
                    .ssh_servers
                    .iter_mut()
                    .find(|existing| existing.id == profile.id)
                {
                    *existing = profile;
                } else {
                    settings.ssh_servers.push(profile);
                }
                view.save_settings(settings, cx)
            })?;
            Ok(())
        })();
        self.error = result.as_ref().err().map(|error| format!("{error:#}"));
        cx.notify();
        result.is_ok()
    }

    fn choose_key(&mut self, _: &ClickEvent, window: &mut Window, cx: &mut Context<Self>) {
        let picker = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose private key".into()),
        });
        cx.spawn_in(window, async move |this, cx| match picker.await {
            Ok(Ok(Some(paths))) => {
                if let Some(path) = paths.first() {
                    let _ = this.update_in(cx, |form, window, cx| {
                        form.key.update(cx, |input, cx| {
                            input.set_value(path.to_string_lossy().into_owned(), window, cx)
                        })
                    });
                }
            }
            Ok(Err(error)) => {
                let _ = this.update(cx, |form, cx| {
                    form.error = Some(format!("Couldn’t choose a key: {error}"));
                    cx.notify();
                });
            }
            _ => {}
        })
        .detach();
    }
}

fn expand_home(path: &str) -> std::path::PathBuf {
    path.strip_prefix("~/")
        .and_then(|path| std::env::home_dir().map(|home| home.join(path)))
        .unwrap_or_else(|| path.into())
}

impl Render for SshForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut form = Form::new()
            .columns(2)
            .child(
                Field::new().label("Connection name").col_span(2).child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(
                            Button::new("ssh-icon-selector")
                                .outline()
                                .accessibility_label(format!("Server icon: {}", self.icon))
                                .tooltip("Choose server icon")
                                .child(crate::ssh_icons::image(&self.icon).size_5())
                                .dropdown_menu({
                                    let owner = cx.entity().downgrade();
                                    let selected = self.icon.clone();
                                    move |mut menu, window, _| {
                                        menu = menu
                                            .min_w(window.rem_size() * 14.)
                                            .max_h(window.rem_size() * 18.)
                                            .scrollable(true);
                                        for &(name, _) in crate::ssh_icons::ICONS {
                                            let owner = owner.clone();
                                            menu = menu.item(
                                                PopupMenuItem::element(move |_, _| {
                                                    div()
                                                        .id(SharedString::from(format!(
                                                            "ssh-icon-{name}"
                                                        )))
                                                        .test_support()
                                                        .role(Role::MenuItem)
                                                        .aria_label(name)
                                                        .flex()
                                                        .items_center()
                                                        .gap_2()
                                                        .py_1()
                                                        .child(
                                                            crate::ssh_icons::image(name).size_5(),
                                                        )
                                                        .child(name.replace('-', " "))
                                                })
                                                .checked(name == selected)
                                                .on_click(move |_, _, cx| {
                                                    let _ = owner.update(cx, |form, cx| {
                                                        form.icon = name.into();
                                                        cx.notify();
                                                    });
                                                }),
                                            );
                                        }
                                        menu
                                    }
                                }),
                        )
                        .child(Input::new(&self.name).id("ssh-name").flex_1()),
                ),
            )
            .child(
                Field::new()
                    .label("Host")
                    .child(Input::new(&self.host).id("ssh-host")),
            )
            .child(
                Field::new()
                    .label("Port")
                    .child(Input::new(&self.port).id("ssh-port")),
            )
            .child(
                Field::new()
                    .label("Username")
                    .col_span(2)
                    .child(Input::new(&self.username).id("ssh-username")),
            )
            .child(
                Field::new().label("Authentication").col_span(2).child(
                    div()
                        .flex()
                        .gap_4()
                        .child(
                            Radio::new("ssh-private-key")
                                .label("Private key")
                                .checked(self.authentication == Authentication::PrivateKey)
                                .on_change(cx.listener(|form, _, _, cx| {
                                    form.authentication = Authentication::PrivateKey;
                                    cx.notify();
                                })),
                        )
                        .child(
                            Radio::new("ssh-password-auth")
                                .label("Password")
                                .checked(self.authentication == Authentication::Password)
                                .on_change(cx.listener(|form, _, _, cx| {
                                    form.authentication = Authentication::Password;
                                    cx.notify();
                                })),
                        ),
                ),
            );
        if self.authentication == Authentication::PrivateKey {
            form = form.child(
                Field::new()
                    .label("Private key file")
                    .col_span(2)
                    .description("Leave blank to use your SSH agent or default keys.")
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(Input::new(&self.key).id("ssh-key").flex_1())
                            .child(
                                Button::new("choose-ssh-key")
                                    .label("Browse…")
                                    .on_click(cx.listener(Self::choose_key)),
                            ),
                    ),
            );
        }
        form = form
            .child(
                Field::new()
                    .label(if self.authentication == Authentication::Password {
                        "Password"
                    } else {
                        "Key passphrase (optional)"
                    })
                    .col_span(2)
                    .description(
                        if self.original.secret.is_some()
                            && self.original.authentication == self.authentication
                        {
                            "Leave blank to keep the saved credential."
                        } else {
                            "Saved credentials are encrypted."
                        },
                    )
                    .child(Input::new(&self.password).id("ssh-password")),
            )
            .child(
                Field::new()
                    .label("Remote directory (optional)")
                    .col_span(2)
                    .child(Input::new(&self.directory).id("ssh-directory")),
            );
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(form)
            .child(error(&self.error, cx))
    }
}

pub(super) fn open_settings(workspace: &Entity<Workspace>, window: &mut Window, cx: &mut App) {
    let settings = workspace.read(cx).settings.clone();
    let owner = workspace.downgrade();
    let form = cx.new(|cx| SettingsForm::new(owner, settings, window, cx));
    window.open_dialog(cx, move |dialog, window, cx| {
        let confirm = form.clone();
        dialog
            .title(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child("Settings")
                    .child(form.update(cx, |form, cx| form.tabs(cx))),
            )
            .width(window.rem_size() * 50.)
            .footer(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .when_some(form.read(cx).error.clone(), |view, message| {
                        view.child(error(&Some(message), cx))
                    })
                    .when(form.read(cx).tab != 2, |view| {
                        view.child(footer("Save", true, form.read(cx).backup_busy))
                    }),
            )
            .child(form.clone())
            .on_ok(move |_, _, cx| confirm.update(cx, |form, cx| form.save(cx)))
    });
}

type Choice = Entity<SelectState<Vec<SharedString>>>;

fn choice(values: Vec<SharedString>, selected: &str, window: &mut Window, cx: &mut App) -> Choice {
    let ix = values
        .iter()
        .position(|value| value.as_ref() == selected)
        .unwrap_or(0);
    cx.new(|cx| SelectState::new(values, Some(IndexPath::new(ix)), window, cx))
}

struct SettingsForm {
    owner: WeakEntity<Workspace>,
    initial: crate::storage::Settings,
    tab: usize,
    restore: bool,
    blink: bool,
    directory: Entity<InputState>,
    family: Choice,
    scheme: Choice,
    weight: Choice,
    cursor: Choice,
    size: Entity<InputState>,
    line_height: Entity<InputState>,
    cursor_width: Entity<InputState>,
    cursor_color: Entity<ColorPickerState>,
    selection_color: Entity<ColorPickerState>,
    cursor_color_mode: Choice,
    selection_color_mode: Choice,
    cursor_color_custom: bool,
    selection_color_custom: bool,
    error: Option<String>,
    backup_busy: bool,
    backup_status: Option<String>,
    quick_commands: Vec<QuickCommandForm>,
    new_quick_command: QuickCommandForm,
    _subscriptions: Vec<Subscription>,
}

struct QuickCommandForm {
    id: String,
    name: Entity<InputState>,
    command: Entity<TextareaState>,
    editing: bool,
}

impl QuickCommandForm {
    fn new(command: &QuickCommand, window: &mut Window, cx: &mut App) -> Self {
        Self {
            id: command.id.clone(),
            name: input(&command.name, "Restart API", false, window, cx),
            command: cx.new(|cx| {
                let mut state = TextareaState::new(window, cx).placeholder("npm run dev");
                state.set_value(command.command.clone(), window, cx);
                state
            }),
            editing: false,
        }
    }

    fn empty(window: &mut Window, cx: &mut App) -> Self {
        Self::new(
            &QuickCommand {
                id: uuid::Uuid::new_v4().to_string(),
                name: String::new(),
                command: String::new(),
            },
            window,
            cx,
        )
    }

    fn value(&self, cx: &App) -> QuickCommand {
        QuickCommand {
            id: self.id.clone(),
            name: self.name.read(cx).value().trim().to_string(),
            command: self.command.read(cx).value().to_string(),
        }
    }
}

impl SettingsForm {
    fn new(
        owner: WeakEntity<Workspace>,
        settings: crate::storage::Settings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        use crate::appearance::{Cursor, FONTS, SCHEMES};
        let appearance = &settings.appearance;
        let palette = appearance.palette();
        let mut fonts: Vec<SharedString> = FONTS.into_iter().map(Into::into).collect();
        if !FONTS.contains(&settings.font_family.as_str()) {
            fonts.push(settings.font_family.clone().into());
        }
        let mut form = Self {
            owner,
            tab: 0,
            restore: settings.restore_session,
            blink: appearance.cursor_blink,
            directory: input(
                &settings
                    .default_directory
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                "Home directory",
                false,
                window,
                cx,
            ),
            family: choice(fonts, &settings.font_family, window, cx),
            scheme: choice(
                SCHEMES.iter().map(|s| s.name.into()).collect(),
                SCHEMES
                    .iter()
                    .find(|s| s.id == appearance.scheme)
                    .unwrap_or(&SCHEMES[0])
                    .name,
                window,
                cx,
            ),
            weight: choice(
                ["300", "400", "500", "600", "700"]
                    .into_iter()
                    .map(Into::into)
                    .collect(),
                &appearance.font_weight.to_string(),
                window,
                cx,
            ),
            cursor: choice(
                ["Bar", "Block", "Underline"]
                    .into_iter()
                    .map(Into::into)
                    .collect(),
                match appearance.cursor_shape {
                    Cursor::Bar => "Bar",
                    Cursor::Block => "Block",
                    Cursor::Underline => "Underline",
                },
                window,
                cx,
            ),
            size: input(&settings.font_size.to_string(), "14", false, window, cx),
            line_height: input(
                &appearance.line_height.to_string(),
                "1.35",
                false,
                window,
                cx,
            ),
            cursor_width: input(&appearance.cursor_width.to_string(), "2", false, window, cx),
            cursor_color: cx.new(|cx| {
                ColorPickerState::new(window, cx)
                    .default_value(crate::hsla_color(palette.cursor_bg))
            }),
            selection_color: cx.new(|cx| {
                ColorPickerState::new(window, cx)
                    .default_value(crate::hsla_color(palette.selection_bg))
            }),
            cursor_color_mode: choice(
                ["Use palette default", "Use custom color"]
                    .into_iter()
                    .map(Into::into)
                    .collect(),
                if appearance.cursor_color.is_some() {
                    "Use custom color"
                } else {
                    "Use palette default"
                },
                window,
                cx,
            ),
            selection_color_mode: choice(
                ["Use palette default", "Use custom color"]
                    .into_iter()
                    .map(Into::into)
                    .collect(),
                if appearance.selection_color.is_some() {
                    "Use custom color"
                } else {
                    "Use palette default"
                },
                window,
                cx,
            ),
            cursor_color_custom: appearance.cursor_color.is_some(),
            selection_color_custom: appearance.selection_color.is_some(),
            quick_commands: settings
                .quick_commands
                .iter()
                .map(|command| QuickCommandForm::new(command, window, cx))
                .collect(),
            new_quick_command: QuickCommandForm::empty(window, cx),
            initial: settings,
            error: None,
            backup_busy: false,
            backup_status: None,
            _subscriptions: vec![],
        };
        for state in [&form.size, &form.line_height, &form.cursor_width] {
            form._subscriptions
                .push(cx.subscribe(state, |_, _, _: &InputEvent, cx| cx.notify()));
        }
        for state in [&form.family, &form.scheme, &form.weight, &form.cursor] {
            form._subscriptions.push(
                cx.subscribe(state, |_, _, _: &SelectEvent<Vec<SharedString>>, cx| {
                    cx.notify()
                }),
            );
        }
        for (mode, is_cursor) in [
            (&form.cursor_color_mode, true),
            (&form.selection_color_mode, false),
        ] {
            form._subscriptions.push(cx.subscribe_in(
                mode,
                window,
                move |form, _, event: &SelectEvent<Vec<SharedString>>, window, cx| {
                    let SelectEvent::Confirm(value) = event;
                    let custom = value
                        .as_ref()
                        .is_some_and(|v| v.as_ref() == "Use custom color");
                    let previous = if is_cursor {
                        &mut form.cursor_color_custom
                    } else {
                        &mut form.selection_color_custom
                    };
                    let changed = *previous != custom;
                    *previous = custom;
                    cx.notify();
                    if !changed || !custom {
                        return;
                    }
                    let mut appearance = form.initial.appearance.clone();
                    appearance.scheme = SCHEMES
                        .iter()
                        .find(|s| {
                            form.scheme
                                .read(cx)
                                .selected_value()
                                .is_some_and(|v| v.as_ref() == s.name)
                        })
                        .unwrap_or(&SCHEMES[0])
                        .id
                        .into();
                    appearance.cursor_color = None;
                    appearance.selection_color = None;
                    let palette = appearance.palette();
                    let state = if is_cursor {
                        &form.cursor_color
                    } else {
                        &form.selection_color
                    };
                    state.update(cx, |state, cx| {
                        state.set_value(
                            crate::hsla_color(if is_cursor {
                                palette.cursor_bg
                            } else {
                                palette.selection_bg
                            }),
                            window,
                            cx,
                        )
                    });
                    cx.notify();
                },
            ));
        }
        for state in [&form.cursor_color, &form.selection_color] {
            form._subscriptions
                .push(cx.subscribe(state, |_, _, _: &ColorPickerEvent, cx| cx.notify()));
        }
        form
    }

    fn draft(&self, cx: &App) -> Result<crate::storage::Settings> {
        use crate::appearance::{Cursor, SCHEMES};
        let selected =
            |state: &Choice| state.read(cx).selected_value().cloned().unwrap_or_default();
        let number = |state: &Entity<InputState>, label: &str| -> Result<f32> {
            state
                .read(cx)
                .value()
                .trim()
                .parse()
                .map_err(|_| anyhow::anyhow!("Enter a number for {label}."))
        };
        let optional_color = |state: &Entity<ColorPickerState>, custom: bool| {
            if !custom {
                return None;
            }
            state.read(cx).value().map(|color| {
                let rgba = Rgba::from(color);
                let channel = |v: f32| (v * 255.).round() as u8;
                let rgb = format!(
                    "#{:02x}{:02x}{:02x}",
                    channel(rgba.r),
                    channel(rgba.g),
                    channel(rgba.b)
                );
                if rgba.a < 1. {
                    format!("{rgb}{:02x}", channel(rgba.a))
                } else {
                    rgb
                }
            })
        };
        let mut settings = self.initial.clone();
        settings.font_family = selected(&self.family).to_string();
        settings.font_size = number(&self.size, "font size")?;
        settings.appearance.scheme = SCHEMES
            .iter()
            .find(|s| s.name == selected(&self.scheme).as_ref())
            .unwrap_or(&SCHEMES[0])
            .id
            .into();
        settings.appearance.font_weight = selected(&self.weight).parse()?;
        settings.appearance.line_height = number(&self.line_height, "line height")?;
        settings.appearance.cursor_width = number(&self.cursor_width, "cursor width")?;
        settings.appearance.cursor_shape = match selected(&self.cursor).as_ref() {
            "Block" => Cursor::Block,
            "Underline" => Cursor::Underline,
            _ => Cursor::Bar,
        };
        settings.appearance.cursor_blink = self.blink;
        settings.appearance.cursor_color =
            optional_color(&self.cursor_color, self.cursor_color_custom);
        settings.appearance.selection_color =
            optional_color(&self.selection_color, self.selection_color_custom);
        settings.validate()?;
        Ok(settings)
    }

    fn save(&mut self, cx: &mut Context<Self>) -> bool {
        if self.backup_busy || self.tab == 2 {
            return false;
        }
        let result = (|| -> Result<()> {
            let owner = self
                .owner
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("The workspace was closed."))?;
            let mut settings = self.draft(cx).inspect_err(|error| {
                let message = error.to_string().to_lowercase();
                self.tab = usize::from(
                    !message.contains("line height") && !message.contains("cursor width"),
                );
            })?;
            settings.quick_commands = owner.read(cx).settings.quick_commands.clone();
            // Merge with current profiles rather than overwriting changes from another dialog.
            settings.ssh_servers = owner.read(cx).settings.ssh_servers.clone();
            settings.restore_session = self.restore;
            let directory = self.directory.read(cx).value().trim().to_string();
            settings.default_directory = if directory.is_empty() {
                None
            } else {
                let path = expand_home(&directory);
                if !path.is_dir() {
                    self.tab = 0;
                    anyhow::bail!("Choose an existing default directory.");
                }
                Some(path)
            };
            owner.update(cx, |view, cx| view.save_settings(settings, cx))
        })();
        self.error = result.as_ref().err().map(|error| format!("{error:#}"));
        cx.notify();
        result.is_ok()
    }

    fn save_quick_command(
        &mut self,
        id: &str,
        value: Option<QuickCommand>,
        cx: &mut Context<Self>,
    ) -> bool {
        let result = (|| -> Result<()> {
            let owner = self
                .owner
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("The workspace was closed."))?;
            let mut settings = owner.read(cx).settings.clone();
            if let Some(value) = value {
                if let Some(command) = settings
                    .quick_commands
                    .iter_mut()
                    .find(|command| command.id == id)
                {
                    *command = value;
                } else {
                    settings.quick_commands.push(value);
                }
            } else {
                settings.quick_commands.retain(|command| command.id != id);
            }
            owner.update(cx, |view, cx| view.save_settings(settings, cx))
        })();
        self.error = result.as_ref().err().map(|error| format!("{error:#}"));
        cx.notify();
        result.is_ok()
    }

    fn transfer_settings(&mut self, importing: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.backup_busy {
            return;
        }
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        let settings = owner.read(cx).settings.clone();
        let picker: Task<Result<Option<std::path::PathBuf>>> = if importing {
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
            let picker = cx.prompt_for_new_path(&directory, Some("terminalflow-settings.json"));
            cx.background_spawn(async move { picker.await? })
        };
        self.backup_busy = true;
        self.backup_status = None;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result: Result<Option<crate::storage::Settings>> = async {
                let Some(path) = picker.await? else {
                    return Ok(None);
                };
                let settings = cx
                    .background_spawn(async move {
                        if importing {
                            crate::storage::Settings::read_backup(&path)
                        } else {
                            settings.write_backup(&path)?;
                            Ok(settings)
                        }
                    })
                    .await?;
                Ok(Some(settings))
            }
            .await;
            let _ = this.update_in(cx, |form, window, cx| {
                form.backup_busy = false;
                let result = result.and_then(|settings| {
                    let Some(settings) = settings else {
                        return Ok(());
                    };
                    if importing {
                        owner.update(cx, |view, cx| view.save_settings(settings.clone(), cx))?;
                        *form = Self::new(form.owner.clone(), settings, window, cx);
                    }
                    form.backup_status = Some(
                        if importing {
                            "Settings imported."
                        } else {
                            "Settings exported."
                        }
                        .into(),
                    );
                    Ok(())
                });
                form.error = result.err().map(|error| {
                    format!(
                        "Couldn’t {} settings: {error:#}",
                        if importing { "import" } else { "export" }
                    )
                });
                cx.notify();
            });
        })
        .detach();
    }

    fn preview(
        &self,
        settings: &crate::storage::Settings,
        compact: bool,
        window: &Window,
        cx: &App,
    ) -> AnyElement {
        let palette = settings.appearance.palette();
        let mut preview_font = font(settings.font_family.clone());
        preview_font.weight = FontWeight(settings.appearance.font_weight as f32);
        let size = if compact {
            settings.font_size.min(14.)
        } else {
            settings.font_size
        };
        let font_size = window.rem_size() * (size / 16.);
        let cell_width = window
            .text_system()
            .advance(
                window.text_system().resolve_font(&preview_font),
                font_size,
                'M',
            )
            .map(|advance| advance.width)
            .unwrap_or(font_size * 0.6);
        let cell_height = font_size * settings.appearance.line_height;
        let cursor = match settings.appearance.cursor_shape {
            crate::appearance::Cursor::Block => div().w(cell_width).h(cell_height),
            crate::appearance::Cursor::Underline => div().w(cell_width).h(px(2.)),
            crate::appearance::Cursor::Bar => div()
                .w(px(settings.appearance.cursor_width).min(cell_width))
                .h(cell_height),
        }
        .bg(crate::hsla_color(palette.cursor_bg));
        let cursor = if !compact && settings.appearance.cursor_blink && !cx.reduce_motion() {
            cursor
                .with_animation(
                    "preview-cursor",
                    Animation::new(std::time::Duration::from_secs(1))
                        .repeat()
                        .with_max_fps(2.),
                    |cursor, delta| cursor.opacity(if delta < 0.5 { 1. } else { 0. }),
                )
                .into_any_element()
        } else {
            cursor.into_any_element()
        };
        div()
            .id(if compact {
                "scheme-preview"
            } else {
                "appearance-preview"
            })
            .test_support()
            .role(Role::Group)
            .aria_label("Terminal preview")
            // Toolbar, padding and two gaps, followed by three terminal rows.
            .h(window.rem_size() * 3.75 + cell_height * 3.)
            .flex_shrink_0()
            .overflow_hidden()
            .rounded(cx.theme().radius_tokens().md)
            .bg(crate::hsla_color(palette.background))
            .text_color(crate::hsla_color(palette.foreground))
            .child(
                div()
                    .flex()
                    .gap_1p5()
                    .px_3()
                    .h_7()
                    .items_center()
                    .bg(crate::hsla_color(palette.foreground).opacity(0.06))
                    .children((0..3).map(|_| {
                        div()
                            .size_2()
                            .rounded_full()
                            .bg(crate::hsla_color(palette.foreground).opacity(0.3))
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .p_3()
                    .font(preview_font)
                    .text_size(font_size)
                    .line_height(rems(size / 16. * settings.appearance.line_height))
                    .child(
                        div().flex().gap_2().child("you@terminal").child(
                            div()
                                .text_color(crate::hsla_color(palette.colors.0[4]))
                                .child(if compact { "~/app" } else { "~/project" }),
                        ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_end()
                            .child("$ npm run dev")
                            .child(cursor),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .child(
                                div()
                                    .text_color(crate::hsla_color(palette.foreground).opacity(0.6))
                                    .child(if compact { "vite" } else { "watching" }),
                            )
                            .child(
                                div()
                                    .bg(crate::hsla_color(palette.selection_bg))
                                    .text_color(crate::hsla_color(palette.selection_fg))
                                    .child(if compact {
                                        "ready in 420ms"
                                    } else {
                                        "for changes"
                                    }),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn tabs(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("settings-tabs")
            .flex()
            .gap_2()
            .pb_2()
            .border_b_1()
            .border_color(rgb(0x444444))
            .role(Role::TabList)
            .aria_label("Settings sections")
            .children(
                [
                    (
                        0,
                        "settings-general",
                        "General",
                        gpui_kit::assets::IconName::Settings,
                    ),
                    (
                        1,
                        "settings-appearance",
                        "Appearance",
                        gpui_kit::assets::IconName::Palette,
                    ),
                    (
                        2,
                        "settings-quick-commands",
                        "Quick Commands",
                        gpui_kit::assets::IconName::Play,
                    ),
                ]
                .map(|(ix, id, label, icon)| {
                    gpui_kit::base::Button::new(id)
                        .role(Role::Tab)
                        .aria_selected(self.tab == ix)
                        .accessibility_label(label)
                        .selected(self.tab == ix)
                        .h_8()
                        .gap_2()
                        .px_3()
                        .text_sm()
                        .font_weight(FontWeight::NORMAL)
                        .rounded(cx.theme().radius_tokens().md)
                        .border_1()
                        .border_color(cx.theme().transparent)
                        .text_color(cx.theme().foreground)
                        .styles(|styles| styles.selected(|style| style.bg(cx.theme().muted)))
                        .hover(|style| style.bg(cx.theme().muted))
                        .focus_visible(|style| style.border_color(cx.theme().primary))
                        .child(Icon::new(icon).size_4())
                        .child(label)
                        .on_click(cx.listener(move |form, _, _, cx| {
                            form.tab = ix;
                            cx.notify();
                        }))
                }),
            )
            .into_any_element()
    }

    fn quick_commands(&self, cx: &mut Context<Self>) -> AnyElement {
        use gpui_kit::assets::IconName as AssetIcon;
        let cell = || TableCell::new().flex_1().min_w_0().p_3();
        let heading = |title: &'static str| {
            div()
                .id(title)
                .role(Role::Label)
                .aria_label(title)
                .child(title)
        };
        let actions = || {
            TableCell::new()
                .w_24()
                .min_w_0()
                .flex_shrink_0()
                .p_3()
                .text_right()
        };
        div()
            .flex()
            .flex_col()
            .gap_4()
            .w_full()
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("Run commands from Cmd/Ctrl-P. Use $ to insert without pressing Enter and place the cursor at the marker."),
            )
            .child(
                Table::new()
                    .accessibility_label("Quick commands")
                    .rounded(cx.theme().radius_tokens().lg)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(TableHeader::new().text_color(cx.theme().muted_foreground).child(
                        TableRow::new()
                            .child(TableHead::new().flex_1().min_w_0().p_3().child(heading("Title")))
                            .child(TableHead::new().flex_1().min_w_0().p_3().child(heading("Command")))
                            .child(TableHead::new().w_24().min_w_0().flex_shrink_0().p_3().text_right().child(heading("Actions"))),
                    ))
                    .child(
                        TableBody::new()
                            .child(
                                TableRow::new()
                                    .child(cell().child(
                                        Input::new(&self.new_quick_command.name)
                                            .id("new-quick-command-name")
                                            .aria_label("New quick command title")
                                            .w_full(),
                                    ))
                                    .child(cell().child(
                                        Textarea::new(&self.new_quick_command.command)
                                            .accessibility_id("new-quick-command-text")
                                            .aria_label("New shell command")
                                            .font_family(cx.theme().mono_font_family.clone())
                                            .h_10()
                                            .w_full(),
                                    ))
                                    .child(actions().child(
                                        Button::new("add-quick-command")
                                            .outline()
                                            .icon(AssetIcon::CirclePlus)
                                            .label("Add")
                                            .disabled(self.backup_busy)
                                            .on_click(cx.listener(|form, _, window, cx| {
                                                let value = form.new_quick_command.value(cx);
                                                let id = value.id.clone();
                                                if form.save_quick_command(&id, Some(value), cx) {
                                                    let command = std::mem::replace(
                                                        &mut form.new_quick_command,
                                                        QuickCommandForm::empty(window, cx),
                                                    );
                                                    form.quick_commands.push(command);
                                                    form.error = None;
                                                    form.new_quick_command.name.update(cx, |state, cx| state.focus(window, cx));
                                                }
                                                cx.notify();
                                            })),
                                    )),
                            )
                            .children(self.quick_commands.iter().map(|command| {
                                let id = command.id.clone();
                                let edit_id = id.clone();
                                let value = command.value(cx);
                                TableRow::new()
                                    .child(cell().when_else(command.editing,
                                        |cell| cell.child(
                                            Input::new(&command.name)
                                                .id(SharedString::from(format!("quick-command-name-{id}")))
                                                .aria_label("Quick command title")
                                                .w_full(),
                                        ),
                                        |cell| cell.child(
                                            div().id(SharedString::from(format!("quick-command-title-{id}")))
                                                .test_support().role(Role::Label).aria_label(value.name.clone())
                                                .w_full().truncate().font_weight(FontWeight::SEMIBOLD)
                                                .child(value.name.clone()),
                                        ),
                                    ))
                                    .child(cell().when_else(command.editing,
                                        |cell| cell.child(
                                            Textarea::new(&command.command)
                                                .accessibility_id(SharedString::from(format!("quick-command-text-{id}")))
                                                .aria_label("Shell command")
                                                .font_family(cx.theme().mono_font_family.clone())
                                                .h_24().w_full(),
                                        ),
                                        |cell| cell.child(
                                            div().id(SharedString::from(format!("quick-command-value-{id}")))
                                                .test_support().role(Role::Label).aria_label(value.command.clone())
                                                .w_full().truncate().font_family(cx.theme().mono_font_family.clone())
                                                .child(value.command.replace('\n', " ↵ ")),
                                        ),
                                    ))
                                    .child(actions().child(
                                        div().flex().items_center().gap_2()
                                            .child(
                                                Button::new(SharedString::from(format!("edit-quick-command-{id}")))
                                                    .outline()
                                                    .icon(if command.editing { AssetIcon::Check } else { AssetIcon::Pencil })
                                                    .accessibility_label(format!("{} quick command {}", if command.editing { "Finish editing" } else { "Edit" }, value.name))
                                                    .tooltip(if command.editing { "Done" } else { "Edit" })
                                                    .disabled(self.backup_busy)
                                                    .on_click(cx.listener(move |form, _, window, cx| {
                                                        if let Some(ix) = form.quick_commands.iter().position(|command| command.id == edit_id) {
                                                            if form.quick_commands[ix].editing {
                                                                let value = form.quick_commands[ix].value(cx);
                                                                if !form.save_quick_command(&edit_id, Some(value), cx) {
                                                                    return;
                                                                }
                                                            }
                                                            let command = &mut form.quick_commands[ix];
                                                            command.editing = !command.editing;
                                                            form.error = None;
                                                            if command.editing {
                                                                let name = command.name.clone();
                                                                window.on_next_frame(move |window, cx| {
                                                                    name.update(cx, |state, cx| state.focus(window, cx));
                                                                });
                                                            } else {
                                                                form.new_quick_command.name.update(cx, |state, cx| state.focus(window, cx));
                                                            }
                                                        }
                                                        cx.notify();
                                                    })),
                                            )
                                            .child(
                                                Button::new(SharedString::from(format!("delete-quick-command-{id}")))
                                                    .danger()
                                                    .outline()
                                                    .icon(AssetIcon::Trash)
                                                    .accessibility_label(format!("Delete quick command {}", value.name))
                                                    .tooltip("Delete")
                                                    .disabled(self.backup_busy)
                                                    .on_click(cx.listener(move |form, _, window, cx| {
                                                        if !form.save_quick_command(&id, None, cx) {
                                                            return;
                                                        }
                                                        form.quick_commands.retain(|command| command.id != id);
                                                        form.error = None;
                                                        form.new_quick_command.name.update(cx, |state, cx| state.focus(window, cx));
                                                        cx.notify();
                                                    })),
                                            ),
                                    ))
                            })),
                    ),
            )
            .when(self.quick_commands.is_empty(), |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child("No quick commands yet. Enter a title and command above, then choose Add."),
                )
            })
            .into_any_element()
    }

    fn appearance(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let settings = self.draft(cx).unwrap_or_else(|_| self.initial.clone());
        let mut palette_defaults = settings.appearance.clone();
        palette_defaults.cursor_color = None;
        palette_defaults.selection_color = None;
        let palette = palette_defaults.palette();
        let preview_height = window.rem_size()
            * (3.75 + settings.font_size.min(14.) / 16. * settings.appearance.line_height * 3.);
        // Definite card height avoids recursively measuring every preview for grid track sizing.
        // The remaining height is padding, header, swatches, gaps and the border.
        let card_height = preview_height + window.rem_size() * 5.625 + px(2.);
        div().flex().flex_col().gap_5().w_full()
            .child(div().flex().flex_col().gap_3()
                .child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child("Typography"))
                .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Choose a font and tune the terminal text. Preview changes before saving."))
                .child(Form::new().columns(3)
                    .child(Field::new().label("Font").child(Select::new(&self.family).id("settings-font").accessibility_label("Font family").w_full()))
                    .child(Field::new().label("Font size").description("10–32 px").child(Input::new(&self.size).id("settings-font-size").aria_label("Font size")))
                    .child(Field::new().label("Font weight").child(Select::new(&self.weight).id("settings-font-weight").accessibility_label("Font weight").w_full())))
                .child(self.preview(&settings, false, window, cx)))
            .child(div().flex().flex_col().gap_3()
                .child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child("Cursor and selection"))
                .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Keep palette defaults or pin the cursor and text selection to custom colors."))
                .child(Form::new().columns(2).children([
                    ("Cursor", "settings-cursor-color", "settings-cursor-color-mode", &self.cursor_color, &self.cursor_color_mode, self.cursor_color_custom, palette.cursor_bg),
                    ("Selection", "settings-selection-color", "settings-selection-color-mode", &self.selection_color, &self.selection_color_mode, self.selection_color_custom, palette.selection_bg),
                ].map(|(label, id, mode_id, state, mode, custom, default)| {
                    Field::new().label(label).child(div().flex().items_center().gap_2()
                        .child(div().id(id).test_support().when_else(custom,
                            |view| view.child(ColorPicker::new(state).accessibility_label(format!("{label} color"))),
                            |view| view.child(Button::new("palette-color").disabled(true).accessibility_label(format!("{label} palette color")).child(div().size_5().rounded_sm().bg(crate::hsla_color(default))))))
                        .child(Select::new(mode).id(mode_id).accessibility_label(format!("{label} color source")).w_full()))
                }))))
            .child(div().flex().flex_col().gap_3()
                .child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child("Color scheme"))
                .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Choose the palette used by every terminal pane. Save applies changes to all open panes."))
                .child(div().grid().grid_cols(if window.viewport_size().width < window.rem_size() * 40. { 1 } else { 2 }).gap_3()
                    .children(crate::appearance::SCHEMES.iter().map(|scheme| {
                        let selected = settings.appearance.scheme == scheme.id;
                        let mut preview = settings.clone();
                        preview.appearance.scheme = scheme.id.into();
                        let palette = preview.appearance.palette();
                        gpui_kit::base::Button::new(SharedString::from(format!("scheme-{}", scheme.id)))
                            .accessibility_label(scheme.name).aria_toggled(if selected { Toggled::True } else { Toggled::False }).selected(selected)
                            .flex().flex_col().items_stretch().gap_3().p_3().w_full().min_w_0().h(card_height).flex_shrink_0()
                            .rounded(cx.theme().radius_tokens().lg).border_1()
                            .border_color(if selected { cx.theme().primary } else { cx.theme().border })
                            .bg(if selected { cx.theme().muted } else { cx.theme().background })
                            .text_color(cx.theme().foreground).hover(|style| style.bg(cx.theme().muted))
                            .focus_visible(|style| style.border_color(cx.theme().primary))
                            .child(div().flex().justify_between().items_center().gap_2()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(scheme.name))
                                .child(div().size_5().flex().items_center().justify_center().rounded_full().border_1()
                                    .border_color(if selected { cx.theme().primary } else { cx.theme().border })
                                    .when(selected, |view| view.text_color(cx.theme().primary).child(Icon::new(IconName::Check).size_3()))))
                            .child(self.preview(&preview, true, window, cx))
                            .child(div().flex().gap_2().children([1, 3, 2, 4, 5, 6].map(|ix| div().flex_1().h_2p5().rounded_sm().bg(crate::hsla_color(palette.colors.0[ix])))))
                            .on_click(cx.listener(move |form, _, window, cx| {
                                form.scheme.update(cx, |state, cx| state.set_selected_value(&SharedString::from(scheme.name), window, cx));
                                cx.notify();
                            }))
                    }))))
            .child(Button::new("reset-appearance").ghost().label("Reset appearance").on_click(cx.listener(|form, _, window, cx| {
                let defaults = crate::storage::Settings::default();
                for (state, value) in [(&form.family, defaults.font_family.as_str()), (&form.scheme, crate::appearance::SCHEMES[0].name), (&form.weight, "400"), (&form.cursor, "Bar"), (&form.cursor_color_mode, "Use palette default"), (&form.selection_color_mode, "Use palette default")] {
                    state.update(cx, |state, cx| state.set_selected_value(&SharedString::from(value.to_string()), window, cx));
                }
                for (state, value) in [(&form.size, "14"), (&form.line_height, "1.35"), (&form.cursor_width, "2")] {
                    state.update(cx, |state, cx| state.set_value(value, window, cx));
                }
                let palette = defaults.appearance.palette();
                form.cursor_color.update(cx, |state, cx| state.set_value(crate::hsla_color(palette.cursor_bg), window, cx));
                form.selection_color.update(cx, |state, cx| state.set_value(crate::hsla_color(palette.selection_bg), window, cx));
                form.cursor_color_custom = false;
                form.selection_color_custom = false;
                form.blink = true; form.error = None; cx.notify();
            })))
            .into_any_element()
    }
}

impl Render for SettingsForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.tab == 1 {
            self.appearance(window, cx)
        } else if self.tab == 2 {
            self.quick_commands(cx)
        } else {
            div()
                .flex()
                .flex_col()
                .gap_4()
                .child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child("Terminal defaults"))
                .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Set the baseline cursor and spacing for every terminal pane. Programs may request their own cursor shape."))
                .child(Form::new().columns(2)
                    .child(Field::new().label("Cursor style").child(Select::new(&self.cursor).id("settings-cursor").accessibility_label("Cursor shape").w_full()))
                    .child(Field::new().label("Blink").child(Checkbox::new("settings-cursor-blink").label("Blink cursor").checked(self.blink).on_change(cx.listener(|form, value, _, cx| { form.blink = *value; cx.notify(); }))))
                    .child(Field::new().label("Cursor width").description("1–6 px; applies to the bar cursor.").child(Input::new(&self.cursor_width).id("settings-cursor-width").aria_label("Cursor width").disabled(self.cursor.read(cx).selected_value().is_some_and(|value| value.as_ref() != "Bar"))))
                    .child(Field::new().label("Line height").description("1.0–2.0").child(Input::new(&self.line_height).id("settings-line-height").aria_label("Line height"))))
                .child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child("Startup"))
                .child(
                    Checkbox::new("restore-session")
                        .label("Restore the previous session on startup")
                        .checked(self.restore)
                        .on_change(cx.listener(|form, value, _, cx| {
                            form.restore = *value;
                            cx.notify();
                        })),
                )
                .child(
                    Form::new().child(
                        Field::new()
                            .label("New-tab directory")
                            .description("Leave empty to use your home directory.")
                            .child(
                                Input::new(&self.directory)
                                    .id("settings-directory")
                                    .aria_label("New-tab directory"),
                            ),
                    ),
                )
                .when_some(
                    self.owner.upgrade().and_then(|owner| {
                        owner
                            .read(cx)
                            .store
                            .as_ref()
                            .map(|store| store.directory().to_path_buf())
                    }),
                    |view, directory| {
                        view.child(
                            Button::new("open-app-data")
                                .ghost()
                                .label("Open app data folder")
                                .on_click(move |_, _, cx| cx.open_with_system(&directory)),
                        )
                    },
                )
                .child(div().flex().flex_col().gap_3()
                    .child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child("Import and export"))
                    .child(div().text_sm().text_color(cx.theme().muted_foreground).child("Export your current setup to a JSON file or import a saved backup. Importing replaces the current settings immediately."))
                    .child(div().flex().flex_wrap().gap_3()
                        .child(Button::new("import-settings").outline().icon(gpui_kit::assets::IconName::Upload).label("Import settings…").disabled(self.backup_busy).on_click(cx.listener(|form, _, window, cx| form.transfer_settings(true, window, cx))))
                        .child(Button::new("export-settings").outline().icon(gpui_kit::assets::IconName::Download).label("Export settings…").disabled(self.backup_busy).on_click(cx.listener(|form, _, window, cx| form.transfer_settings(false, window, cx)))))
                    .when_some(self.backup_status.clone(), |view, message| view.child(div().id("settings-backup-status").test_support().role(Role::Status).aria_label(message.clone()).text_sm().text_color(cx.theme().muted_foreground).child(message))))
                .into_any_element()
        }
    }
}

pub(super) fn open_servers(workspace: &Entity<Workspace>, window: &mut Window, cx: &mut App) {
    let owner = workspace.downgrade();
    let view = cx.new(|cx| ServersView {
        owner,
        error: None,
        deleted: None,
        _subscription: cx.observe(workspace, |_, _, cx| cx.notify()),
    });
    window.open_dialog(cx, move |dialog, window, _| {
        dialog
            .title("SSH servers")
            .width(window.rem_size() * 36.)
            .footer(footer("Done", false, false))
            .child(view.clone())
    });
}

struct ServersView {
    owner: WeakEntity<Workspace>,
    error: Option<String>,
    deleted: Option<SshProfile>,
    _subscription: Subscription,
}

impl Render for ServersView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(owner) = self.owner.upgrade() else {
            return div().into_any_element();
        };
        let profiles = owner.read(cx).settings.ssh_servers.clone();
        let empty = profiles.is_empty();
        div()
            .id("ssh-server-list")
            .flex()
            .flex_col()
            .gap_3()
            .max_h(window.rem_size() * 24.)
            .overflow_y_scroll()
            .child(
                Button::new("add-ssh-server")
                    .label("Add server…")
                    .on_click({
                        let owner = owner.downgrade();
                        move |_, window, cx| {
                            if let Some(owner) = owner.upgrade() {
                                window.close_dialog(cx);
                                open_ssh(&owner, None, window, cx);
                            }
                        }
                    }),
            )
            .when(empty, |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child("Add an SSH server to connect in a terminal tab."),
                )
            })
            .children(profiles.into_iter().map(|profile| {
                let connect_id = profile.id.clone();
                let delete_id = profile.id.clone();
                let edit_profile = profile.clone();
                div()
                    .id(SharedString::from(profile.id.clone()))
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().truncate().child(profile.name))
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .truncate()
                                    .child(format!(
                                        "{}@{}:{}",
                                        profile.username, profile.host, profile.port
                                    )),
                            ),
                    )
                    .child(
                        Button::new(SharedString::from(format!("connect-server-{}", profile.id)))
                            .small()
                            .label("Connect")
                            .on_click({
                                let owner = owner.downgrade();
                                move |_, window, cx| {
                                    let owner = owner.clone();
                                    let id = connect_id.clone();
                                    window.close_dialog(cx);
                                    window.on_next_frame(move |window, cx| {
                                        let _ = owner
                                            .update(cx, |view, cx| view.connect(&id, window, cx));
                                    });
                                }
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("edit-server-{}", profile.id)))
                            .small()
                            .ghost()
                            .label("Edit…")
                            .on_click({
                                let owner = owner.downgrade();
                                move |_, window, cx| {
                                    if let Some(owner) = owner.upgrade() {
                                        window.close_dialog(cx);
                                        open_ssh(&owner, Some(edit_profile.clone()), window, cx);
                                    }
                                }
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("delete-server-{}", profile.id)))
                            .small()
                            .ghost()
                            .text_color(cx.theme().danger)
                            .label("Delete")
                            .on_click(cx.listener(move |view, _, _, cx| {
                                let mut deleted = None;
                                let result = view.owner.update(cx, |owner, cx| {
                                    let mut settings = owner.settings.clone();
                                    deleted = settings
                                        .ssh_servers
                                        .iter()
                                        .find(|profile| profile.id == delete_id)
                                        .cloned();
                                    settings
                                        .ssh_servers
                                        .retain(|profile| profile.id != delete_id);
                                    owner.save_settings(settings, cx)
                                });
                                view.error = match result {
                                    Ok(Ok(())) => {
                                        view.deleted = deleted;
                                        None
                                    }
                                    Ok(Err(error)) | Err(error) => Some(format!("{error:#}")),
                                };
                                cx.notify();
                            })),
                    )
            }))
            .when_some(self.deleted.clone(), |view, profile| {
                view.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(div().text_sm().child(format!("Deleted {}", profile.name)))
                        .child(
                            Button::new("undo-delete-server")
                                .small()
                                .label("Undo")
                                .on_click(cx.listener(move |view, _, _, cx| {
                                    let result = view.owner.update(cx, |owner, cx| {
                                        let mut settings = owner.settings.clone();
                                        settings.ssh_servers.push(profile.clone());
                                        owner.save_settings(settings, cx)
                                    });
                                    view.error = match result {
                                        Ok(Ok(())) => {
                                            view.deleted = None;
                                            None
                                        }
                                        Ok(Err(error)) | Err(error) => Some(format!("{error:#}")),
                                    };
                                    cx.notify();
                                })),
                        ),
                )
            })
            .child(error(&self.error, cx))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        bind_keys,
        storage::{Settings, Store},
        workspace::Workspace,
    };
    use gpui_kit::{
        AppContext, Entity, TestAppContext, WindowHandle,
        component::Root,
        px, size,
        test::{TestAppContextExt, TestWindowExt},
    };

    fn open(cx: &mut TestAppContext) -> (WindowHandle<Root>, Entity<Workspace>, Store) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            bind_keys(cx);
            cx.set_reduce_motion(true);
        });
        let store = Store::at(
            std::env::temp_dir().join(format!("terminal-dialog-test-{}", uuid::Uuid::new_v4())),
        );
        let mut workspace = None;
        let handle = cx.open_window(size(px(1000.), px(800.)), |window, cx| {
            let view = cx.new(|cx| {
                let mut view = Workspace::new(window, cx);
                view.store = Some(store.clone());
                view
            });
            workspace = Some(view.clone());
            Root::new(view, window, cx)
        });
        (handle, workspace.unwrap(), store)
    }

    fn settle(cx: &mut TestAppContext) {
        cx.run_until_parked();
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(300));
        cx.run_until_parked();
    }

    fn fill(
        window: &mut gpui_kit::Window,
        id: impl Into<gpui_kit::ElementId>,
        value: &str,
        cx: &mut gpui_kit::App,
    ) {
        window.click(id, cx);
        window.press(
            if cfg!(target_os = "macos") {
                "cmd-a"
            } else {
                "ctrl-a"
            },
            cx,
        );
        window.input(value, cx);
    }

    fn fill_color(window: &mut gpui_kit::Window, value: &str, cx: &mut gpui_kit::App) {
        window.render_frame(cx);
        let input = gpui_kit::base::test_support::snapshots(window)
            .into_iter()
            .find(|snapshot| {
                snapshot.role() == Some(gpui_kit::Role::TextInput)
                    && snapshot.visible()
                    && matches!(snapshot.path().last(), Some(gpui_kit::ElementId::NamedInteger(name, _)) if name.as_ref() == "input")
            })
            .expect("color picker exposes its hex input");
        fill(window, input.path().last().unwrap().clone(), value, cx);
        assert_eq!(
            window.find(input.path().last().unwrap().clone()).value(),
            Some(value)
        );
        window.press("enter", cx);
        assert!(
            window.try_find("dialog").is_some(),
            "committing a color keeps Settings open"
        );
    }

    #[gpui_kit::test]
    #[ignore = "manual scrolling benchmark: cargo test appearance_scroll_frame_cost -- --ignored --nocapture"]
    fn appearance_scroll_frame_cost(cx: &mut TestAppContext) {
        let (handle, workspace, _) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.click("settings-appearance", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            let before = window.find("scheme-midnight-blue").bounds().origin.y;
            let started = std::time::Instant::now();
            for _ in 0..40 {
                window.scroll(
                    "dialog",
                    gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-10.))),
                    cx,
                );
            }
            eprintln!(
                "Appearance wheel interaction (includes forced render frames): {:?}",
                started.elapsed() / 40
            );
            assert!(window.find("scheme-midnight-blue").bounds().origin.y < before);
            assert!(window.find("settings-general").visible());
            window.remove_window();
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn appearance_previews_choices_validates_and_persists(cx: &mut TestAppContext) {
        let (handle, workspace, store) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("settings-general").selected(), Some(true));
            window.click("settings-general", cx);
            window.press("tab", cx);
            window.press("space", cx);
            assert_eq!(window.find("settings-appearance").selected(), Some(true));
            assert_eq!(window.find("settings-general").selected(), Some(false));
            assert!(window.find("appearance-preview").visible());
            window.scroll(
                "appearance-preview",
                gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-300.))),
                cx,
            );
            assert!(
                window.find("settings-general").visible(),
                "tabs stay fixed while scrolling"
            );
            let midnight = window.find("scheme-midnight-blue").bounds();
            let rose = window.find("scheme-rose-pine").bounds();
            assert_eq!(midnight.origin.y, rose.origin.y);
            assert!(
                rose.origin.x > midnight.origin.x,
                "themes form a two-column grid"
            );
            assert!(window.try_find("scheme-monokai").is_some());
            window.click("scheme-midnight-blue", cx);
            window.press("tab", cx);
            window.press("space", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("scheme-rose-pine").checked(), Some(true));
            assert_eq!(window.find("scheme-midnight-blue").checked(), Some(false));
            assert_eq!(
                workspace.read(cx).settings.appearance.scheme,
                "midnight-blue",
                "preview is a draft"
            );
            window.scroll(
                "scheme-rose-pine",
                gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(400.))),
                cx,
            );
            window.click("settings-font", cx);
            window.press("down", cx);
            window.press("enter", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("settings-font").value(), Some("Fira Code"));
            window.click("settings-general", cx);
            fill(window, "settings-line-height", "bad", cx);
            fill(window, "settings-cursor-width", "4", cx);
            window.click("settings-cursor-blink", cx);
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_some());
            assert!(window.find("form-error").visible());
            assert!(
                window
                    .find("form-error")
                    .label()
                    .unwrap()
                    .contains("line height")
            );
            assert_eq!(window.find("settings-general").selected(), Some(true));
            fill(window, "settings-line-height", "1.6", cx);
            window.click("settings-appearance", cx);
        })
        .unwrap();
        settle(cx);
        for id in [
            "settings-cursor-color-mode",
            "settings-selection-color-mode",
        ] {
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                window.click(id, cx);
                assert_eq!(window.find(id).expanded(), Some(true));
                window.press("down", cx);
                window.press("enter", cx);
            })
            .unwrap();
            settle(cx);
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                assert_eq!(window.find(id).value(), Some("Use custom color"));
            })
            .unwrap();
        }
        for (id, color) in [
            ("settings-cursor-color", "#ff8800"),
            ("settings-selection-color", "#11223380"),
        ] {
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                window.click(id, cx);
            })
            .unwrap();
            settle(cx);
            cx.update_window(handle.into(), |_, window, cx| {
                fill_color(window, color, cx);
            })
            .unwrap();
            settle(cx);
        }
        cx.update_window(handle.into(), |_, window, cx| {
            window.click("settings-cursor-color-mode", cx);
            window.press("enter", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_none());
            window.remove_window();
        })
        .unwrap();
        let saved: Settings = store.load("settings.json").unwrap();
        assert_eq!(saved.font_family, "Fira Code");
        assert_eq!(saved.appearance.scheme, "rose-pine");
        assert_eq!(saved.appearance.line_height, 1.6);
        assert_eq!(saved.appearance.cursor_width, 4.);
        assert!(!saved.appearance.cursor_blink);
        assert_eq!(saved.appearance.cursor_color.as_deref(), Some("#ff8800"));
        assert_eq!(
            saved.appearance.selection_color.as_deref(),
            Some("#11223380")
        );
        std::fs::remove_dir_all(store.directory()).unwrap();
    }

    #[gpui_kit::test]
    fn quick_commands_save_immediately_and_preserve_failed_changes(cx: &mut TestAppContext) {
        let (handle, workspace, store) = open(cx);
        let new_command = |window: &gpui_kit::Window| {
            gpui_kit::base::test_support::snapshots(window)
                .into_iter()
                .find(|item| item.label() == Some("New shell command"))
                .unwrap()
        };
        cx.update_window(handle.into(), |_, window, cx| {
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            fill(window, "settings-cursor-width", "4", cx);
            window.click("settings-quick-commands", cx);
            assert!(window.try_find("ok").is_none());
            assert!(window.try_find("cancel").is_none());
            window.click("add-quick-command", cx);
        })
        .unwrap();
        settle(cx);
        let id = cx
            .update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                assert!(
                    window
                        .find("form-error")
                        .label()
                        .unwrap()
                        .contains("quick command name")
                );
                assert_eq!(
                    window.find("settings-quick-commands").selected(),
                    Some(true)
                );
                fill(window, "new-quick-command-name", "  List files  ", cx);
                window.click("add-quick-command", cx);
                assert!(
                    window
                        .find("form-error")
                        .label()
                        .unwrap()
                        .contains("Enter a quick command without")
                );
                fill(
                    window,
                    new_command(window).path().last().unwrap().clone(),
                    "pwd\nls -la",
                    cx,
                );
                window.click("add-quick-command", cx);
                assert_eq!(window.find("new-quick-command-name").value(), Some(""));
                assert_eq!(new_command(window).value(), Some(""));
                let name = gpui_kit::base::test_support::snapshots(window)
                    .into_iter()
                    .find(|item| item.label() == Some("List files"))
                    .unwrap();
                let id = name
                    .path()
                    .last()
                    .unwrap()
                    .to_string()
                    .strip_prefix("quick-command-title-")
                    .unwrap()
                    .to_string();
                let title = window.find(format!("quick-command-title-{id}"));
                let command = window.find(format!("quick-command-value-{id}"));
                assert_eq!(command.label(), Some("pwd\nls -la"));
                assert_eq!(
                    title.bounds().left(),
                    window.find("new-quick-command-name").bounds().left()
                );
                assert_eq!(command.bounds().left(), new_command(window).bounds().left());
                assert!(
                    window
                        .find(format!("edit-quick-command-{id}"))
                        .bounds()
                        .left()
                        > command.bounds().right()
                );
                assert!(
                    window
                        .try_find(format!("quick-command-name-{id}"))
                        .is_none()
                );
                assert_eq!(
                    store
                        .load::<Settings>("settings.json")
                        .unwrap()
                        .quick_commands
                        .len(),
                    1
                );
                window.click("settings-general", cx);
                assert!(window.find("ok").visible());
                window.click("cancel", cx);
                id
            })
            .unwrap();
        settle(cx);
        let saved: Settings = store.load("settings.json").unwrap();
        assert_eq!(saved.quick_commands[0].name, "List files");
        assert_eq!(saved.quick_commands[0].command, "pwd\nls -la");
        assert_eq!(saved.appearance.cursor_width, 2.);
        cx.update_window(handle.into(), |_, window, cx| {
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("settings-quick-commands", cx);
            window.click(format!("edit-quick-command-{id}"), cx);
            fill(
                window,
                format!("quick-command-name-{id}"),
                "Discard this edit",
                cx,
            );
            window.press("escape", cx);
        })
        .unwrap();
        settle(cx);
        assert_eq!(store.load::<Settings>("settings.json").unwrap(), saved);
        cx.update_window(handle.into(), |_, window, cx| {
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("settings-quick-commands", cx);
            window.click(format!("edit-quick-command-{id}"), cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            fill(window, format!("quick-command-name-{id}"), " ", cx);
            window.click(format!("edit-quick-command-{id}"), cx);
            assert!(
                window
                    .find("form-error")
                    .label()
                    .unwrap()
                    .contains("quick command name")
            );
            fill(window, format!("quick-command-name-{id}"), "Show files", cx);
            window.click(format!("edit-quick-command-{id}"), cx);
            assert_eq!(
                window.find(format!("quick-command-title-{id}")).label(),
                Some("Show files")
            );
            assert_eq!(
                store
                    .load::<Settings>("settings.json")
                    .unwrap()
                    .quick_commands[0]
                    .name,
                "Show files"
            );
            // Saving another settings tab must keep the committed command.
            window.click("settings-general", cx);
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        let saved: Settings = store.load("settings.json").unwrap();
        assert_eq!(saved.quick_commands.len(), 1);
        assert_eq!(saved.quick_commands[0].name, "Show files");
        cx.update_window(handle.into(), |_, window, cx| {
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("settings-quick-commands", cx);
            let blocked = store.directory().join("blocked-storage");
            std::fs::write(&blocked, "not a directory").unwrap();
            workspace.update(cx, |workspace, _| {
                workspace.store = Some(Store::at(blocked))
            });
            window.click(format!("delete-quick-command-{id}"), cx);
            assert!(window.find(format!("quick-command-title-{id}")).visible());
            assert!(!window.find("form-error").label().unwrap().is_empty());
            assert_eq!(store.load::<Settings>("settings.json").unwrap(), saved);
            workspace.update(cx, |workspace, _| workspace.store = Some(store.clone()));
            window.click(format!("delete-quick-command-{id}"), cx);
            assert!(
                window
                    .try_find(format!("quick-command-title-{id}"))
                    .is_none()
            );
            window.press("escape", cx);
        })
        .unwrap();
        settle(cx);
        assert!(
            store
                .load::<Settings>("settings.json")
                .unwrap()
                .quick_commands
                .is_empty()
        );
        cx.update_window(handle.into(), |_, window, _| window.remove_window())
            .unwrap();
        std::fs::remove_dir_all(store.directory()).unwrap();
    }

    #[gpui_kit::test]
    async fn settings_import_export_through_file_dialogs(cx: &mut TestAppContext) {
        let (handle, workspace, store) = open(cx);
        let original = Settings::default();
        store.save("settings.json", &original).unwrap();
        let path = store.directory().join("backup.json");
        cx.update_window(handle.into(), |_, window, cx| {
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let import = window.find("import-settings");
            let export = window.find("export-settings");
            assert!(import.visible() && export.visible());
            assert_eq!(import.bounds().top(), export.bounds().top());
            assert!(import.bounds().top() >= window.find("open-app-data").bounds().bottom());
            window.scroll(
                "settings-directory",
                gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-400.))),
                cx,
            );
            window.click("export-settings", cx);
        })
        .unwrap();
        settle(cx);
        cx.simulate_new_path_selection(|_| Some(path.clone()));
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| window.try_find("settings-backup-status").is_some(),
        )
        .await;
        assert_eq!(Settings::read_backup(&path).unwrap(), original);
        std::fs::write(&path, b"{}").unwrap();
        cx.update_window(handle.into(), |_, window, cx| {
            window.scroll(
                "settings-directory",
                gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-400.))),
                cx,
            );
            window.click("import-settings", cx)
        })
        .unwrap();
        settle(cx);
        cx.simulate_path_prompt_response(|options| {
            assert!(options.files && !options.directories && !options.multiple);
            Some(vec![path.clone()])
        });
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| window.try_find("form-error").is_some(),
        )
        .await;
        cx.update(|cx| assert_eq!(workspace.read(cx).settings, original));
        assert_eq!(store.load_settings().unwrap(), original);
        let imported = Settings {
            font_size: 18.,
            restore_session: false,
            ..original.clone()
        };
        imported.write_backup(&path).unwrap();
        cx.update_window(handle.into(), |_, window, cx| {
            window.scroll(
                "settings-directory",
                gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-400.))),
                cx,
            );
            window.click("import-settings", cx)
        })
        .unwrap();
        settle(cx);
        cx.simulate_path_prompt_response(|_| Some(vec![path.clone()]));
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| window.try_find("settings-backup-status").is_some(),
        )
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            assert_eq!(workspace.read(cx).settings, imported);
            assert_eq!(window.find("restore-session").checked(), Some(false));
            window.click("settings-appearance", cx);
            assert_eq!(window.find("settings-font-size").value(), Some("18"));
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        assert_eq!(store.load_settings().unwrap(), imported);
        cx.update_window(handle.into(), |_, window, cx| {
            assert!(window.try_find("dialog").is_none());
            super::open_settings(&workspace, window, cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.scroll(
                "settings-directory",
                gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-400.))),
                cx,
            );
            window.click("import-settings", cx);
        })
        .unwrap();
        settle(cx);
        cx.simulate_path_prompt_response(|_| None);
        cx.wait_for(
            handle.into(),
            std::time::Duration::from_secs(5),
            |window, _| window.find("import-settings").disabled() != Some(true),
        )
        .await;
        cx.update_window(handle.into(), |_, window, cx| {
            assert!(window.try_find("form-error").is_none());
            assert_eq!(workspace.read(cx).settings, imported);
            window.remove_window();
        })
        .unwrap();
        std::fs::remove_dir_all(store.directory()).unwrap();
    }

    #[gpui_kit::test]
    fn settings_validate_save_and_return_focus_to_the_terminal(cx: &mut TestAppContext) {
        let (handle, workspace, store) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-,"
                } else {
                    "ctrl-,"
                },
                cx,
            );
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("settings-appearance", cx);
            fill(window, "settings-font-size", "99", cx);
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_some());
            assert!(window.find("form-error").visible());
            assert!(
                window
                    .find("form-error")
                    .label()
                    .unwrap()
                    .contains("between 10 and 32")
            );
            assert_eq!(workspace.read(cx).settings.font_size, 14.);
            fill(window, "settings-font-size", "18", cx);
            window.click("settings-general", cx);
            window.click("restore-session", cx);
            window.click("settings-appearance", cx);
            window.click("settings-font-size", cx);
            window.press("enter", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_none());
            assert_eq!(window.find("terminal").focused(), Some(true));
            assert_eq!(workspace.read(cx).settings.font_size, 18.);
            assert!(!workspace.read(cx).settings.restore_session);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-,"
                } else {
                    "ctrl-,"
                },
                cx,
            );
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press("escape", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_none());
            assert_eq!(window.find("terminal").focused(), Some(true));
            window.remove_window();
        })
        .unwrap();
        let saved: Settings = store.load("settings.json").unwrap();
        assert_eq!(saved.font_size, 18.);
        assert!(!saved.restore_session);
        std::fs::remove_dir_all(store.directory()).unwrap();
    }

    #[gpui_kit::test]
    fn ssh_dialog_saves_encrypted_credentials_and_edits_without_losing_them(
        cx: &mut TestAppContext,
    ) {
        let (handle, workspace, store) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-shift-s"
                } else {
                    "ctrl-shift-s"
                },
                cx,
            );
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("add-ssh-server", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let selector = window.find("ssh-icon-selector").bounds();
            let name = window.find("ssh-name").bounds();
            assert!(selector.right() < name.left());
            assert_eq!(selector.center().y, name.center().y);
            window.click("ssh-icon-selector", cx);
            window.click("ssh-icon-alpine-linux", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            fill(window, "ssh-name", "Production", cx);
            fill(window, "ssh-host", "127.0.0.1", cx);
            window.click("ssh-password-auth", cx);
            fill(window, "ssh-password", "secret with spaces '$`", cx);
            assert_eq!(window.find("ssh-password").value(), None);
            fill(window, "ssh-port", "0", cx);
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.find("form-error").label().unwrap().contains("Port"));
            assert!(workspace.read(cx).settings.ssh_servers.is_empty());
            fill(window, "ssh-port", "2222", cx);
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        let saved: Settings = store.load("settings.json").unwrap();
        let profile = saved.ssh_servers.first().unwrap();
        assert_eq!(profile.name, "Production");
        assert_eq!(profile.icon, "alpine-linux");
        assert_eq!(profile.port, 2222);
        assert_eq!(
            store
                .decrypt(&profile.id, profile.secret.as_ref().unwrap())
                .unwrap(),
            "secret with spaces '$`"
        );
        assert!(
            !std::fs::read_to_string(store.directory().join("settings.json"))
                .unwrap()
                .contains("secret with spaces")
        );
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find("terminal").focused(), Some(true));
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-shift-s"
                } else {
                    "ctrl-shift-s"
                },
                cx,
            );
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click(format!("edit-server-{}", profile.id), cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                window.find("ssh-icon-selector").label(),
                Some("Server icon: alpine-linux")
            );
            window.click("ssh-icon-selector", cx);
            window.click("ssh-icon-linux", cx);
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            fill(window, "ssh-name", "Staging", cx);
            window.click("ok", cx);
        })
        .unwrap();
        settle(cx);
        let edited: Settings = store.load("settings.json").unwrap();
        assert_eq!(edited.ssh_servers.len(), 1);
        assert_eq!(edited.ssh_servers[0].id, profile.id);
        assert_eq!(edited.ssh_servers[0].name, "Staging");
        assert_eq!(edited.ssh_servers[0].icon, "linux");
        assert_eq!(edited.ssh_servers[0].secret, profile.secret);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-shift-s"
                } else {
                    "ctrl-shift-s"
                },
                cx,
            );
        })
        .unwrap();
        settle(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click(format!("delete-server-{}", profile.id), cx);
        })
        .unwrap();
        settle(cx);
        assert!(
            store
                .load::<Settings>("settings.json")
                .unwrap()
                .ssh_servers
                .is_empty()
        );
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("undo-delete-server", cx);
        })
        .unwrap();
        settle(cx);
        assert_eq!(
            store.load::<Settings>("settings.json").unwrap().ssh_servers,
            edited.ssh_servers
        );
        cx.update_window(handle.into(), |_, window, _| window.remove_window())
            .unwrap();
        std::fs::remove_dir_all(store.directory()).unwrap();
    }
}
