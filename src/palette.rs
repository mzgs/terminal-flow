use crate::workspace::Workspace;
use gpui_kit::{
    assets::IconName,
    component::{
        ActiveTheme, Disableable, Icon, Sizable, WindowExt,
        command::{Command, CommandGroup, CommandItem, CommandState},
        input::{Input, InputEvent, InputState},
    },
    prelude::FluentBuilder,
    *,
};

enum Target {
    Action(Box<dyn Action>),
    Server { id: String, icon: String },
    QuickCommand { id: String },
}

struct Entry {
    label: String,
    detail: Option<String>,
    target: Target,
    disabled: bool,
    icon: IconName,
}

pub(super) struct Palette {
    owner: WeakEntity<Workspace>,
    state: Entity<CommandState>,
    search: Entity<InputState>,
    _search_subscription: Subscription,
    entries: Vec<Entry>,
    focus: FocusHandle,
    previous_focus: Option<FocusHandle>,
}

pub(super) fn open(workspace: &Entity<Workspace>, window: &mut Window, cx: &mut App) {
    if window.has_active_dialog(cx) || workspace.read(cx).palette.is_some() {
        return;
    }
    let actions: Vec<(&str, IconName, Box<dyn Action>)> = {
        use IconName::{
            Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CirclePlus, ClipboardPaste, Close,
            Copy, Delete, Download, FileText, LogOut, Pencil, Play, Plus, RefreshCw, RotateCcw,
            Search, Server, Settings, SquareDashed, ZoomIn, ZoomOut,
        };
        vec![
            ("New tab", Plus, Box::new(crate::NewTab)),
            ("Close tab", Close, Box::new(crate::CloseTab)),
            (
                "Split right",
                IconName::PanelRight,
                Box::new(crate::SplitRight),
            ),
            (
                "Split down",
                IconName::PanelBottom,
                Box::new(crate::SplitDown),
            ),
            ("Close pane", Close, Box::new(crate::ClosePane)),
            ("Next pane", ArrowRight, Box::new(crate::NextPane)),
            ("Previous pane", ArrowLeft, Box::new(crate::PreviousPane)),
            ("Next tab", ArrowRight, Box::new(crate::NextTab)),
            ("Previous tab", ArrowLeft, Box::new(crate::PreviousTab)),
            ("Open local file…", FileText, Box::new(crate::OpenFile)),
            ("Settings…", Settings, Box::new(crate::OpenSettings)),
            ("Add SSH server…", CirclePlus, Box::new(crate::AddSshServer)),
            (
                "Manage SSH servers…",
                Server,
                Box::new(crate::ManageSshServers),
            ),
            ("Find in terminal…", Search, Box::new(crate::Find)),
            ("Find next", ArrowDown, Box::new(crate::FindNext)),
            ("Find previous", ArrowUp, Box::new(crate::FindPrevious)),
            ("Copy", Copy, Box::new(crate::Copy)),
            ("Copy screen", Copy, Box::new(crate::CopyScreen)),
            ("Paste", ClipboardPaste, Box::new(crate::Paste)),
            ("Select all", SquareDashed, Box::new(crate::SelectAll)),
            (
                "Download selected file…",
                Download,
                Box::new(crate::DownloadSelection),
            ),
            (
                "Edit selected file…",
                Pencil,
                Box::new(crate::EditSelection),
            ),
            ("Clear terminal", Delete, Box::new(crate::ClearTerminal)),
            (
                "Extract selected archive",
                Archive,
                Box::new(crate::ExtractSelection),
            ),
            ("Run", Play, Box::new(crate::RunSelection)),
            (
                "Search selection with Google",
                Search,
                Box::new(crate::SearchSelection),
            ),
            ("Restart shell", RefreshCw, Box::new(crate::Restart)),
            ("Zoom in", ZoomIn, Box::new(crate::ZoomIn)),
            ("Zoom out", ZoomOut, Box::new(crate::ZoomOut)),
            ("Reset zoom", RotateCcw, Box::new(crate::ResetZoom)),
            ("Quit", LogOut, Box::new(crate::Quit)),
        ]
    };
    let mut entries: Vec<_> = actions
        .into_iter()
        .map(|(label, icon, action)| Entry {
            label: label.into(),
            detail: None,
            disabled: !window.is_action_available(action.as_ref(), cx),
            target: Target::Action(action),
            icon,
        })
        .collect();
    entries.extend(
        workspace
            .read(cx)
            .settings
            .quick_commands
            .iter()
            .map(|command| Entry {
                label: command.name.clone(),
                detail: Some(command.command.clone()),
                target: Target::QuickCommand {
                    id: command.id.clone(),
                },
                disabled: !workspace.read(cx).quick_commands_available(cx),
                icon: IconName::FileText,
            }),
    );
    entries.extend(
        workspace
            .read(cx)
            .settings
            .ssh_servers
            .iter()
            .map(|server| Entry {
                label: server.name.clone(),
                detail: Some(format!(
                    "{}@{}:{}",
                    server.username, server.host, server.port
                )),
                target: Target::Server {
                    id: server.id.clone(),
                    icon: server.icon.clone(),
                },
                disabled: false,
                icon: IconName::Server,
            }),
    );
    let state = cx.new(|cx| CommandState::new(window, cx));
    let search = cx.new(|cx| InputState::new(window, cx).placeholder("Type a command"));
    let focus = search.clone();
    let palette = cx.new(|cx| {
        let subscription = cx.subscribe_in(
            &search,
            window,
            |palette: &mut Palette, input, event, window, cx| {
                if matches!(event, InputEvent::Change) {
                    let query = input.read(cx).value();
                    palette
                        .state
                        .update(cx, |state, cx| state.set_query(query, window, cx));
                    cx.notify();
                }
            },
        );
        Palette {
            owner: workspace.downgrade(),
            state,
            search,
            _search_subscription: subscription,
            entries,
            focus: cx.focus_handle(),
            previous_focus: window.focused(cx),
        }
    });
    workspace.update(cx, |workspace, cx| {
        workspace.palette = Some(palette);
        cx.notify();
    });
    window.defer(cx, move |window, cx| {
        focus.update(cx, |state, cx| state.focus(window, cx));
    });
}

impl Palette {
    fn close(&self, window: &mut Window, cx: &mut App) {
        let _ = self.owner.update(cx, |workspace, cx| {
            workspace.palette = None;
            cx.notify();
        });
        if let Some(focus) = &self.previous_focus {
            window.focus(focus, cx);
        }
    }
}

// Lower scores prefer contiguous matches, then short gaps and earlier starts.
fn fuzzy_score(label: &str, query: &str) -> Option<usize> {
    let label = label.to_lowercase();
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Some(0);
    }
    if let Some(start) = label.find(&query) {
        return Some(label[..start].chars().count());
    }
    let mut characters = label.chars().enumerate();
    let mut first = None;
    let mut last = 0;
    for wanted in query.chars() {
        let (position, _) = characters.find(|(_, character)| *character == wanted)?;
        first.get_or_insert(position);
        last = position;
    }
    // ponytail: greedy subsequence ranking; use a scored matcher if large catalogs need better relevance.
    let first = first?;
    let gaps = last - first + 1 - query.chars().count();
    Some(label.chars().count() + first + gaps)
}

impl Render for Palette {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.state.read(cx).query(cx);
        let mut matches = [Vec::new(), Vec::new(), Vec::new()];
        for (ix, entry) in self.entries.iter().enumerate() {
            let search_text = if matches!(entry.target, Target::Server { .. }) {
                format!(
                    "{} {}",
                    entry.label,
                    entry.detail.as_deref().unwrap_or_default()
                )
            } else {
                entry.label.clone()
            };
            if let Some(score) = fuzzy_score(&search_text, &query) {
                let section = match &entry.target {
                    Target::QuickCommand { .. } => 0,
                    Target::Server { .. } => 1,
                    Target::Action(_) => 2,
                };
                matches[section].push((score, ix));
            }
        }
        let mut command = Command::new(&self.state);
        for (section, (label, icon)) in [
            ("Quick Commands", IconName::Play),
            ("Servers", IconName::Server),
            ("Commands", IconName::Settings),
        ]
        .into_iter()
        .enumerate()
        {
            matches[section].sort_by_key(|(score, _)| *score);
            let items = matches[section].iter().map(|(_, ix)| {
                let entry = &self.entries[*ix];
                let label = entry.label.clone();
                let detail = entry.detail.clone();
                let id: SharedString = match &entry.target {
                    Target::Action(action) => action.name().into(),
                    Target::Server { id, .. } => id.clone().into(),
                    Target::QuickCommand { id } => id.clone().into(),
                };
                let icon = entry.icon;
                let server_icon = match &entry.target {
                    Target::Server { icon, .. } => Some(icon.clone()),
                    Target::Action(_) | Target::QuickCommand { .. } => None,
                };
                CommandItem::new()
                    .label(entry.label.clone())
                    .disabled(entry.disabled)
                    .child(move |_, cx| {
                        let graphic = if let Some(icon) = &server_icon {
                            crate::ssh_icons::image(icon).size_4().into_any_element()
                        } else {
                            Icon::new(icon).size_4().into_any_element()
                        };
                        div()
                            .id(id.clone())
                            .test_support()
                            .role(Role::Label)
                            .aria_label(label.clone())
                            .flex()
                            .items_center()
                            .gap_2()
                            .py_1()
                            .w_full()
                            .min_w_0()
                            .child(
                                div()
                                    .id(SharedString::from(format!("palette-icon-{id}")))
                                    .test_support()
                                    .size_6()
                                    .flex_shrink_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(cx.theme().radius_tokens().md)
                                    .bg(cx.theme().muted)
                                    .border_1()
                                    .border_color(cx.theme().border)
                                    .child(graphic),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_xs()
                                            .font_weight(FontWeight::MEDIUM)
                                            .truncate()
                                            .child(label.clone()),
                                    )
                                    .when_some(detail.clone(), |view, detail| {
                                        view.child(
                                            div()
                                                .id(SharedString::from(format!(
                                                    "palette-detail-{id}"
                                                )))
                                                .test_support()
                                                .role(Role::Label)
                                                .aria_label(detail.clone())
                                                .text_xs()
                                                .text_color(cx.theme().muted_foreground)
                                                .truncate()
                                                .child(detail),
                                        )
                                    }),
                            )
                    })
            });
            let mut group = CommandGroup::new();
            if !matches[section].is_empty() {
                // ponytail: disabled rows style headings; use a group heading slot when Kit exposes one.
                group = group.item(CommandItem::new().disabled(true).child(move |_, cx| {
                    div()
                        .id(SharedString::from(format!("palette-group-{label}")))
                        .test_support()
                        .role(Role::Label)
                        .aria_label(label)
                        .flex()
                        .items_center()
                        .gap_2()
                        .w_full()
                        .pt_1()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(cx.theme().muted_foreground)
                        .child(
                            div()
                                .id(SharedString::from(format!("palette-group-icon-{label}")))
                                .test_support()
                                .size_4()
                                .flex_shrink_0()
                                .child(Icon::new(icon).size_4()),
                        )
                        .child(label)
                }));
            }
            group = group.items(items);
            if !matches[section].is_empty() {
                group = group.item(CommandItem::new().disabled(true).child(move |_, cx| {
                    div()
                        .id(SharedString::from(format!("palette-group-divider-{label}")))
                        .test_support()
                        .w_full()
                        .border_b_1()
                        .border_color(cx.theme().border)
                }));
            }
            command = command.group(group);
        }
        let palette = cx.entity().downgrade();
        let confirm = palette.clone();
        let dismiss = palette.clone();
        let spacing = cx.theme().spacing_tokens();
        let content = div()
            .id("dialog")
            .test_support()
            .flex()
            .flex_col()
            .w(window.rem_size() * 36.)
            .max_w(window.viewport_size().width - spacing.lg * 2.)
            .max_h(window.viewport_size().height - spacing.lg * 2.)
            .bg(cx.theme().popover)
            .text_color(cx.theme().foreground)
            .border_1()
            .border_color(cx.theme().border)
            .rounded(cx.theme().radius_lg)
            .shadow_xl()
            .occlude()
            .child(
                div()
                    .id("command-palette")
                    .test_support()
                    .capture_action(cx.listener(
                        |palette, _: &gpui_kit::base::actions::Cancel, window, cx| {
                            cx.stop_propagation();
                            palette.close(window, cx);
                        },
                    ))
                    .child(
                        command
                            .bordered(false)
                            .searchable(false)
                            .filterable(false)
                            .rounded(cx.theme().radius_lg)
                            .max_h(
                                (window.viewport_size().height - spacing.xl * 4.)
                                    .min(window.rem_size() * 24.),
                            )
                            .header({
                                let search = self.search.clone();
                                move |_, _, cx| {
                                    div()
                                        .px_3()
                                        .py_2()
                                        .border_b_1()
                                        .border_color(cx.theme().border)
                                        .child(
                                            Input::new(&search)
                                                .id("palette-search")
                                                .aria_label("Search commands")
                                                .appearance(false)
                                                .small()
                                                .prefix(
                                                    Icon::new(IconName::Search)
                                                        .size_4()
                                                        .text_color(cx.theme().muted_foreground),
                                                )
                                                .suffix(
                                                    div()
                                                        .flex()
                                                        .gap_1()
                                                        .text_xs()
                                                        .text_color(cx.theme().muted_foreground)
                                                        .children(
                                                            [
                                                                if cfg!(target_os = "macos") {
                                                                    "Cmd"
                                                                } else {
                                                                    "Ctrl"
                                                                },
                                                                "P",
                                                            ]
                                                            .map(|key| {
                                                                div()
                                                                    .px_1p5()
                                                                    .py_0p5()
                                                                    .rounded(
                                                                        cx.theme()
                                                                            .radius_tokens()
                                                                            .md,
                                                                    )
                                                                    .bg(cx.theme().muted)
                                                                    .border_1()
                                                                    .border_color(cx.theme().border)
                                                                    .child(key)
                                                            }),
                                                        ),
                                                ),
                                        )
                                }
                            })
                            .on_confirm(move |index, window, cx| {
                                let Some((_, ix)) =
                                    matches.get(index.section).and_then(|section| {
                                        index.row.checked_sub(1).and_then(|row| section.get(row))
                                    })
                                else {
                                    return;
                                };
                                let _ = confirm.update(cx, |palette, cx| {
                                    let entry = &palette.entries[*ix];
                                    if entry.disabled {
                                        return;
                                    }
                                    palette.close(window, cx);
                                    // Dismissal restores the original focus before dispatching a pane action.
                                    match &entry.target {
                                        Target::Action(action) => {
                                            let action = action.boxed_clone();
                                            window.defer(cx, move |window, cx| {
                                                window.dispatch_action(action, cx)
                                            });
                                        }
                                        Target::Server { id, .. } => {
                                            let id = id.clone();
                                            let owner = palette.owner.clone();
                                            window.defer(cx, move |window, cx| {
                                                let _ = owner.update(cx, |workspace, cx| {
                                                    workspace.connect(&id, window, cx)
                                                });
                                            });
                                        }
                                        Target::QuickCommand { id } => {
                                            let id = id.clone();
                                            let owner = palette.owner.clone();
                                            window.defer(cx, move |window, cx| {
                                                let _ = owner.update(cx, |workspace, cx| {
                                                    workspace.run_quick_command(&id, window, cx)
                                                });
                                            });
                                        }
                                    }
                                });
                            })
                            .empty(|_, _, cx| {
                                div()
                                    .p_4()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("No matching commands or SSH servers")
                            }),
                    ),
            );
        gpui_kit::base::Dialog::new(cx)
            .focus_handle(self.focus.clone())
            .backdrop(div().size_full().bg(cx.theme().overlay))
            .popup(content)
            .on_open_change(move |open, _, window, cx| {
                if !open {
                    let _ = dismiss.update(cx, |palette, cx| palette.close(window, cx));
                }
            })
    }
}

#[cfg(test)]
mod tests {
    use super::fuzzy_score;

    #[test]
    fn fuzzy_matching_is_case_insensitive_ordered_and_handles_unicode() {
        assert_eq!(fuzzy_score("New tab", "  "), Some(0));
        assert!(fuzzy_score("New tab", "NWTB").is_some());
        assert!(fuzzy_score("New tab", "tbn").is_none());
        assert!(fuzzy_score("İstanbul 東京", "東 京").is_none());
        assert!(fuzzy_score("İstanbul 東京", "東京").is_some());
        assert!(fuzzy_score("Connect to Production · admin@10.0.0.5:2222", "prd").is_some());
        assert!(fuzzy_score("Connect to Production · admin@10.0.0.5:2222", "ADM").is_some());
        assert!(fuzzy_score("Connect to Production · admin@10.0.0.5:2222", "10.0.0.5").is_some());
        assert!(fuzzy_score("Connect to Production · admin@10.0.0.5:2222", "2222").is_some());
        assert!(
            fuzzy_score("New tab", "new").unwrap() < fuzzy_score("Next window", "new").unwrap()
        );
        assert!(fuzzy_score("New tab", "zzz").is_none());
    }
}
