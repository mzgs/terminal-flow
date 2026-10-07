use super::{
    AddSshServer, CloseTab, ManageSshServers, NewTab, NextTab, OpenSettings, PreviousTab, Restart,
    TerminalView,
};
use crate::{
    dialogs,
    storage::{Settings, Snapshot, Store, TabSnapshot, TabSource, WindowState},
};
use gpui_kit::{
    base::{
        Tab,
        motion::{Transition, transition},
    },
    component::{
        ActiveTheme, Disableable, Icon, IconName, Sizable, TitleBar, WindowExt,
        button::{Button, ButtonVariants},
        menu::{ContextMenuExt, DropdownMenu, PopupMenuItem},
        notification::Notification,
        resizable::{h_resizable, resizable_panel},
    },
    prelude::FluentBuilder,
    *,
};
use std::{cell::Cell, rc::Rc};

fn terminal_tab(id: impl Into<ElementId>, selected: bool, cx: &App) -> Tab {
    Tab::new(id)
        .selected(selected)
        .w_48()
        .h(px(32.))
        .gap_2()
        .px_3()
        .text_sm()
        .rounded(cx.theme().radius_tokens().lg)
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().tab)
        .text_color(cx.theme().tab_foreground)
        .styles(|styles| {
            styles.selected(|style| {
                style
                    .bg(cx.theme().tab_active)
                    .border_color(cx.theme().input)
                    .text_color(cx.theme().tab_active_foreground)
            })
        })
        .hover(|style| {
            style
                .bg(cx
                    .theme()
                    .tab_active
                    .opacity(if selected { 1.2 } else { 0.8 }))
                .text_color(cx.theme().tab_active_foreground)
        })
}

struct TerminalTab {
    id: EntityId,
    saved_id: String,
    panes: Vec<TerminalPane>,
    active: EntityId,
    axis: Axis,
}

struct TerminalPane {
    terminal: Entity<TerminalView>,
    _subscription: Subscription,
    _focus_subscription: Subscription,
}

impl TerminalTab {
    fn active_terminal(&self) -> &Entity<TerminalView> {
        &self
            .panes
            .iter()
            .find(|pane| pane.terminal.entity_id() == self.active)
            .expect("tab has an active pane")
            .terminal
    }
}

pub(super) struct Workspace {
    pub(super) palette: Option<Entity<crate::palette::Palette>>,
    pub(super) settings: Settings,
    pub(super) store: Option<Store>,
    persistence_error: Option<String>,
    window_state: WindowState,
    _save_task: Option<Task<()>>,
    _quit_subscription: Option<Subscription>,
    tabs: Vec<TerminalTab>,
    active: EntityId,
    scroll: ScrollHandle,
    dragging: Option<DragTab>,
    scroll_frame_pending: bool,
    _bounds_subscription: Subscription,
    _activation_subscription: Subscription,
    _reconnect_task: Task<()>,
}

#[derive(Clone)]
struct DragTab {
    workspace: EntityId,
    tab: EntityId,
    title: String,
    icon: Option<String>,
    status_color: Hsla,
    original_ix: usize,
    grab_offset: Rc<Cell<Pixels>>,
    pointer_y: Pixels,
}

impl Render for DragTab {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().child(
            div()
                .id("tab-drag-preview")
                .test_support()
                .relative()
                .top(self.pointer_y - window.mouse_position().y)
                .rounded(cx.theme().radius_tokens().lg)
                .shadow_sm()
                .child(
                    terminal_tab("drag-tab", true, cx)
                        .child(div().size_1p5().rounded_full().bg(self.status_color))
                        .when_some(self.icon.as_deref(), |tab, icon| {
                            tab.child(crate::ssh_icons::image(icon).size_3p5().flex_shrink_0())
                        })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .child(self.title.clone()),
                        )
                        .child(
                            div()
                                .size_5()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(Icon::new(IconName::Close).size_3()),
                        ),
                ),
        )
    }
}

impl Workspace {
    pub(super) fn restore(
        store: Option<Store>,
        settings: Settings,
        mut snapshot: Snapshot,
        error: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        if !settings.restore_session {
            snapshot.tabs.clear();
        }
        if snapshot.tabs.is_empty() {
            snapshot.tabs.push(TabSnapshot {
                id: uuid::Uuid::new_v4().to_string(),
                source: TabSource::Local {
                    directory: settings.default_directory.clone(),
                },
                output: vec![],
                font_scale: 1.,
                scroll_offset: 0.,
                browser: Default::default(),
            });
        }
        let active_id = snapshot.active_tab.clone();
        let terminals: Vec<_> = snapshot
            .tabs
            .into_iter()
            .map(|snapshot| {
                let profile = match &snapshot.source {
                    TabSource::Ssh { profile_id, .. } => settings
                        .ssh_servers
                        .iter()
                        .find(|profile| &profile.id == profile_id)
                        .cloned(),
                    _ => None,
                };
                cx.new(|cx| {
                    TerminalView::configured(
                        snapshot,
                        profile,
                        store.clone(),
                        &settings,
                        window,
                        cx,
                    )
                })
            })
            .collect();
        let mut view = Self::with_terminal(terminals[0].clone(), window, cx);
        view.settings = settings;
        view.store = store;
        view.persistence_error = error;
        for terminal in terminals.into_iter().skip(1) {
            view.push_terminal(terminal, window, cx);
        }
        let active = view
            .tabs
            .iter()
            .find(|tab| Some(&tab.saved_id) == active_id.as_ref())
            .map(|tab| tab.id)
            .unwrap_or(view.active);
        view.activate(active, window, cx);
        view.window_state = Self::window_state(window);
        let weak = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            if crate::editor::prevent_quit(cx) {
                return false;
            }
            let _ = weak.update(cx, |view, cx| {
                view.window_state = Self::window_state(window);
                view.flush(cx);
            });
            true
        });
        view._quit_subscription = Some(cx.on_app_quit(|view, cx| {
            view.flush(cx);
            async {}
        }));
        cx.on_app_restart(|view, cx| view.flush(cx)).detach();
        view._save_task = Some(cx.spawn(async move |this, cx| {
            let mut previous = None;
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                let Ok(staged) = this.update(cx, |view, cx| {
                    view.store
                        .clone()
                        .map(|store| (store, view.snapshot(cx), view.window_state.clone()))
                }) else {
                    break;
                };
                let Some((store, snapshot, bounds)) = staged else {
                    continue;
                };
                if previous.as_ref() == Some(&(snapshot.clone(), bounds.clone())) {
                    continue;
                }
                let revision = store.next_session_revision();
                let saved = snapshot.clone();
                let saved_bounds = bounds.clone();
                let result = cx
                    .background_spawn(
                        async move { store.save_session(revision, &saved, &saved_bounds) },
                    )
                    .await;
                match result {
                    Ok(()) => previous = Some((snapshot, bounds)),
                    Err(error) => {
                        let _ = this.update(cx, |view, cx| {
                            view.persistence_error = Some(format!("{error:#}"));
                            cx.notify();
                        });
                    }
                }
            }
        }));
        view
    }

    fn window_state(window: &Window) -> WindowState {
        let bounds = window.window_bounds().get_bounds();
        WindowState {
            x: bounds.origin.x.into(),
            y: bounds.origin.y.into(),
            width: bounds.size.width.into(),
            height: bounds.size.height.into(),
            maximized: window.is_maximized(),
        }
    }

    fn snapshot(&mut self, cx: &mut App) -> Snapshot {
        Snapshot {
            version: 1,
            active_tab: self
                .tabs
                .iter()
                .find(|tab| tab.id == self.active)
                .map(|tab| tab.saved_id.clone()),
            tabs: self
                .tabs
                .iter()
                .map(|tab| {
                    let mut snapshot = tab
                        .active_terminal()
                        .update(cx, |terminal, _| terminal.snapshot());
                    snapshot.id = tab.saved_id.clone();
                    snapshot
                })
                .collect(),
        }
    }

    fn flush(&mut self, cx: &mut App) {
        if let Some(store) = self.store.clone() {
            let snapshot = self.snapshot(cx);
            if let Err(error) =
                store.save_session(store.next_session_revision(), &snapshot, &self.window_state)
            {
                self.persistence_error = Some(format!("{error:#}"));
                eprintln!("{error:#}");
            }
        }
    }

    pub(super) fn quick_commands_available(&self, cx: &App) -> bool {
        let terminal = self.tabs[self.active_ix()].active_terminal().read(cx);
        terminal.running && !terminal.connecting && terminal.session.is_some()
    }

    pub(super) fn run_quick_command(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(command) = self
            .settings
            .quick_commands
            .iter()
            .find(|command| command.id == id)
        else {
            return;
        };
        let command = command.command.clone();
        let (command, caret) = if let Some((before, after)) = command.split_once('$') {
            (format!("{before}{after}"), Some(after.chars().count()))
        } else {
            (command, None)
        };
        self.tabs[self.active_ix()]
            .active_terminal()
            .update(cx, |terminal, cx| {
                terminal.read_output(cx);
                window.focus(&terminal.focus, cx);
                if let Err(error) = terminal.send_command(&command, caret) {
                    terminal.status = format!("Couldn’t run quick command: {error}");
                }
                cx.notify();
            });
    }

    pub(super) fn save_settings(
        &mut self,
        settings: Settings,
        cx: &mut Context<Self>,
    ) -> anyhow::Result<()> {
        settings.validate()?;
        let store = self.store.as_ref().ok_or_else(|| {
            anyhow::anyhow!("App storage is unavailable. Check the error in the workspace.")
        })?;
        store.save("settings.json", &settings)?;
        for pane in self.tabs.iter().flat_map(|tab| &tab.panes) {
            pane.terminal.update(cx, |terminal, cx| {
                terminal.font_family = settings.font_family.clone();
                terminal.font_size = settings.font_size;
                if terminal.appearance != settings.appearance {
                    terminal.appearance = settings.appearance.clone();
                    terminal.cursor_epoch = std::time::Instant::now();
                    terminal.cursor_on = true;
                    if let Some(session) = &mut terminal.session {
                        session.set_palette(settings.appearance.palette());
                    }
                }
                if let TabSource::Ssh { profile_id, .. } = &terminal.source {
                    terminal.ssh_profile = settings
                        .ssh_servers
                        .iter()
                        .find(|profile| &profile.id == profile_id)
                        .cloned();
                    if let (Some(browser), Some(profile)) =
                        (&terminal.browser, &terminal.ssh_profile)
                    {
                        browser.update(cx, |browser, cx| browser.configure(profile.clone(), cx));
                    } else if terminal.ssh_profile.is_none() {
                        terminal.browser = None;
                        terminal._browser_subscription = None;
                    }
                }
                cx.notify();
            });
        }
        self.settings = settings;
        self.persistence_error = None;
        cx.notify();
        Ok(())
    }

    pub(super) fn connect(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(profile) = self
            .settings
            .ssh_servers
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
        else {
            return;
        };
        let snapshot = TabSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            source: TabSource::Ssh {
                profile_id: profile.id.clone(),
                directory: profile.remote_directory.clone(),
            },
            output: vec![],
            font_scale: 1.,
            scroll_offset: 0.,
            browser: Default::default(),
        };
        let terminal = cx.new(|cx| {
            TerminalView::configured(
                snapshot,
                Some(profile),
                self.store.clone(),
                &self.settings,
                window,
                cx,
            )
        });
        let id = terminal.entity_id();
        self.push_terminal(terminal, window, cx);
        self.activate(id, window, cx);
    }

    fn pane(
        terminal: Entity<TerminalView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> TerminalPane {
        let subscription = cx.observe(&terminal, |_, _, cx| cx.notify());
        let id = terminal.entity_id();
        let focus = terminal.read(cx).focus.clone();
        let focus_subscription = cx.on_focus_in(&focus, window, move |view, _, cx| {
            view.select_pane(id, cx);
        });
        TerminalPane {
            terminal,
            _subscription: subscription,
            _focus_subscription: focus_subscription,
        }
    }

    fn tab(
        terminal: Entity<TerminalView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> TerminalTab {
        let id = terminal.entity_id();
        let saved_id = terminal.read(cx).saved_id.clone();
        TerminalTab {
            id,
            saved_id,
            panes: vec![Self::pane(terminal, window, cx)],
            active: id,
            axis: Axis::Horizontal,
        }
    }

    fn push_terminal(
        &mut self,
        terminal: Entity<TerminalView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.tabs.push(Self::tab(terminal, window, cx));
    }

    #[cfg(test)]
    pub(super) fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let terminal = cx.new(|cx| TerminalView::new(window, cx));
        Self::with_terminal(terminal, window, cx)
    }

    pub(super) fn with_terminal(
        terminal: Entity<TerminalView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let active = terminal.entity_id();
        let tab = Self::tab(terminal, window, cx);
        let bounds_subscription = cx.observe_window_bounds(window, |view, window, cx| {
            view.window_state = Self::window_state(window);
            // ScrollHandle needs the new viewport bounds from the completed frame.
            let workspace = cx.entity().downgrade();
            window.on_next_frame(move |_, cx| {
                let _ = workspace.update(cx, |view, cx| {
                    if !view.tabs.is_empty() {
                        view.scroll.scroll_to_item(view.active_ix());
                        cx.notify();
                    }
                });
            });
        });
        let activation_subscription = cx.observe_window_activation(window, |view, window, cx| {
            view.reconnect_active(true, window, cx);
        });
        let reconnect_task = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                if this
                    .update_in(cx, |view, window, cx| {
                        view.reconnect_active(false, window, cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            palette: None,
            settings: Settings::default(),
            store: None,
            persistence_error: None,
            window_state: Self::window_state(window),
            _save_task: None,
            _quit_subscription: None,
            tabs: vec![tab],
            active,
            scroll: ScrollHandle::new(),
            dragging: None,
            scroll_frame_pending: false,
            _bounds_subscription: bounds_subscription,
            _activation_subscription: activation_subscription,
            _reconnect_task: reconnect_task,
        }
    }

    fn reconnect_active(&mut self, activated: bool, window: &Window, cx: &mut Context<Self>) {
        if window.is_window_active() && !self.tabs.is_empty() {
            for pane in &self.tabs[self.active_ix()].panes {
                pane.terminal.update(cx, |terminal, cx| {
                    if activated || terminal.reconnect_at.is_some() {
                        terminal.maybe_reconnect(cx);
                    }
                });
            }
        }
    }

    fn active_ix(&self) -> usize {
        self.tabs
            .iter()
            .position(|tab| tab.id == self.active)
            .expect("workspace has an active tab")
    }

    fn is_splittable(&self) -> bool {
        !self.tabs.is_empty() && self.tabs[self.active_ix()].panes.len() < 4
    }

    fn select_pane(&mut self, id: EntityId, cx: &mut Context<Self>) {
        if self.tabs.is_empty() {
            return;
        }
        let ix = self.active_ix();
        let tab = &mut self.tabs[ix];
        if tab.active != id && tab.panes.iter().any(|pane| pane.terminal.entity_id() == id) {
            tab.active = id;
            cx.notify();
        }
    }

    fn focus_pane(&mut self, id: EntityId, window: &mut Window, cx: &mut Context<Self>) {
        self.select_pane(id, cx);
        let focus = self.tabs[self.active_ix()]
            .active_terminal()
            .read(cx)
            .focus
            .clone();
        window.focus(&focus, cx);
    }

    fn split(&mut self, axis: Axis, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_splittable() {
            return;
        }
        let ix = self.active_ix();
        let active = self.tabs[ix].active_terminal().clone();
        let profile = active.read(cx).ssh_profile.clone();
        let mut snapshot = active.update(cx, |terminal, _| terminal.snapshot());
        snapshot.id = uuid::Uuid::new_v4().to_string();
        snapshot.output.clear();
        snapshot.scroll_offset = 0.;
        snapshot.browser = Default::default();
        let terminal = cx.new(|cx| {
            TerminalView::configured(
                snapshot,
                profile,
                self.store.clone(),
                &self.settings,
                window,
                cx,
            )
        });
        let id = terminal.entity_id();
        let pane = Self::pane(terminal, window, cx);
        let tab = &mut self.tabs[ix];
        if tab.panes.len() == 1 {
            tab.axis = axis;
        }
        tab.panes.push(pane);
        self.focus_pane(id, window, cx);
        cx.notify();
    }

    fn close_pane(&mut self, id: EntityId, window: &mut Window, cx: &mut Context<Self>) {
        let ix = self.active_ix();
        let tab = &mut self.tabs[ix];
        let Some(pane_ix) = tab
            .panes
            .iter()
            .position(|pane| pane.terminal.entity_id() == id)
        else {
            return;
        };
        if tab.panes.len() == 1 {
            let tab_id = tab.id;
            self.close(tab_id, window, cx);
            return;
        }
        tab.panes
            .remove(pane_ix)
            .terminal
            .update(cx, |terminal, _| terminal.close());
        if tab.active == id {
            tab.active = tab.panes[pane_ix.min(tab.panes.len() - 1)]
                .terminal
                .entity_id();
        }
        let next = tab.active;
        self.focus_pane(next, window, cx);
        cx.notify();
    }

    fn cycle_pane(&mut self, backwards: bool, window: &mut Window, cx: &mut Context<Self>) {
        let tab = &self.tabs[self.active_ix()];
        let len = tab.panes.len();
        let ix = tab
            .panes
            .iter()
            .position(|pane| pane.terminal.entity_id() == tab.active)
            .unwrap();
        let next = (ix + if backwards { len - 1 } else { 1 }) % len;
        self.focus_pane(tab.panes[next].terminal.entity_id(), window, cx);
    }

    fn render_panes(&self, cx: &mut Context<Self>) -> Div {
        let tab = &self.tabs[self.active_ix()];
        let split = tab.panes.len() > 1;
        div()
            .flex()
            .size_full()
            .min_w_0()
            .min_h_0()
            .when(tab.axis == Axis::Vertical, |layout| layout.flex_col())
            // Pane separators are physical hairlines.
            .when(split, |layout| layout.gap(px(1.)).bg(cx.theme().border))
            .children(tab.panes.iter().map(|pane| {
                let id = pane.terminal.entity_id();
                let title = Self::title(pane.terminal.read(cx));
                let selected = tab.active == id;
                div()
                    .id(("pane", id))
                    .test_support()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .relative()
                    .bg(cx.theme().background)
                    .overflow_hidden()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |view, _, _, cx| view.select_pane(id, cx)),
                    )
                    .when(split, |pane| {
                        pane.child(
                            div()
                                .flex()
                                .items_center()
                                .h_8()
                                .px_2()
                                .gap_2()
                                .flex_shrink_0()
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(move |view, _, window, cx| {
                                        view.focus_pane(id, window, cx);
                                    }),
                                )
                                .bg(if selected {
                                    cx.theme().tab_active
                                } else {
                                    cx.theme().title_bar
                                })
                                .child(
                                    Button::new(("focus-pane", id))
                                        .ghost()
                                        .small()
                                        .flex_1()
                                        .min_w_0()
                                        .child(div().min_w_0().truncate().child(title.clone()))
                                        .accessibility_label(format!("Focus {title}"))
                                        .on_click(cx.listener(move |view, _, window, cx| {
                                            view.focus_pane(id, window, cx)
                                        })),
                                )
                                .child(
                                    Button::new(("close-pane", id))
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::Close)
                                        .accessibility_label(format!("Close pane {title}"))
                                        .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                            cx.stop_propagation()
                                        })
                                        .on_click(cx.listener(move |view, _, window, cx| {
                                            cx.stop_propagation();
                                            view.close_pane(id, window, cx);
                                        })),
                                ),
                        )
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .min_w_0()
                            .child(pane.terminal.clone()),
                    )
                    .when(split && selected, |pane| {
                        pane.child(
                            div()
                                .absolute()
                                .inset_0()
                                .border_1()
                                .border_color(cx.theme().primary.opacity(0.3)),
                        )
                    })
            }))
    }

    fn activate(&mut self, id: EntityId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.tabs.iter().position(|tab| tab.id == id) else {
            return;
        };
        self.active = id;
        self.reconnect_active(true, window, cx);
        let focus = self.tabs[ix].active_terminal().read(cx).focus.clone();
        window.focus(&focus, cx);
        self.scroll.scroll_to_item(ix);
        cx.notify();
    }

    fn new_tab(&mut self, _: &NewTab, window: &mut Window, cx: &mut Context<Self>) {
        self.new_local_tab(
            self.settings.default_directory.clone(),
            None,
            None,
            window,
            cx,
        );
    }

    pub(super) fn open_urls(
        &mut self,
        urls: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for url in urls {
            match crate::automation::Request::parse(&url) {
                Ok(crate::automation::Request::Activate) => {}
                Ok(crate::automation::Request::NewTerminal {
                    directory,
                    title,
                    command,
                }) => {
                    self.new_local_tab(
                        directory.or_else(|| self.settings.default_directory.clone()),
                        title,
                        command,
                        window,
                        cx,
                    );
                }
                Err(error) => window.push_notification(
                    Notification::error(format!("Couldn’t open TerminalFlow link: {error}")),
                    cx,
                ),
            }
        }
        window.activate_window();
        cx.activate(true);
    }

    fn new_local_tab(
        &mut self,
        directory: Option<std::path::PathBuf>,
        title: Option<String>,
        command: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let snapshot = TabSnapshot {
            id: uuid::Uuid::new_v4().to_string(),
            source: TabSource::Local { directory },
            output: vec![],
            font_scale: 1.,
            scroll_offset: 0.,
            browser: Default::default(),
        };
        let terminal = cx.new(|cx| {
            let mut terminal = TerminalView::configured(
                snapshot,
                None,
                self.store.clone(),
                &self.settings,
                window,
                cx,
            );
            terminal.custom_title = title;
            if let Some(command) = command
                && let Err(error) = terminal.send_command(&command, None)
            {
                terminal.status = format!("Couldn’t run link command: {error}");
            }
            terminal
        });
        let id = terminal.entity_id();
        self.push_terminal(terminal, window, cx);
        self.activate(id, window, cx);
    }

    fn close(&mut self, id: EntityId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.tabs.iter().position(|tab| tab.id == id) else {
            return;
        };
        if self.dragging.as_ref().is_some_and(|drag| drag.tab == id) {
            cx.stop_active_drag(window);
            self.finish_drag(window, cx);
        }
        // Stop the PTY immediately, even if the previous frame still retains the entity.
        for pane in &self.tabs[ix].panes {
            pane.terminal.update(cx, |terminal, _| terminal.close());
        }
        self.tabs.remove(ix);
        if self.tabs.is_empty() {
            self.flush(cx);
            window.remove_window();
            return;
        }
        let next = if self.active == id {
            self.tabs[ix.min(self.tabs.len() - 1)].id
        } else {
            self.active
        };
        self.activate(next, window, cx);
    }

    fn cycle(&mut self, backwards: bool, window: &mut Window, cx: &mut Context<Self>) {
        let len = self.tabs.len();
        let ix = (self.active_ix() + if backwards { len - 1 } else { 1 }) % len;
        self.activate(self.tabs[ix].id, window, cx);
    }

    fn move_tab(&mut self, id: EntityId, to: usize, cx: &mut Context<Self>) {
        let Some(from) = self.tabs.iter().position(|tab| tab.id == id) else {
            return;
        };
        let to = to.min(self.tabs.len() - 1);
        if from != to {
            let tab = self.tabs.remove(from);
            self.tabs.insert(to, tab);
            cx.notify();
        }
    }

    fn begin_drag(&mut self, drag: DragTab, window: &mut Window, cx: &mut Context<Self>) {
        self.activate(drag.tab, window, cx);
        self.dragging = Some(drag);
        cx.notify();
    }

    fn finish_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dragging.take().is_some() {
            if !self.tabs.is_empty() {
                let focus = self.tabs[self.active_ix()]
                    .active_terminal()
                    .read(cx)
                    .focus
                    .clone();
                window.focus(&focus, cx);
            }
            cx.notify();
        }
    }

    fn drag_move(
        &mut self,
        event: &DragMoveEvent<DragTab>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let drag = event.drag(cx).clone();
        self.drag_step(&drag, event.bounds, event.event.position, window, cx);
    }

    fn drag_step(
        &mut self,
        drag: &DragTab,
        bounds: Bounds<Pixels>,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if drag.workspace != cx.entity_id()
            || self.dragging.is_none()
            || !cx.has_active_drag()
            || position.y < bounds.top()
            || position.y > bounds.bottom()
        {
            return;
        }
        let rem = window.rem_size();
        let edge = rem * 1.5;
        let direction = if position.x < bounds.left() + edge {
            -1.
        } else if position.x > bounds.right() - edge {
            1.
        } else {
            0.
        };
        let old_offset = self.scroll.offset();
        let offset = point(
            (old_offset.x - rem * 0.75 * direction).clamp(-self.scroll.max_offset().x, px(0.)),
            old_offset.y,
        );
        if offset != old_offset {
            self.scroll.set_offset(offset);
            cx.notify();
        }
        // Match w_48 + gap_2. Use logical slots, not animated hitboxes, to avoid flip-flopping.
        let stride = rem * 12.5;
        let left = position.x - drag.grab_offset.get() - bounds.left() - offset.x;
        let to = (f32::from(left) / f32::from(stride)).round().max(0.) as usize;
        self.move_tab(drag.tab, to, cx);
        if offset != old_offset && !self.scroll_frame_pending {
            self.scroll_frame_pending = true;
            let entity = cx.entity().downgrade();
            window.on_next_frame(move |window, cx| {
                let _ = entity.update(cx, |view, cx| {
                    view.scroll_frame_pending = false;
                    if let Some(drag) = view.dragging.clone() {
                        view.drag_step(
                            &drag,
                            view.scroll.bounds(),
                            window.mouse_position(),
                            window,
                            cx,
                        );
                    }
                });
            });
        }
    }

    fn numbered_tab(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape"
            && let Some(drag) = self.dragging.take()
        {
            self.move_tab(drag.tab, drag.original_ix, cx);
            cx.stop_active_drag(window);
            cx.notify();
            cx.stop_propagation();
            return;
        }
        let stroke = &event.keystroke;
        // Unavailable split shortcuts must not fall through as shell input (Ctrl-D exits).
        if !self.is_splittable()
            && stroke.key == "d"
            && ((stroke.modifiers.platform && !stroke.modifiers.control && !stroke.modifiers.alt)
                || (stroke.modifiers.control
                    && !stroke.modifiers.platform
                    && (stroke.modifiers.shift != stroke.modifiers.alt)))
        {
            cx.stop_propagation();
            return;
        }
        if (stroke.modifiers.platform || stroke.modifiers.control)
            && !stroke.modifiers.shift
            && !stroke.modifiers.alt
            && let Ok(number @ 1..=9) = stroke.key.parse::<usize>()
        {
            if let Some(tab) = self.tabs.get(number - 1) {
                self.activate(tab.id, window, cx);
            }
            cx.stop_propagation();
        }
    }

    pub(super) fn directory(terminal: &TerminalView) -> Option<std::path::PathBuf> {
        if matches!(terminal.source, TabSource::Ssh { .. }) {
            return None;
        }
        terminal
            .session
            .as_ref()
            .and_then(|session| {
                session
                    .terminal
                    .get_current_dir()
                    .and_then(|url| url.to_file_path().ok())
                    .or_else(|| session.current_directory.clone())
            })
            .or_else(std::env::home_dir)
    }

    fn title(terminal: &TerminalView) -> String {
        if let Some(title) = &terminal.custom_title {
            return title.clone();
        }
        if let Some(profile) = &terminal.ssh_profile {
            return profile.name.clone();
        }
        if matches!(terminal.source, TabSource::Ssh { .. }) {
            return "Missing SSH profile".into();
        }
        let directory = Self::directory(terminal);
        let directory = directory
            .as_deref()
            .map(|path| {
                if let Some(home) = std::env::home_dir()
                    && let Ok(relative) = path.strip_prefix(home)
                {
                    return if relative.as_os_str().is_empty() {
                        "~".into()
                    } else {
                        format!("~/{}", relative.display())
                    };
                }
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string())
            })
            .unwrap_or_else(|| "/".into());
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "shell".into());
        let shell = std::path::Path::new(&shell)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        format!("{directory} — {shell}")
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.tabs.is_empty() {
            return div().size_full().into_any_element();
        }
        let active = self.tabs[self.active_ix()].active_terminal().clone();
        let terminal = active.read(cx);
        let running = terminal.running;
        let connecting = terminal.connecting;
        let browser = terminal.browser.clone();
        let remote = matches!(terminal.source, TabSource::Ssh { .. });
        let directory = Self::directory(terminal);
        let splittable = self.is_splittable();
        let has_splits = self.tabs[self.active_ix()].panes.len() > 1;
        let panes = self.render_panes(cx);
        let title_bar_height = window.rem_size() * 3. + px(1.);
        let spacing = cx.theme().spacing_tokens();
        let tab_scroll = self.scroll.clone();
        let tab_edge_color = cx.theme().title_bar;
        // Native traffic lights are a physical platform boundary; center their 14 px frame.
        #[cfg(target_os = "macos")]
        window
            .set_traffic_light_position(point(px(16.), (title_bar_height - px(1.) - px(14.)) / 2.));
        let tabs = self
            .tabs
            .iter()
            .enumerate()
            .map(|(ix, tab)| {
                let id = tab.id;
                let menu_focus = tab.active_terminal().read(cx).focus.clone();
                let splittable = tab.panes.len() < 4;
                let terminal = tab.active_terminal().read(cx);
                let title = Self::title(terminal);
                let icon = terminal
                    .ssh_profile
                    .as_ref()
                    .map(|profile| profile.icon.clone());
                let (state, status_color) = if terminal.connecting {
                    ("Connecting", cx.theme().warning)
                } else if terminal.running {
                    ("Ready", cx.theme().success)
                } else {
                    ("Closed", cx.theme().danger)
                };
                let drag = DragTab {
                    workspace: cx.entity_id(),
                    tab: id,
                    title: title.clone(),
                    icon: icon.clone(),
                    status_color,
                    original_ix: ix,
                    grab_offset: Rc::new(Cell::new(px(0.))),
                    pointer_y: px(0.),
                };
                let dragging = cx.has_active_drag()
                    && self.dragging.as_ref().is_some_and(|drag| drag.tab == id);
                let motion = cx.theme().motion_tokens();
                let duration = if dragging {
                    motion.duration_instant
                } else {
                    motion.duration_fast
                };
                let visual_ix = transition(
                    (("tab", id), "position"),
                    ix as f32,
                    Transition::new(duration).easing(motion.easing_move.clone()),
                    window,
                    cx,
                );
                let displacement = window.rem_size() * 12.5 * (visual_ix - ix as f32);
                let workspace = cx.entity().downgrade();
                // The slot stays still for hit testing while its contents slide into place.
                div()
                    .id(("tab", id))
                    .test_support()
                    .w_48()
                    .flex_shrink_0()
                    .child(
                        div()
                            .id(("tab-content", id))
                            .test_support()
                            .relative()
                            .left(displacement)
                            .opacity(if dragging { 0.25 } else { 1. })
                            .child(
                                terminal_tab(("tab-surface", id), id == self.active, cx)
                                    .on_mouse_down(
                                        MouseButton::Middle,
                                        cx.listener(move |view, _, window, cx| {
                                            cx.stop_propagation();
                                            view.close(id, window, cx);
                                        }),
                                    )
                                    .on_drag(drag, move |drag, offset, window, cx| {
                                        drag.grab_offset.set(offset.x);
                                        let mut preview = drag.clone();
                                        preview.pointer_y = window.mouse_position().y;
                                        let _ = workspace.update(cx, |view, cx| {
                                            view.begin_drag(drag.clone(), window, cx)
                                        });
                                        cx.new(|_| preview)
                                    })
                                    .accessibility_label(format!("{title}, {state}"))
                                    .child(
                                        div()
                                            .id(("tab-status", id))
                                            .test_support()
                                            .role(Role::Status)
                                            .aria_label(state)
                                            .size_1p5()
                                            .rounded_full()
                                            .bg(status_color),
                                    )
                                    .when_some(icon.as_deref(), |tab, icon| {
                                        tab.child(
                                            crate::ssh_icons::image(icon)
                                                .size_3p5()
                                                .flex_shrink_0(),
                                        )
                                    })
                                    .child(div().flex_1().min_w_0().truncate().child(title.clone()))
                                    .child(
                                        Button::new(("close-tab", id))
                                            .ghost()
                                            .xsmall()
                                            .icon(IconName::Close)
                                            .accessibility_label(format!("Close {title}"))
                                            .tooltip(format!("Close {title}"))
                                            .on_click(cx.listener(move |view, _, window, cx| {
                                                cx.stop_propagation();
                                                view.close(id, window, cx);
                                            })),
                                    )
                                    .on_click(cx.listener(move |view, _, window, cx| {
                                        view.activate(id, window, cx)
                                    }))
                                    .capture_any_mouse_down(cx.listener(
                                        move |view, event: &MouseDownEvent, window, cx| {
                                            if event.button == MouseButton::Right {
                                                view.activate(id, window, cx);
                                            }
                                        },
                                    ))
                                    .context_menu(move |menu, _, _| {
                                        menu.action_context(menu_focus.clone())
                                            .menu_with_icon_and_disabled(
                                                "Split right",
                                                IconName::PanelRight,
                                                Box::new(crate::SplitRight),
                                                !splittable,
                                            )
                                            .menu_with_icon_and_disabled(
                                                "Split down",
                                                IconName::PanelBottom,
                                                Box::new(crate::SplitDown),
                                                !splittable,
                                            )
                                            .separator()
                                            .menu_with_icon(
                                                "Close tab",
                                                IconName::Close,
                                                Box::new(CloseTab),
                                            )
                                    }),
                            ),
                    )
            })
            .collect::<Vec<_>>();
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .key_context("Workspace")
            .capture_key_down(cx.listener(Self::numbered_tab))
            .on_action(cx.listener(Self::new_tab))
            .when(splittable, |view| view
                .on_action(cx.listener(|view, _: &crate::SplitRight, window, cx| view.split(Axis::Horizontal, window, cx)))
                .on_action(cx.listener(|view, _: &crate::SplitDown, window, cx| view.split(Axis::Vertical, window, cx))))
            .on_action(cx.listener(|view, _: &crate::ClosePane, window, cx| {
                let id = view.tabs[view.active_ix()].active;
                view.close_pane(id, window, cx);
            }))
            .when(has_splits, |view| view
                .on_action(cx.listener(|view, _: &crate::NextPane, window, cx| view.cycle_pane(false, window, cx)))
                .on_action(cx.listener(|view, _: &crate::PreviousPane, window, cx| view.cycle_pane(true, window, cx))))
            .on_action(cx.listener(|_, _: &crate::OpenCommandPalette, window, cx| {
                let owner = cx.entity();
                window.defer(cx, move |window, cx| crate::palette::open(&owner, window, cx));
            }))
            .on_action(cx.listener(|_, _: &crate::OpenFile, window, cx| crate::editor::open_picker(window, cx)))
            .on_action(cx.listener(|_, _: &OpenSettings, window, cx| {
                let owner = cx.entity();
                window.defer(cx, move |window, cx| {
                    dialogs::open_settings(&owner, window, cx)
                });
            }))
            .on_action(cx.listener(|_, _: &AddSshServer, window, cx| {
                dialogs::open_ssh(&cx.entity(), None, window, cx)
            }))
            .on_action(cx.listener(|_, _: &ManageSshServers, window, cx| {
                dialogs::open_servers(&cx.entity(), window, cx)
            }))
            .on_action(
                cx.listener(|view, _: &CloseTab, window, cx| view.close(view.active, window, cx)),
            )
            .on_action(cx.listener(|view, _: &NextTab, window, cx| view.cycle(false, window, cx)))
            .on_action(
                cx.listener(|view, _: &PreviousTab, window, cx| view.cycle(true, window, cx)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(title_bar_height)
                    .pr_3()
                    .flex_shrink_0()
                    .bg(cx.theme().title_bar)
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        TitleBar::new()
                            .h_full()
                            .bg(cx.theme().title_bar)
                            .border_0()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .pr_4()
                                    .flex_shrink_0()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("TerminalFlow"),
                                    )
                                    .child(
                                        div()
                                            .id("tab-count")
                                            .test_support()
                                            .text_xs()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(format!(
                                                "{} {}",
                                                self.tabs.len(),
                                                if self.tabs.len() == 1 { "tab" } else { "tabs" }
                                            )),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .relative()
                            .h_full()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .id("tab-strip")
                                    .test_support()
                                    .flex()
                                    .gap_2()
                                    .h_full()
                                    .items_center()
                                    .w_full()
                                    .min_w_0()
                                    .overflow_x_scroll()
                                    .track_scroll(&self.scroll)
                                    .on_mouse_down(MouseButton::Left, |_, window, _| {
                                        window.start_window_move();
                                    })
                                    .on_mouse_up_out(
                                        MouseButton::Left,
                                        cx.listener(|view, _, window, cx| {
                                            view.finish_drag(window, cx)
                                        }),
                                    )
                                    .on_drag_move::<DragTab>(cx.listener(Self::drag_move))
                                    .on_drop(cx.listener(|view, _: &DragTab, window, cx| {
                                        view.finish_drag(window, cx)
                                    }))
                                    .children(tabs),
                            )
                            // Paint after scroll layout so wheel and drag updates
                            // use the current offset. Canvas leaves pointer input on the tabs.
                            .child(
                                canvas(
                                    |_, _, _| (),
                                    move |bounds, _, window, _| {
                                        let hidden_left = -tab_scroll.offset().x;
                                        let hidden_right = tab_scroll.max_offset().x - hidden_left;
                                        for (hidden, left, angle) in
                                            [(hidden_left, true, 90.), (hidden_right, false, 270.)]
                                        {
                                            let width =
                                                spacing.xl.min(hidden).min(bounds.size.width / 2.);
                                            if width <= px(0.) {
                                                continue;
                                            }
                                            let origin = if left {
                                                bounds.origin
                                            } else {
                                                point(bounds.right() - width, bounds.top())
                                            };
                                            window.paint_quad(fill(
                                                Bounds::new(
                                                    origin,
                                                    size(width, bounds.size.height),
                                                ),
                                                linear_gradient(
                                                    angle,
                                                    linear_color_stop(tab_edge_color, 0.),
                                                    linear_color_stop(
                                                        tab_edge_color.opacity(0.),
                                                        1.,
                                                    ),
                                                ),
                                            ));
                                        }
                                    },
                                )
                                .absolute()
                                .inset_0(),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .pl_4()
                            .flex_shrink_0()
                            .child(
                                Button::new("new-tab")
                                    .outline()
                                    .bg(cx.theme().tab)
                                    .icon(IconName::Plus)
                                    .accessibility_label("New tab")
                                    .tooltip("New tab (Cmd/Ctrl+T)")
                                    .on_click(cx.listener(|view, _, window, cx| {
                                        view.new_tab(&NewTab, window, cx)
                                    })),
                            )
                            .child(
                                Button::new("open-folder")
                                    .outline()
                                    .bg(cx.theme().tab)
                                    .icon(gpui_kit::assets::IconName::FolderOpen)
                                    .accessibility_label(if remote { "Toggle SFTP browser" } else { "Reveal current directory" })
                                    .tooltip(if remote { "SFTP browser" } else { "Reveal current directory" })
                                    .disabled(if remote { browser.is_none() } else { directory.is_none() })
                                    .on_click({
                                        let browser = browser.clone();
                                        let active = active.clone();
                                        move |_, window, cx| {
                                            if let Some(browser) = &browser {
                                                let directory = active.read(cx).session.as_ref().and_then(|session| session.terminal.get_current_dir()).and_then(|url| url.to_file_path().ok()).map(|path| path.to_string_lossy().into_owned());
                                                browser.update(cx, |browser, cx| browser.toggle(directory, window, cx));
                                                if !browser.read(cx).is_open() { let focus = active.read(cx).focus.clone(); window.focus(&focus, cx); }
                                            } else if let Some(directory) = &directory { cx.open_with_system(directory); }
                                        }
                                    }),
                            )
                            .child(
                                Button::new("workspace-menu")
                                    .outline()
                                    .bg(cx.theme().tab)
                                    .icon(gpui_kit::assets::IconName::Server)
                                    .accessibility_label("Workspace menu")
                                    .tooltip("Workspace menu")
                                    .dropdown_menu_with_anchor(Anchor::TopRight, {
                                        let workspace = cx.entity().downgrade();
                                        move |mut menu, window, cx| {
                                            menu = menu
                                                .min_w(window.rem_size() * 14.4)
                                                .max_w(window.rem_size() * 14.4)
                                                .max_h(window.window_bounds().get_bounds().size.height * 0.75)
                                                .scrollable(true);
                                            for (id, label, icon, action) in [
                                                ("server-menu-settings", "Settings", gpui_kit::assets::IconName::Settings, Box::new(OpenSettings) as Box<dyn Action>),
                                                ("server-menu-add", "Add SSH Server", gpui_kit::assets::IconName::CirclePlus, Box::new(AddSshServer) as Box<dyn Action>),
                                            ] {
                                                menu = menu.item(
                                                    PopupMenuItem::element(move |_, _| {
                                                        div()
                                                            .id(id)
                                                            .test_support()
                                                            .role(Role::MenuItem)
                                                            .aria_label(label)
                                                            .flex()
                                                            .items_center()
                                                            .gap_2()
                                                            .py_1()
                                                            .child(Icon::new(icon).size_4())
                                                            .child(label)
                                                    })
                                                    .action(action),
                                                );
                                            }
                                            if let Some(workspace) = workspace.upgrade() {
                                                let profiles = &workspace.read(cx).settings.ssh_servers;
                                                if !profiles.is_empty() {
                                                    menu = menu.separator();
                                                }
                                                for profile in profiles {
                                                    let id = profile.id.clone();
                                                    let row_id = SharedString::from(format!("server-menu-{}", profile.id));
                                                    let name = profile.name.clone();
                                                    let icon = profile.icon.clone();
                                                    let address = format!("{}@{}:{}", profile.username, profile.host, profile.port);
                                                    let owner = workspace.downgrade();
                                                    let edit_owner = owner.clone();
                                                    let edit_profile = profile.clone();
                                                    let menu_focus = menu.focus_handle(cx);
                                                    menu = menu.item(
                                                        PopupMenuItem::element(move |_, cx| {
                                                            div()
                                                                .id(row_id.clone())
                                                                .group(row_id.clone())
                                                                .test_support()
                                                                .role(Role::MenuItem)
                                                                .aria_label(format!("{name}, {address}"))
                                                                .flex()
                                                                .items_center()
                                                                .w_full()
                                                                .gap_2()
                                                                .py_1()
                                                                .child(
                                                                    div()
                                                                        .size_7()
                                                                        .flex_shrink_0()
                                                                        .flex()
                                                                        .items_center()
                                                                        .justify_center()
                                                                        .rounded(px(10.))
                                                                        .border_1()
                                                                        .border_color(cx.theme().border.alpha(0.5))
                                                                        .bg(cx.theme().title_bar)
                                                                        .child(crate::ssh_icons::image(&icon).size_3p5()),
                                                                )
                                                                .child(
                                                                    div()
                                                                        .flex()
                                                                        .flex_col()
                                                                        .flex_1()
                                                                        .min_w_0()
                                                                        .line_height(relative(1.45))
                                                                        .child(div().truncate().text_xs().font_weight(FontWeight::SEMIBOLD).child(name.clone()))
                                                                        .child(div().truncate().text_xs().text_color(cx.theme().muted_foreground).child(address.clone())),
                                                                )
                                                                .child(
                                                                    Button::new(SharedString::from(format!("server-menu-edit-{}", edit_profile.id)))
                                                                        .xsmall()
                                                                        .ghost()
                                                                        .flex_shrink_0()
                                                                        .icon(gpui_kit::assets::IconName::Pencil)
                                                                        .accessibility_label(format!("Edit {}", edit_profile.name))
                                                                        .tooltip("Edit SSH server")
                                                                        .invisible()
                                                                        .group_hover(row_id.clone(), |style| style.visible())
                                                                        .on_click({
                                                                            let owner = edit_owner.clone();
                                                                            let profile = edit_profile.clone();
                                                                            let menu_focus = menu_focus.clone();
                                                                            move |_, window, cx| {
                                                                                cx.stop_propagation();
                                                                                menu_focus.dispatch_action(&gpui_kit::base::actions::Cancel, window, cx);
                                                                                let owner = owner.clone();
                                                                                let profile = profile.clone();
                                                                                // Let the menu restore focus before the dialog captures it.
                                                                                window.defer(cx, move |window, cx| {
                                                                                    if let Some(owner) = owner.upgrade() {
                                                                                        dialogs::open_ssh(&owner, Some(profile), window, cx);
                                                                                    }
                                                                                });
                                                                            }
                                                                        }),
                                                                )
                                                        })
                                                        .on_click(move |_, window, cx| {
                                                            let _ = owner.update(cx, |view, cx| {
                                                                view.connect(&id, window, cx)
                                                            });
                                                        }),
                                                    );
                                                }
                                            }
                                            menu
                                        }
                                    }),
                            ),
                    )
                    .when(!remote && !running && !connecting, |bar| {
                        bar.child(
                            Button::new("restart")
                                .outline()
                                .small()
                                .label("Restart shell")
                                .on_click({
                                    let active = active.clone();
                                    move |_, window, cx| {
                                        active.update(cx, |view, cx| {
                                            view.restart(&Restart, window, cx)
                                        })
                                    }
                                }),
                        )
                    }),
            )
            .when_some(self.persistence_error.clone(), |view, message| {
                view.child(
                    div()
                        .px_4()
                        .py_2()
                        .text_sm()
                        .text_color(cx.theme().danger)
                        .child(message),
                )
            })
            .child(div().flex_1().min_w_0().min_h_0().relative().map(|content| {
                if let Some(browser) = browser.filter(|browser| browser.read(cx).is_open()) {
                    let width = window.rem_size() * browser.read(cx).snapshot().width;
                    if window.window_bounds().get_bounds().size.width < window.rem_size() * 56.25 {
                        content.child(panes).child(div().absolute().right_0().top_0().bottom_0().w(width.min(window.window_bounds().get_bounds().size.width * 0.75)).border_l_1().border_color(cx.theme().border).child(browser))
                    } else {
                        let state = browser.read(cx).resize.clone();
                        let owner = browser.downgrade();
                        content.child(h_resizable(("sftp-layout", active.entity_id())).with_state(&state)
                            .child(resizable_panel().size_range(window.rem_size()*20. .. window.rem_size()*250.).child(panes))
                            .child(resizable_panel().size(width).size_range(window.rem_size()*15. .. window.rem_size()*40.).child(browser))
                            .on_resize(move |state, window, cx| { if let Some(width) = state.read(cx).sizes().get(1).copied() { let _ = owner.update(cx, |browser, cx| browser.record_width(width, window, cx)); } }))
                    }
                } else { content.child(panes) }
            }))
            .children(self.palette.clone())
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{TerminalView, Workspace};
    use crate::storage::{
        Authentication, Settings, Snapshot, SshProfile, Store, TabSnapshot, TabSource,
    };
    use crate::{bind_keys, session::Output};
    use gpui_kit::{
        App, AppContext, Entity, InputEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
        MouseUpEvent, Pixels, Point, ScrollDelta, TestAppContext, VisualTestContext, Window,
        WindowHandle,
        component::{ActiveTheme, Root},
        point, px, size,
        test::{ClickOptions, TestWindowExt},
    };
    use std::{
        io::Write,
        sync::{
            Arc,
            mpsc::{self, Receiver, Sender},
        },
        time::{Duration, Instant},
    };

    #[gpui_kit::test]
    fn saved_tabs_restore_order_directory_history_zoom_and_active_selection(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            bind_keys(cx);
        });
        let store = Store::at(
            std::env::temp_dir().join(format!("terminal-restore-test-{}", uuid::Uuid::new_v4())),
        );
        let first_id = uuid::Uuid::new_v4().to_string();
        let second_id = uuid::Uuid::new_v4().to_string();
        let directory = std::env::temp_dir().canonicalize().unwrap();
        let initial = Snapshot {
            version: 1,
            active_tab: Some(second_id.clone()),
            tabs: vec![
                TabSnapshot {
                    id: first_id.clone(),
                    source: TabSource::Local {
                        directory: Some(directory.clone()),
                    },
                    output: vec![
                        "saved Unicode 密碼 output".into(),
                        "\x1b]52;c;unsafe\x07".into(),
                    ],
                    font_scale: 1.4,
                    scroll_offset: 0.,
                    browser: Default::default(),
                },
                TabSnapshot {
                    id: second_id.clone(),
                    source: TabSource::Local {
                        directory: Some(directory.clone()),
                    },
                    output: vec!["second terminal".into()],
                    font_scale: 0.9,
                    scroll_offset: 0.,
                    browser: Default::default(),
                },
            ],
        };
        let mut owner = None;
        let handle = cx.open_window(size(px(1000.), px(600.)), |window, cx| {
            let workspace = cx.new(|cx| {
                Workspace::restore(
                    Some(store.clone()),
                    Settings::default(),
                    initial,
                    None,
                    window,
                    cx,
                )
            });
            owner = Some(workspace.clone());
            Root::new(workspace, window, cx)
        });
        let owner = owner.unwrap();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let view = owner.read(cx);
            assert_eq!(view.tabs.len(), 2);
            assert_eq!(view.tabs[0].panes[0].terminal.read(cx).saved_id, first_id);
            assert_eq!(view.tabs[1].panes[0].terminal.read(cx).saved_id, second_id);
            assert_eq!(view.active, view.tabs[1].panes[0].terminal.entity_id());
            let first = view.tabs[0].panes[0].terminal.read(cx);
            assert_eq!(first.font_scale, 1.4);
            assert_eq!(
                first.session.as_ref().unwrap().current_directory.as_ref(),
                Some(&directory)
            );
            assert!(
                crate::screen_text(first.session.as_ref().unwrap(), 0.)
                    .contains("saved Unicode 密碼 output")
            );
            assert_eq!(window.find("terminal").focused(), Some(true));
            owner.update(cx, |view, cx| view.flush(cx));
            window.remove_window();
        })
        .unwrap();
        let saved: Snapshot = store.load("terminal-session.json").unwrap();
        assert_eq!(saved.active_tab, Some(second_id));
        assert_eq!(saved.tabs[0].font_scale, 1.4);
        assert_eq!(saved.tabs[1].font_scale, 0.9);
        std::fs::remove_dir_all(store.directory()).unwrap();
    }
    use wezterm_term::{Terminal, TerminalConfiguration, TerminalSize, color::ColorPalette};

    #[derive(Debug)]
    struct Configuration;
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

    fn capture(
        terminal: &Entity<TerminalView>,
        cx: &mut App,
    ) -> (Receiver<Vec<u8>>, Sender<Output>) {
        let (writer, input) = mpsc::channel();
        let (output, reader) = mpsc::channel();
        terminal.update(cx, |view, _| {
            let session = view.session.as_mut().unwrap();
            session.output = reader;
            session.terminal = Terminal::new(
                TerminalSize::default(),
                Arc::new(Configuration),
                "test",
                "1",
                Box::new(Writer(writer)),
            );
        });
        (input, output)
    }

    fn open(cx: &mut TestAppContext) -> (WindowHandle<Root>, Entity<Workspace>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            bind_keys(cx);
        });
        let mut workspace = None;
        let handle = cx.open_window(size(px(1000.), px(600.)), |window, cx| {
            let view = cx.new(|cx| Workspace::new(window, cx));
            workspace = Some(view.clone());
            Root::new(view, window, cx)
        });
        (handle, workspace.unwrap())
    }

    #[gpui_kit::test]
    fn automation_opens_a_focused_local_tab_and_runs_the_command_once(cx: &mut TestAppContext) {
        let directory =
            std::env::temp_dir().join(format!("terminalflow + 密碼 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let first = workspace.read(cx).tabs[0].active_terminal().clone();
            let (input, _) = capture(&first, cx);
            workspace.update(cx, |view, cx| view.open_urls(vec!["terminalflow://activate".into()], window, cx));
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            assert_eq!(workspace.read(cx).active, first.entity_id());

            workspace.update(cx, |view, cx| view.open_urls(vec!["terminalflow://new-terminal?cwd=relative&command=touch%20bad".into()], window, cx));
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            assert!(input.try_recv().is_err());

            let mut url = gpui_kit::http_client::Url::parse("terminalflow://new-terminal").unwrap();
            url.query_pairs_mut()
                .append_pair("cwd", directory.to_str().unwrap())
                .append_pair("title", "Build + 密碼")
                .append_pair("command", "printf '%s' \"$PWD\" > result.txt\nprintf '\\nAUTOMATION_OK\\n'");
            workspace.update(cx, |view, cx| view.open_urls(vec![url.into()], window, cx));
            assert_eq!(workspace.read(cx).tabs.len(), 2);
            let terminal = workspace.read(cx).tabs[1].active_terminal().clone();
            assert_eq!(workspace.read(cx).active, terminal.entity_id());
            assert_eq!(Workspace::title(terminal.read(cx)), "Build + 密碼");
            assert!(terminal.read(cx).focus.is_focused(window));
            assert!(matches!(&terminal.read(cx).source, TabSource::Local { directory: Some(cwd) } if cwd == &directory));
            assert!(input.try_recv().is_err());

            terminal.update(cx, |view, _| {
                let session = view.session.as_mut().unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut output = Vec::new();
                while !String::from_utf8_lossy(&output).contains("\r\nAUTOMATION_OK\r\n") {
                    match session.output.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap() {
                        Output::Bytes(bytes) => output.extend(bytes),
                        _ => panic!("Shell exited before running the link command"),
                    }
                }
            });
            assert_eq!(std::fs::read_to_string(directory.join("result.txt")).unwrap(), directory.to_str().unwrap());
            // Activating the app again must neither add a tab nor replay the command.
            std::fs::remove_file(directory.join("result.txt")).unwrap();
            workspace.update(cx, |view, cx| view.open_urls(vec!["terminalflow://activate".into()], window, cx));
            assert_eq!(workspace.read(cx).tabs.len(), 2);
            assert!(!directory.join("result.txt").exists());
            window.render_frame(cx);
            assert_eq!(window.find("terminal").focused(), Some(true));
            window.remove_window();
        }).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[gpui_kit::test]
    fn tab_context_menu_targets_clicked_tab_and_respects_pane_limit(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        let first = cx
            .update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                let first = workspace.read(cx).tabs[0].id;
                window.press("cmd-t", cx);
                window.right_click(("tab", first), cx);
                first
            })
            .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(workspace.read(cx).active, first);
            let menu = window.within("popup-menu");
            assert_eq!(menu.find(0usize).label(), Some("Split right"));
            assert_eq!(menu.find(1usize).label(), Some("Split down"));
            assert_eq!(menu.find(3usize).label(), Some("Close tab"));
            window.dispatch_keystroke(gpui_kit::Keystroke::parse("escape").unwrap(), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(
                window.try_find("popup-menu").is_none(),
                "Escape dismisses the tab menu"
            );
            assert!(
                workspace.read(cx).tabs[0]
                    .active_terminal()
                    .read(cx)
                    .focus
                    .is_focused(window)
            );
            window.press("cmd-2", cx);
            window.right_click(("tab", first), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.within("popup-menu").click(1usize, cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(workspace.read(cx).tabs[0].panes.len(), 2);
            assert_eq!(workspace.read(cx).tabs[0].axis, gpui_kit::Axis::Vertical);
            assert_eq!(workspace.read(cx).tabs[1].panes.len(), 1);
            window.right_click(("tab", first), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.within("popup-menu").click(0usize, cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.press("cmd-d", cx);
            assert_eq!(workspace.read(cx).tabs[0].panes.len(), 4);
            window.right_click(("tab", first), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.within("popup-menu").click(0usize, cx);
            assert_eq!(workspace.read(cx).tabs[0].panes.len(), 4);
            // Disabled splits are skipped by keyboard navigation, leaving Close tab.
            window.press("down", cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            assert_ne!(workspace.read(cx).active, first);
            assert!(
                workspace.read(cx).tabs[0]
                    .active_terminal()
                    .read(cx)
                    .focus
                    .is_focused(window)
            );
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn appearance_updates_every_open_pane_and_new_tabs(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        let store = Store::at(
            std::env::temp_dir().join(format!("terminal-appearance-test-{}", uuid::Uuid::new_v4())),
        );
        cx.update_window(handle.into(), |_, window, cx| {
            workspace.update(cx, |workspace, _| workspace.store = Some(store.clone()));
            window.render_frame(cx);
            window.press("cmd-d", cx);
            window.press("cmd-t", cx);
            let mut settings = workspace.read(cx).settings.clone();
            settings.font_family = "Hack".into();
            settings.font_size = 18.;
            settings.appearance.scheme = "one-light".into();
            settings.appearance.font_weight = 600;
            settings.appearance.line_height = 1.8;
            settings.appearance.cursor_color = Some("#ff0000".into());
            settings.appearance.selection_color = Some("#123456".into());
            let first = workspace.read(cx).tabs[0].panes[0].terminal.clone();
            first.update(cx, |view, _| {
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes(b"preserved\x1b]11;#222222\x07")
            });
            workspace.update(cx, |workspace, cx| {
                workspace.save_settings(settings.clone(), cx).unwrap()
            });
            window.render_frame(cx);
            window.press("cmd-t", cx);
            for pane in workspace.read(cx).tabs.iter().flat_map(|tab| &tab.panes) {
                let terminal = pane.terminal.read(cx);
                assert_eq!(terminal.font_family, "Hack");
                assert_eq!(terminal.font_size, 18.);
                assert_eq!(terminal.appearance, settings.appearance);
                assert_eq!(
                    terminal.session.as_ref().unwrap().terminal.palette(),
                    settings.appearance.palette()
                );
            }
            assert!(
                first
                    .read(cx)
                    .session
                    .as_ref()
                    .unwrap()
                    .terminal
                    .screen()
                    .lines_in_phys_range(0..1)[0]
                    .as_str()
                    .contains("preserved")
            );
            window.remove_window();
        })
        .unwrap();
        std::fs::remove_dir_all(store.directory()).unwrap();
    }

    #[gpui_kit::test]
    fn split_panes_isolate_sessions_keep_orientation_and_close_independently(
        cx: &mut TestAppContext,
    ) {
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let first = workspace.read(cx).tabs[0].active_terminal().clone();
            let tab_id = first.entity_id();
            let saved_id = first.read(cx).saved_id.clone();
            let (first_input, first_output) = capture(&first, cx);
            first_output
                .send(Output::Bytes(
                    b"first output\x1b]7;file:///tmp\x07".to_vec(),
                ))
                .unwrap();
            first.update(cx, |view, cx| view.read_output(cx));
            let initial_cols = first
                .read(cx)
                .session
                .as_ref()
                .unwrap()
                .terminal
                .get_size()
                .cols;
            window.press("cmd-d", cx);
            let second = workspace.read(cx).tabs[0].active_terminal().clone();
            let second_id = second.entity_id();
            let (second_input, second_output) = capture(&second, cx);
            window.render_frame(cx);
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            assert_eq!(workspace.read(cx).tabs[0].panes.len(), 2);
            assert_eq!(workspace.read(cx).tabs[0].axis, gpui_kit::Axis::Horizontal);
            assert_eq!(
                second
                    .read(cx)
                    .session
                    .as_ref()
                    .unwrap()
                    .current_directory
                    .as_deref(),
                Some(
                    std::path::Path::new("/tmp")
                        .canonicalize()
                        .unwrap()
                        .as_path()
                )
            );
            let left = window.find(("pane", tab_id)).bounds();
            let right = window.find(("pane", second_id)).bounds();
            assert_eq!(left.size, right.size);
            assert_eq!(left.right() + px(1.), right.left());
            assert!(
                first
                    .read(cx)
                    .session
                    .as_ref()
                    .unwrap()
                    .terminal
                    .get_size()
                    .cols
                    < initial_cols
            );
            assert!(second.read(cx).focus.is_focused(window));
            second_output
                .send(Output::Bytes(b"second output".to_vec()))
                .unwrap();
            second.update(cx, |view, cx| view.read_output(cx));
            window.render_frame(cx);
            assert!(
                window
                    .within(("pane", tab_id))
                    .find("terminal")
                    .value()
                    .unwrap()
                    .contains("first output")
            );
            assert!(
                window
                    .within(("pane", second_id))
                    .find("terminal")
                    .value()
                    .unwrap()
                    .contains("second output")
            );
            assert!(
                !window
                    .within(("pane", second_id))
                    .find("terminal")
                    .value()
                    .unwrap()
                    .contains("first output")
            );
            window.input("x", cx);
            assert_eq!(
                second_input.recv_timeout(Duration::from_secs(1)).unwrap(),
                b"x"
            );
            assert!(first_input.try_recv().is_err());
            window.click(("focus-pane", tab_id), cx);
            assert_eq!(workspace.read(cx).tabs[0].active, tab_id);
            window.press("cmd-alt-right", cx);
            window
                .within(("pane", tab_id))
                .click_at("terminal", point(px(10.), px(10.)), cx);
            assert_eq!(workspace.read(cx).tabs[0].active, tab_id);
            assert!(first.read(cx).focus.is_focused(window));
            window.input("y", cx);
            assert_eq!(
                first_input.recv_timeout(Duration::from_secs(1)).unwrap(),
                b"y"
            );
            assert!(second_input.try_recv().is_err());
            window.press("cmd-alt-right", cx);
            assert_eq!(workspace.read(cx).tabs[0].active, second_id);
            window.press("cmd-alt-right", cx);
            assert_eq!(workspace.read(cx).tabs[0].active, tab_id);
            window.press("ctrl-alt-left", cx);
            assert_eq!(workspace.read(cx).tabs[0].active, second_id);
            window.press("cmd-f", cx);
            assert!(second.read(cx).search_open);
            assert!(!first.read(cx).search_open);
            window.press("escape", cx);
            window.press("cmd-shift-d", cx);
            window.press("ctrl-shift-d", cx);
            assert_eq!(workspace.read(cx).tabs[0].axis, gpui_kit::Axis::Horizontal);
            assert_eq!(workspace.read(cx).tabs[0].panes.len(), 4);
            assert!(!window.is_action_available(&crate::SplitRight, cx));
            assert!(!window.is_action_available(&crate::SplitDown, cx));
            let fourth = workspace.read(cx).tabs[0].active_terminal().clone();
            let (fourth_input, _fourth_output) = capture(&fourth, cx);
            window.press("ctrl-shift-d", cx);
            window.press("ctrl-alt-d", cx);
            window.press("cmd-d", cx);
            assert!(
                fourth_input.try_recv().is_err(),
                "disabled split shortcuts never reach the shell"
            );
            workspace.update(cx, |view, cx| {
                view.split(gpui_kit::Axis::Vertical, window, cx)
            });
            assert_eq!(workspace.read(cx).tabs[0].panes.len(), 4);
            window.resize(size(px(640.), px(480.)));
            window.bounds_changed(cx);
            window.render_frame(cx);
            for pane in &workspace.read(cx).tabs[0].panes {
                let bounds = window.find(("pane", pane.terminal.entity_id())).bounds();
                assert!(bounds.size.width > px(0.));
                assert!(bounds.right() <= px(640.));
                assert!(
                    pane.terminal
                        .read(cx)
                        .session
                        .as_ref()
                        .unwrap()
                        .terminal
                        .get_size()
                        .rows
                        > 0
                );
            }
            window.press("cmd-shift-w", cx);
            let active_before_close = workspace.read(cx).tabs[0].active;
            window.click(("close-pane", tab_id), cx);
            assert_eq!(
                workspace.read(cx).tabs[0].active,
                active_before_close,
                "closing an inactive pane preserves the active pane"
            );
            assert!(first.read(cx).session.is_none());
            assert_eq!(
                workspace.read(cx).active,
                tab_id,
                "tab identity survives closing its original pane"
            );
            assert_eq!(workspace.read(cx).tabs[0].panes.len(), 2);
            let snapshot = workspace.update(cx, |view, cx| view.snapshot(cx));
            assert_eq!(snapshot.tabs.len(), 1);
            assert_eq!(snapshot.tabs[0].id, saved_id);
            assert_eq!(snapshot.active_tab, Some(saved_id));
            let active = workspace.read(cx).tabs[0].active;
            window.press("cmd-t", cx);
            window.press("cmd-1", cx);
            assert_eq!(workspace.read(cx).tabs[0].active, active);
            assert!(
                workspace.read(cx).tabs[0]
                    .active_terminal()
                    .read(cx)
                    .focus
                    .is_focused(window)
            );
            let remaining: Vec<_> = workspace.read(cx).tabs[0]
                .panes
                .iter()
                .map(|pane| pane.terminal.clone())
                .collect();
            window.press("cmd-w", cx);
            assert!(remaining.iter().all(|pane| pane.read(cx).session.is_none()));
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            window.press("ctrl-shift-w", cx);
            assert!(workspace.read(cx).tabs.is_empty());
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn split_down_keeps_equal_rows_and_ssh_profile_and_directory(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.press("cmd-shift-d", cx);
            window.press("cmd-d", cx);
            assert_eq!(workspace.read(cx).tabs[0].axis, gpui_kit::Axis::Vertical);
            let panes: Vec<_> = workspace.read(cx).tabs[0]
                .panes
                .iter()
                .map(|pane| pane.terminal.clone())
                .collect();
            let bounds: Vec<_> = panes
                .iter()
                .map(|pane| window.find(("pane", pane.entity_id())).bounds())
                .collect();
            for pair in bounds.windows(2) {
                assert!((f32::from(pair[0].size.height - pair[1].size.height)).abs() < 1.);
                assert_eq!(pair[0].bottom() + px(1.), pair[1].top());
                assert_eq!(pair[0].left(), pair[1].left());
            }
            window.click(("close-pane", panes[0].entity_id()), cx);
            window.click(("close-pane", panes[1].entity_id()), cx);
            assert!(
                window
                    .try_find(("close-pane", panes[2].entity_id()))
                    .is_none()
            );
            window.press("cmd-d", cx);
            assert_eq!(workspace.read(cx).tabs[0].axis, gpui_kit::Axis::Horizontal);

            let profile = SshProfile {
                name: "Split SSH".into(),
                host: "example.invalid".into(),
                remote_directory: "/srv/project".into(),
                ..SshProfile::default()
            };
            workspace.update(cx, |view, cx| {
                view.settings.ssh_servers.push(profile.clone());
                view.connect(&profile.id, window, cx);
            });
            window.render_frame(cx);
            window.press("cmd-d", cx);
            let tab = &workspace.read(cx).tabs[1];
            assert_eq!(tab.panes.len(), 2);
            for pane in &tab.panes {
                let terminal = pane.terminal.read(cx);
                assert_eq!(terminal.ssh_profile.as_ref().unwrap().id, profile.id);
                assert_eq!(
                    terminal.source,
                    TabSource::Ssh {
                        profile_id: profile.id.clone(),
                        directory: profile.remote_directory.clone()
                    }
                );
                assert!(
                    !terminal.status.is_empty(),
                    "startup failures remain visible per pane"
                );
            }
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn quick_commands_run_only_in_the_active_ready_pane(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        let id = uuid::Uuid::new_v4().to_string();
        let first = cx.update(|cx| {
            workspace.update(cx, |view, cx| {
                view.settings
                    .quick_commands
                    .push(crate::storage::QuickCommand {
                        id: id.clone(),
                        name: "List files".into(),
                        command: "pwd\nls -la".into(),
                    });
                cx.notify();
                view.tabs[0].active_terminal().clone()
            })
        });
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press("cmd-d", cx);
        })
        .unwrap();
        cx.run_until_parked();
        let active = cx.update(|cx| workspace.read(cx).tabs[0].active_terminal().clone());
        assert_ne!(first.entity_id(), active.entity_id());
        let ((first_bytes, _first_output), (active_bytes, _active_output)) =
            cx.update(|cx| (capture(&first, cx), capture(&active, cx)));
        // Local and SSH panes share the same PTY execution path.
        let cases = [
            (
                false,
                true,
                "pwd\nls -la",
                "\x1b[200~pwd\nls -la\x1b[201~\r",
            ),
            (true, true, "pwd\nls -la", "\x1b[200~pwd\nls -la\x1b[201~\r"),
            (
                false,
                true,
                "git commit -m '$'",
                "\x1b[200~git commit -m ''\x1b[201~\x1b[D",
            ),
            (
                true,
                true,
                "git checkout $",
                "\x1b[200~git checkout \x1b[201~\x1b[D\x1b[C",
            ),
            (false, false, "git checkout $", "git checkout \x1b[D\x1b[C"),
            (false, true, "$ls", "\x1b[200~ls\x1b[201~\x1b[D\x1b[D"),
            (
                true,
                true,
                "echo $你好",
                "\x1b[200~echo 你好\x1b[201~\x1b[D\x1b[D",
            ),
            (
                false,
                true,
                "echo $a$",
                "\x1b[200~echo a$\x1b[201~\x1b[D\x1b[D",
            ),
            (true, false, "echo '$'", "echo ''\x1b[D"),
            (
                false,
                true,
                "echo $hi\nls",
                "\x1b[200~echo hi\nls\x1b[201~\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D",
            ),
            (true, false, "echo $hi\nls", ""),
        ];
        for (remote, bracketed, command, expected) in cases {
            cx.update(|cx| {
                workspace.update(cx, |view, cx| {
                    view.settings.quick_commands[0].command = command.into();
                    cx.notify();
                });
                active.update(cx, |terminal, cx| {
                    terminal.source = if remote {
                        TabSource::Ssh {
                            profile_id: uuid::Uuid::new_v4().to_string(),
                            directory: "/tmp".into(),
                        }
                    } else {
                        TabSource::Local { directory: None }
                    };
                    terminal
                        .session
                        .as_mut()
                        .unwrap()
                        .terminal
                        .advance_bytes(if bracketed {
                            b"\x1b[?2004h"
                        } else {
                            b"\x1b[?2004l"
                        });
                    cx.notify();
                })
            });
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                window.press("cmd-p", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                window.input("List files", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                assert!(window.within("command").find(id.clone()).visible());
                assert!(window.find("palette-group-Quick Commands").visible());
                assert_eq!(
                    window.find(format!("palette-detail-{id}")).label(),
                    Some(command)
                );
                let divider = window.find("palette-group-divider-Quick Commands");
                assert!(divider.visible());
                assert!(
                    divider.bounds().top()
                        >= window.within("command").find(id.clone()).bounds().bottom()
                );
                assert_eq!(
                    divider.bounds().size.width,
                    window
                        .find("palette-group-Quick Commands")
                        .bounds()
                        .size
                        .width
                );
                assert_eq!(
                    window
                        .find("palette-group-icon-Quick Commands")
                        .bounds()
                        .size,
                    size(window.rem_size(), window.rem_size())
                );
                window.press("enter", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                assert!(window.try_find("command-palette").is_none());
                assert!(active.read(cx).focus.is_focused(window));
            })
            .unwrap();
            let bytes: Vec<u8> = active_bytes.try_iter().flatten().collect();
            assert_eq!(bytes, expected.as_bytes(), "{command:?}");
            if expected.is_empty() {
                cx.update(|cx| assert!(active.read(cx).status.contains("bracketed paste")));
            }
            assert!(first_bytes.try_recv().is_err());
        }
        for connecting in [true, false] {
            cx.update(|cx| {
                active.update(cx, |terminal, cx| {
                    terminal.running = connecting;
                    terminal.connecting = connecting;
                    cx.notify();
                })
            });
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                window.press("cmd-p", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                window.input("List files", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                assert!(!workspace.read(cx).quick_commands_available(cx));
                window.press("enter", cx);
                assert!(window.try_find("command-palette").is_some());
                window.press("escape", cx);
            })
            .unwrap();
            cx.run_until_parked();
            assert!(active_bytes.try_recv().is_err());
        }
        cx.update_window(handle.into(), |_, window, _| window.remove_window())
            .unwrap();
    }

    #[gpui_kit::test]
    fn command_palette_searches_executes_and_restores_focus(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        let profile = SshProfile {
            name: "Production".into(),
            icon: "ubuntu".into(),
            host: "palette.example".into(),
            port: 2222,
            ..SshProfile::default()
        };
        let terminal = cx.update(|cx| workspace.read(cx).tabs[0].panes[0].terminal.clone());
        let (bytes, _output) = cx.update(|cx| {
            workspace.update(cx, |view, cx| {
                // Without storage, execution creates a tab but cannot start SSH.
                view.settings.ssh_servers.push(profile.clone());
                cx.notify();
            });
            capture(&terminal, cx)
        });
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press("cmd-p", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("command-palette").is_some());
            let bounds = window.find("dialog").bounds();
            let viewport = window.viewport_size();
            assert!(bounds.size.width < viewport.width);
            assert!(bounds.size.width <= window.rem_size() * 36.);
            assert!((bounds.center().x - viewport.width / 2.).abs() < px(1.));
            assert!((bounds.center().y - viewport.height / 2.).abs() < px(1.));
            let heading = window.find("palette-group-Commands");
            let icon = window.find("palette-group-icon-Commands");
            assert_eq!(heading.label(), Some("Commands"));
            assert!(heading.visible());
            assert_eq!(
                icon.bounds().size,
                size(window.rem_size(), window.rem_size())
            );
            assert!(heading.bounds().size.height >= window.rem_size());
            assert_eq!(
                window
                    .within("command")
                    .find(gpui_kit::component::IndexPath::new(0).section(2))
                    .selected(),
                Some(false)
            );
            assert_eq!(window.find("palette-search").focused(), Some(true));
            assert_eq!(
                window
                    .find(format!("palette-detail-{}", profile.id))
                    .label(),
                Some("root@palette.example:2222")
            );
            window.press("down", cx);
            assert_eq!(
                window
                    .within("command")
                    .find(gpui_kit::component::IndexPath::new(1).section(2))
                    .selected(),
                Some(true)
            );
            window.press("up", cx);
            assert_eq!(
                window
                    .within("command")
                    .find(gpui_kit::component::IndexPath::new(1).section(1))
                    .selected(),
                Some(true)
            );
            window.input("no-such-command", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(
                window
                    .within("command")
                    .try_find(gpui_kit::component::IndexPath::new(1).section(2))
                    .is_none()
            );
            assert!(window.try_find("palette-group-Commands").is_none());
            assert!(window.try_find("palette-group-Servers").is_none());
            window.press("enter", cx);
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_none());
            assert!(terminal.read(cx).focus.is_focused(window));
            assert!(
                bytes.try_recv().is_err(),
                "palette keys must not reach the shell"
            );
            window.press("ctrl-p", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.input("zm", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let icon_size = size(window.rem_size() * 1.5, window.rem_size() * 1.5);
            let max_row_height = window.rem_size() * 3.;
            let command = window.within("command");
            let icon = command.find(format!(
                "palette-icon-{}",
                gpui_kit::Action::name(&crate::ZoomIn)
            ));
            assert_eq!(icon.bounds().size, icon_size);
            assert!(
                command
                    .find(gpui_kit::component::IndexPath::new(1).section(2))
                    .bounds()
                    .size
                    .height
                    <= max_row_height
            );
            assert_eq!(
                command
                    .find(gpui_kit::component::IndexPath::new(1).section(2))
                    .selected(),
                Some(true)
            );
            window.press("down", cx);
            assert_eq!(
                window
                    .within("command")
                    .find(gpui_kit::component::IndexPath::new(2).section(2))
                    .selected(),
                Some(true)
            );
            window.press("up", cx);
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(terminal.read(cx).font_scale > 1.);
            assert!(terminal.read(cx).focus.is_focused(window));
            assert!(window.try_find("dialog").is_none());
            window.press("cmd-p", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.input("stng", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            // Pointer confirmation shares the keyboard execution path.
            window
                .within("command")
                .click(gpui_kit::component::IndexPath::new(1).section(2), cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("settings-general").is_some());
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.press("cmd-p", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.input("prd", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let command = window.within("command");
            assert!(
                command
                    .try_find(gpui_kit::component::IndexPath::new(1).section(2))
                    .is_none()
            );
            assert_eq!(
                command
                    .find(gpui_kit::component::IndexPath::new(1).section(1))
                    .selected(),
                Some(true)
            );
            let icon = command.find(format!("palette-icon-{}", profile.id));
            assert_eq!(
                icon.bounds().size,
                size(window.rem_size() * 1.5, window.rem_size() * 1.5)
            );
            window.press("enter", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_none());
            let view = workspace.read(cx);
            assert_eq!(view.tabs.len(), 2);
            let connected = view.tabs[1].panes[0].terminal.read(cx);
            assert!(matches!(&connected.source, TabSource::Ssh { profile_id, .. } if profile_id == &profile.id));
            assert!(connected.focus.is_focused(window));
        }).unwrap();
        for escape in [true, false] {
            cx.update_window(handle.into(), |_, window, cx| {
                window.press("cmd-p", cx);
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                if escape {
                    window.press("escape", cx);
                } else {
                    window.click_at("terminal", point(px(5.), px(5.)), cx);
                }
            })
            .unwrap();
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, cx| {
                window.render_frame(cx);
                assert!(window.try_find("dialog").is_none());
                let view = workspace.read(cx);
                assert!(
                    view.tabs[1].panes[0]
                        .terminal
                        .read(cx)
                        .focus
                        .is_focused(window)
                );
            })
            .unwrap();
        }
    }

    #[gpui_kit::test]
    fn server_menu_opens_settings_add_edit_forms_and_saved_connections(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        let profile = SshProfile {
            name: "Ubuntu Home".into(),
            host: "localhost".into(),
            port: 2222,
            authentication: Authentication::Password,
            ..SshProfile::default()
        };
        // No storage or credentials: selecting the row cannot launch a network connection.
        workspace.update(cx, |view, cx| {
            view.settings.ssh_servers.push(profile.clone());
            cx.notify();
        });
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("workspace-menu", cx);
            let settings = window.find("server-menu-settings").bounds();
            let add = window.find("server-menu-add").bounds();
            let server = window.find(format!("server-menu-{}", profile.id));
            assert_eq!(server.label(), Some("Ubuntu Home, root@localhost:2222"));
            assert!(settings.bottom() <= add.top());
            assert!(add.bottom() < server.bounds().top());
            for ix in 5usize..10 {
                assert!(window.within("popup-menu").try_find(ix).is_none());
            }
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("popup-menu").is_none());
            assert!(
                workspace.read(cx).tabs[0].panes[0]
                    .terminal
                    .read(cx)
                    .focus
                    .is_focused(window)
            );
            window.click("workspace-menu", cx);
            let row_id = format!("server-menu-{}", profile.id);
            let edit_id = format!("server-menu-edit-{}", profile.id);
            assert!(!window.find(edit_id.clone()).visible());
            window.hover(row_id.clone(), cx);
            let edit = window.find(edit_id.clone());
            assert!(edit.visible());
            assert_eq!(edit.label(), Some("Edit Ubuntu Home"));
            assert!(edit.bounds().right() <= window.find(row_id).bounds().right());
            window.hover("server-menu-add", cx);
            assert!(!window.find(edit_id.clone()).visible());
            window.hover(format!("server-menu-{}", profile.id), cx);
            window.click(edit_id, cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("popup-menu").is_none());
            assert_eq!(window.find("ssh-name").value(), Some("Ubuntu Home"));
            assert_eq!(window.find("ssh-host").value(), Some("localhost"));
            assert_eq!(window.find("ssh-port").value(), Some("2222"));
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("dialog").is_none());
            assert!(
                workspace.read(cx).tabs[0].panes[0]
                    .terminal
                    .read(cx)
                    .focus
                    .is_focused(window)
            );
            window.click("workspace-menu", cx);
            window.click("server-menu-settings", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("settings-general").is_some());
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("workspace-menu", cx);
            window.click("server-menu-add", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("ssh-host").is_some());
            window.press("escape", cx);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            window.click("workspace-menu", cx);
            // Settings, Add SSH Server, then the first saved server; separator is skipped.
            for _ in 0..3 {
                window.press("down", cx);
            }
            window.press("enter", cx);
            assert_eq!(workspace.read(cx).tabs.len(), 2);
            let terminal = workspace.read(cx).tabs[1].panes[0].terminal.read(cx);
            assert!(matches!(&terminal.source, TabSource::Ssh { profile_id, .. } if profile_id == &profile.id));
            assert!(terminal.focus.is_focused(window));
        }).unwrap();
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find("popup-menu").is_none());
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn ssh_retries_only_when_active_and_cancels_on_close(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, _| window.activate_window())
            .unwrap();
        cx.run_until_parked();
        let first = workspace.read_with(cx, |view, _| view.tabs[0].panes[0].terminal.clone());
        cx.update_window(handle.into(), |_, window, cx| {
            let (_, output) = capture(&first, cx);
            first.update(cx, |view, _| {
                let profile = SshProfile {
                    name: "Reconnect test".into(),
                    host: "localhost".into(),
                    authentication: Authentication::Password,
                    ..SshProfile::default()
                };
                view.source = TabSource::Ssh {
                    profile_id: profile.id.clone(),
                    directory: "/old".into(),
                };
                view.ssh_profile = Some(profile);
                // Missing credentials fail before launching SSH; this test needs no server.
                view.store = Some(Store::at(std::env::temp_dir()));
            });
            window.render_frame(cx);
            assert_eq!(
                window.find(("tab-status", first.entity_id())).label(),
                Some("Ready")
            );
            output
                .send(Output::Bytes(b"\x1b]7;file:///srv/work\x07".to_vec()))
                .unwrap();
            output
                .send(Output::Error("Connection lost".into()))
                .unwrap();
            first.update(cx, |view, cx| view.read_output(cx));
            let terminal = first.read(cx);
            assert!(!terminal.running);
            assert!(terminal.reconnect_at.unwrap() > Instant::now());
            assert!(terminal.status.contains("Automatic retry in 5s"));
            window.render_frame(cx);
            assert_eq!(
                window.find(("tab-status", first.entity_id())).label(),
                Some("Closed")
            );
            assert!(window.try_find("restart").is_none());
            workspace.update(cx, |view, cx| view.reconnect_active(false, window, cx));
            assert!(
                !first.read(cx).connecting,
                "must wait for the retry interval"
            );

            window.press("cmd-t", cx);
            first.update(cx, |view, _| view.reconnect_at = Some(Instant::now()));
        })
        .unwrap();
        cx.executor().advance_clock(Duration::from_millis(250));
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            assert!(!first.read(cx).connecting, "hidden tabs must not retry");
            window.press("cmd-1", cx);
            assert!(first.read(cx).connecting);
            let dot = window.find(("tab-status", first.entity_id()));
            assert_eq!(dot.label(), Some("Connecting"));
            let bounds = dot.bounds().scale(window.scale_factor());
            assert!(window.painted_quads().iter().any(|quad| {
                quad.bounds == bounds && quad.background == cx.theme().warning.into()
            }));
            assert!(matches!(&first.read(cx).source, TabSource::Ssh { directory, .. } if directory == "/srv/work"));
            workspace.update(cx, |view, cx| view.reconnect_active(true, window, cx));
            assert!(first.read(cx).connecting, "activation must not overlap attempts");
        }).unwrap();
        cx.run_until_parked();
        cx.update(|cx| {
            let terminal = first.read(cx);
            assert!(!terminal.connecting);
            assert!(terminal.status.contains("Enter a password"));
            assert!(
                terminal.reconnect_at.unwrap() > Instant::now(),
                "failed attempts must retry"
            );
        });

        VisualTestContext::from_window(handle.into(), cx).deactivate_window();
        first.update(cx, |view, _| view.reconnect_at = Some(Instant::now()));
        cx.executor().advance_clock(Duration::from_millis(250));
        cx.run_until_parked();
        cx.update(|cx| assert!(first.read(cx).reconnect_at.unwrap() <= Instant::now()));
        cx.update_window(handle.into(), |_, window, _| window.activate_window())
            .unwrap();
        cx.run_until_parked();
        cx.update(|cx| {
            assert!(
                first.read(cx).reconnect_at.unwrap() > Instant::now(),
                "returning to the app must retry"
            )
        });

        first.update(cx, |view, _| view.reconnect_at = Some(Instant::now()));
        cx.executor().advance_clock(Duration::from_millis(250));
        cx.run_until_parked();
        cx.update(|cx| {
            assert!(
                first.read(cx).reconnect_at.unwrap() > Instant::now(),
                "the active tab must keep retrying"
            )
        });
        cx.update_window(handle.into(), |_, window, cx| {
            first.update(cx, |view, _| view.reconnect_at = Some(Instant::now()));
            workspace.update(cx, |view, cx| view.reconnect_active(false, window, cx));
            assert!(first.read(cx).connecting);
            window.press("cmd-w", cx);
            assert!(first.read(cx)._start_task.is_none());
            assert!(first.read(cx).session.is_none());
            first.update(cx, |view, cx| view.maybe_reconnect(cx));
            assert!(!first.read(cx).connecting);
        })
        .unwrap();
        cx.run_until_parked();
        cx.update(|cx| {
            assert!(first.read(cx).session.is_none());
            assert!(first.read(cx).reconnect_at.is_none());
        });
    }

    #[gpui_kit::test]
    fn ssh_host_key_warning_schedules_one_immediate_recovery(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            let terminal = workspace.read(cx).tabs[0].panes[0].terminal.clone();
            let (_, output) = capture(&terminal, cx);
            terminal.update(cx, |view, _| {
                view.source = TabSource::Ssh {
                    profile_id: uuid::Uuid::new_v4().to_string(),
                    directory: String::new(),
                };
            });
            for chunk in [
                &b"@ WARNING: REMOTE HOST IDENTIFI"[..],
                &b"CATION HAS CHANGED! @\r\nHost key verification failed.\r\n"[..],
            ] {
                output.send(Output::Bytes(chunk.to_vec())).unwrap();
                terminal.update(cx, |view, cx| view.read_output(cx));
            }
            output
                .send(Output::Error("SSH connection closed".into()))
                .unwrap();
            terminal.update(cx, |view, cx| view.read_output(cx));
            let view = terminal.read(cx);
            assert!(!view.running);
            assert!(view.ssh_host_key_recovery.is_pending());
            assert!(view.reconnect_at.unwrap() <= Instant::now());
            assert!(view.status.contains("Recovering changed SSH host key"));
            window.render_frame(cx);
            assert!(
                window
                    .find("terminal")
                    .value()
                    .unwrap()
                    .contains("HOST IDENTIFICATION HAS CHANGED")
            );

            // Consuming recovery cannot re-arm cleanup on subsequent automatic retries.
            terminal.update(cx, |view, _| {
                assert!(view.ssh_host_key_recovery.take_pending());
                view.ssh_host_key_recovery
                    .observe(b"REMOTE HOST IDENTIFICATION HAS CHANGED!");
                view.schedule_reconnect();
                assert!(!view.ssh_host_key_recovery.is_pending());
                assert!(view.reconnect_at.unwrap() > Instant::now());
                view.close();
                assert!(view.reconnect_at.is_none());
            });
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn ssh_retries_failed_exits_and_leaves_normal_exits_closed(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            let terminal = workspace.read(cx).tabs[0].panes[0].terminal.clone();
            capture(&terminal, cx);
            terminal.update(cx, |view, _| {
                view.session.as_mut().unwrap().terminal.advance_bytes(
                    b"\x1b[32mSSH_HISTORY\x1b[0m\r\nroot@ubuntu24:~# Timeout, server 89.252.140.107 not responding."
                );
            });
            for (attempt, code) in [0, 255, 255].into_iter().enumerate() {
                terminal.update(cx, |view, cx| {
                    let mut command = portable_pty::CommandBuilder::new("/bin/sh");
                    command.args(["-c", &format!(
                        "read ready; printf 'ssh: connect to host 89.252.140.107 port 22: Network is unreachable\\n'; exit {code}"
                    )]);
                    view.source = TabSource::Ssh {
                        profile_id: uuid::Uuid::new_v4().to_string(),
                        directory: String::new(),
                    };
                    view.spawn(command, "SSH exit test".into(), cx);
                    // Input must reach the new PTY after transferring the previous screen.
                    view.session.as_mut().unwrap().terminal.send_paste("ready\n").unwrap();
                });
                let deadline = Instant::now() + Duration::from_secs(5);
                while terminal.read(cx).running {
                    assert!(Instant::now() < deadline, "child did not exit");
                    std::thread::sleep(Duration::from_millis(1));
                    terminal.update(cx, |view, cx| view.read_output(cx));
                }
                assert_eq!(terminal.read(cx).reconnect_at.is_some(), code != 0);
                assert!(
                    terminal
                        .read(cx)
                        .status
                        .contains(&format!("Shell exited ({code})"))
                );
                window.render_frame(cx);
                assert!(window.try_find("restart").is_none());
                let output = window.find("terminal").value().unwrap().to_string();
                assert!(output.contains("SSH_HISTORY"));
                assert!(output.contains("Timeout, server 89.252.140.107 not responding."));
                assert_eq!(output.matches("Network is unreachable").count(), attempt + 1);
                assert!(output.lines().any(|line| line.trim() == "ssh: connect to host 89.252.140.107 port 22: Network is unreachable"));
                assert_eq!(
                    terminal.read(cx).session.as_ref().unwrap().terminal.screen().lines_in_phys_range(0..1)[0]
                        .get_cell(0).unwrap().attrs().foreground(),
                    wezterm_term::color::ColorAttribute::PaletteIndex(2)
                );
            }
            let output = window.find("terminal").value().unwrap().to_string();
            terminal.update(cx, |view, cx| {
                view.spawn(portable_pty::CommandBuilder::new("/nonexistent/ssh"), "Failed spawn".into(), cx);
            });
            window.render_frame(cx);
            assert_eq!(window.find("terminal").value(), Some(output.as_str()));
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn tabs_keep_input_output_focus_and_view_state_independent(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let first = workspace.read(cx).tabs[0].panes[0].terminal.clone();
            let (first_input, first_output) = capture(&first, cx);
            assert!(Workspace::title(first.read(cx)).starts_with("~ — "));
            first_output
                .send(Output::Bytes(
                    b"\x1b]7;file:///tmp/my%20project\x07".to_vec(),
                ))
                .unwrap();
            first.update(cx, |view, cx| view.read_output(cx));
            assert!(Workspace::title(first.read(cx)).starts_with("my project — "));
            window.input("one", cx);
            assert_eq!(
                (0..3)
                    .flat_map(|_| first_input.recv_timeout(Duration::from_secs(1)).unwrap())
                    .collect::<Vec<_>>(),
                b"one"
            );
            window.press("cmd-t", cx);
            let second = workspace.read(cx).tabs[1].panes[0].terminal.clone();
            let (second_input, _second_output) = capture(&second, cx);
            window.input("two", cx);
            assert_eq!(
                (0..3)
                    .flat_map(|_| second_input.recv_timeout(Duration::from_secs(1)).unwrap())
                    .collect::<Vec<_>>(),
                b"two"
            );
            assert!(first_input.try_recv().is_err());
            assert!(second.read(cx).focus.is_focused(window));

            // Output and title changes continue in the hidden tab.
            first_output
                .send(Output::Bytes(
                    b"background\x1b]2;Project shell\x07".to_vec(),
                ))
                .unwrap();
            first.update(cx, |view, cx| view.read_output(cx));
            assert!(Workspace::title(first.read(cx)).starts_with("my project — "));
            first_output
                .send(Output::Bytes(
                    b"\x1b]7;file:///tmp/another%20project\x07".to_vec(),
                ))
                .unwrap();
            first.update(cx, |view, cx| view.read_output(cx));
            assert!(Workspace::title(first.read(cx)).starts_with("another project — "));
            assert!(Workspace::title(second.read(cx)).starts_with("~ — "));
            window.press("ctrl-1", cx);
            assert_eq!(workspace.read(cx).active, first.entity_id());
            assert!(first.read(cx).focus.is_focused(window));
            assert!(
                window
                    .find("terminal")
                    .value()
                    .unwrap()
                    .contains("background")
            );
            first_output
                .send(Output::Bytes("\r\nhistory\r\n".repeat(100).into_bytes()))
                .unwrap();
            first.update(cx, |view, cx| view.read_output(cx));
            window.press("cmd-=", cx);
            window.press("shift-pageup", cx);
            let scroll_offset = first.read(cx).scroll_offset;
            assert!(scroll_offset > 0.);
            let scale = first.read(cx).font_scale;
            assert!(scale > 1.);
            window.press("cmd-a", cx);
            let selection = first
                .read(cx)
                .selection
                .unwrap()
                .text(&first.read(cx).session.as_ref().unwrap().terminal);
            window.press("ctrl-tab", cx);
            assert_eq!(workspace.read(cx).active, second.entity_id());
            assert_eq!(second.read(cx).font_scale, 1.);
            assert!(second.read(cx).selection.is_none());
            window.press("ctrl-tab", cx);
            assert_eq!(workspace.read(cx).active, first.entity_id());
            assert_eq!(first.read(cx).font_scale, scale);
            assert_eq!(first.read(cx).scroll_offset, scroll_offset);
            assert_eq!(
                first
                    .read(cx)
                    .selection
                    .unwrap()
                    .text(&first.read(cx).session.as_ref().unwrap().terminal),
                selection
            );
            window.press("ctrl-shift-tab", cx);
            assert_eq!(workspace.read(cx).active, second.entity_id());
            window.press("cmd-shift-}", cx);
            assert_eq!(workspace.read(cx).active, first.entity_id());
            window.press("cmd-shift-{", cx);
            assert_eq!(workspace.read(cx).active, second.entity_id());
            window.press("cmd-1", cx);
            window.press("cmd-9", cx);
            assert_eq!(workspace.read(cx).active, first.entity_id());
            assert!(first_input.try_recv().is_err());
            assert!(second_input.try_recv().is_err());

            first_output.send(Output::Closed).unwrap();
            first.update(cx, |view, cx| view.read_output(cx));
            window.render_frame(cx);
            assert!(!first.read(cx).running);
            assert!(window.try_find("restart").is_some());
            window.click("restart", cx);
            assert!(first.read(cx).running);
            assert!(first.read(cx).focus.is_focused(window));
            assert_eq!(workspace.read(cx).tabs.len(), 2);
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn pointer_reordering_closing_and_overflow_keep_the_active_session(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update(|cx| cx.set_reduce_motion(true));
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let first = workspace.read(cx).tabs[0].panes[0].terminal.clone();
            window.click("new-tab", cx);
            let second = workspace.read(cx).tabs[1].panes[0].terminal.clone();
            window.click("new-tab", cx);
            let third = workspace.read(cx).tabs[2].panes[0].terminal.clone();
            first.update(cx, |view, cx| {
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes(format!(
                        "\x1b]7;file:///tmp/{}\x07",
                        "Long%20project%20".repeat(12)
                    ));
                cx.notify();
            });
            window.press("cmd-1", cx);
            window.press("ctrl-tab", cx);
            assert_eq!(workspace.read(cx).active, second.entity_id());
            assert!(second.read(cx).focus.is_focused(window));
            window.press("cmd-1", cx);
            let tab_bounds = window.find(("tab", first.entity_id())).bounds();
            let close_bounds = window.find(("close-tab", first.entity_id())).bounds();
            assert!(close_bounds.right() <= tab_bounds.right());
            assert!(close_bounds.bottom() <= tab_bounds.bottom());
            window.drag_to(("tab", first.entity_id()), ("tab", third.entity_id()), cx);
            assert_eq!(
                workspace.read(cx).tabs[2].panes[0].terminal.entity_id(),
                first.entity_id()
            );
            assert_eq!(workspace.read(cx).active, first.entity_id());
            assert!(first.read(cx).focus.is_focused(window));
            window.click(("tab", second.entity_id()), cx);
            assert_eq!(workspace.read(cx).active, second.entity_id());
            window.click(("close-tab", third.entity_id()), cx);
            assert_eq!(workspace.read(cx).tabs.len(), 2);
            assert_eq!(workspace.read(cx).active, second.entity_id());
            assert!(third.read(cx).session.is_none());
            window.press("ctrl-w", cx);
            assert!(second.read(cx).session.is_none());
            assert_eq!(workspace.read(cx).active, first.entity_id());
            assert!(first.read(cx).focus.is_focused(window));
            for _ in 0..9 {
                window.press("ctrl-t", cx);
            }
            window.render_frame(cx);
            assert_eq!(workspace.read(cx).tabs.len(), 10);
            assert!(workspace.read(cx).scroll.offset().x < px(0.));
            window.resize(size(px(640.), px(480.)));
            window.bounds_changed(cx);
            window.render_frame(cx);
            window.simulate_next_frame(cx);
            window.render_frame(cx);
            let last = workspace.read(cx).tabs[9].panes[0].terminal.clone();
            let viewport = window.find("tab-strip").bounds();
            assert!(viewport.right() < px(640.));
            let new_tab = window.find("new-tab").bounds();
            let folder = window.find("open-folder").bounds();
            let menu = window.find("workspace-menu").bounds();
            assert_eq!(new_tab.center().y, folder.center().y);
            assert_eq!(folder.center().y, menu.center().y);
            assert!(menu.right() <= px(640.));
            let bounds = window.find(("tab", last.entity_id())).bounds();
            assert!(bounds.left() >= viewport.left());
            assert!(bounds.right() <= viewport.right());
            window.scroll(
                "tab-strip",
                ScrollDelta::Pixels(point(px(10000.), px(0.))),
                cx,
            );
            assert_eq!(workspace.read(cx).scroll.offset().x, px(0.));
            assert_eq!(workspace.read(cx).active, last.entity_id());
            window.press("cmd-1", cx);
            window.render_frame(cx);
            assert_eq!(workspace.read(cx).scroll.offset().x, px(0.));
            // Numbered shortcuts follow the visible order after reordering.
            window.press("cmd-9", cx);
            assert_eq!(
                workspace.read(cx).active,
                workspace.read(cx).tabs[8].panes[0].terminal.entity_id()
            );
            for _ in 0..9 {
                window.press("cmd-w", cx);
            }
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            window.press("cmd-w", cx);
            assert!(workspace.read(cx).tabs.is_empty());
            assert!(first.read(cx).session.is_none());
        })
        .unwrap();
        cx.update(|cx| assert!(cx.windows().is_empty()));
    }
    #[gpui_kit::test]
    fn middle_click_closes_the_target_tab_and_keeps_terminal_focus(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update(|cx| cx.set_reduce_motion(true));
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let first = workspace.read(cx).tabs[0].active_terminal().clone();
            window.click("new-tab", cx);
            let second = workspace.read(cx).tabs[1].active_terminal().clone();
            window.click("new-tab", cx);
            let third = workspace.read(cx).tabs[2].active_terminal().clone();

            window.click_with_options(
                ("tab", first.entity_id()),
                ClickOptions::new().with_button(MouseButton::Middle),
                cx,
            );
            assert_eq!(workspace.read(cx).tabs.len(), 2);
            assert!(first.read(cx).session.is_none());
            assert_eq!(workspace.read(cx).active, third.entity_id());
            assert!(third.read(cx).focus.is_focused(window));
            assert!(!cx.has_active_drag());

            window.click_with_options(
                ("close-tab", third.entity_id()),
                ClickOptions::new().with_button(MouseButton::Middle),
                cx,
            );
            assert_eq!(workspace.read(cx).tabs.len(), 1);
            assert!(third.read(cx).session.is_none());
            assert_eq!(workspace.read(cx).active, second.entity_id());
            assert!(second.read(cx).focus.is_focused(window));

            window.click_with_options(
                ("tab", second.entity_id()),
                ClickOptions::new().with_button(MouseButton::Middle),
                cx,
            );
            assert!(workspace.read(cx).tabs.is_empty());
            assert!(second.read(cx).session.is_none());
        })
        .unwrap();
        cx.update(|cx| assert!(cx.windows().is_empty()));
    }

    fn pointer_move(window: &mut Window, position: Point<Pixels>, cx: &mut App) {
        window.dispatch_event(
            MouseMoveEvent {
                position,
                pressed_button: Some(MouseButton::Left),
                ..Default::default()
            }
            .to_platform_input(),
            cx,
        );
        window.render_frame(cx);
    }

    fn pointer_down(window: &mut Window, position: Point<Pixels>, cx: &mut App) {
        window.dispatch_event(
            MouseDownEvent {
                position,
                button: MouseButton::Left,
                click_count: 1,
                ..Default::default()
            }
            .to_platform_input(),
            cx,
        );
        window.render_frame(cx);
        pointer_move(window, position + point(px(10.), px(0.)), cx);
        assert!(cx.has_active_drag());
    }

    fn pointer_up(window: &mut Window, position: Point<Pixels>, cx: &mut App) {
        window.dispatch_event(
            MouseUpEvent {
                position,
                button: MouseButton::Left,
                click_count: 1,
                ..Default::default()
            }
            .to_platform_input(),
            cx,
        );
        window.render_frame(cx);
    }

    #[gpui_kit::test]
    fn live_drag_reorders_before_release_and_animates_without_jitter(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        let (ids, from, middle, end, second_left) = cx
            .update_window(handle.into(), |_, window, cx| {
                window.click("new-tab", cx);
                window.click("new-tab", cx);
                let ids = workspace
                    .read(cx)
                    .tabs
                    .iter()
                    .map(|tab| tab.id)
                    .collect::<Vec<_>>();
                let from = window.find(("tab", ids[0])).bounds().center();
                let middle = window.find(("tab", ids[1])).bounds().center();
                let end = window.find(("tab", ids[2])).bounds().center();
                let second_left = window.find(("tab-content", ids[1])).bounds().left();
                pointer_down(window, from, cx);
                assert_eq!(workspace.read(cx).active, ids[0]);
                let preview = window.find("tab-drag-preview").bounds();
                assert_eq!(
                    preview.size.width,
                    window.find(("tab", ids[0])).bounds().size.width
                );
                pointer_move(window, middle + point(px(0.), px(3.)), cx);
                let moved_preview = window.find("tab-drag-preview").bounds();
                assert_eq!(
                    moved_preview.top(),
                    preview.top(),
                    "preview should stay aligned with the strip"
                );
                assert_eq!(
                    moved_preview.left() - preview.left(),
                    middle.x - from.x - px(10.),
                    "preview should follow the pointer without easing"
                );
                assert_eq!(
                    workspace.read(cx).tabs[1].panes[0].terminal.entity_id(),
                    ids[0]
                );
                assert_eq!(
                    window.find(("tab-content", ids[1])).bounds().left(),
                    second_left
                );
                for _ in 0..3 {
                    pointer_move(window, middle, cx);
                    assert_eq!(
                        workspace.read(cx).tabs[1].panes[0].terminal.entity_id(),
                        ids[0]
                    );
                }
                (ids, from, middle, end, second_left)
            })
            .unwrap();
        cx.background_executor
            .advance_clock(Duration::from_millis(60));
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let halfway = window.find(("tab-content", ids[1])).bounds().left();
            let target = window.find(("tab", ids[1])).bounds().left();
            assert!(
                target < halfway && halfway < second_left,
                "neighbor should slide between its old and new slot"
            );
            pointer_move(window, from, cx);
            assert_eq!(
                workspace.read(cx).tabs[0].panes[0].terminal.entity_id(),
                ids[0]
            );
            assert_eq!(
                window.find(("tab-content", ids[1])).bounds().left(),
                halfway,
                "reversing a slide should preserve its position"
            );
            pointer_move(window, end, cx);
            assert_eq!(
                workspace.read(cx).tabs[2].panes[0].terminal.entity_id(),
                ids[0]
            );
            pointer_up(window, end, cx);
            assert!(workspace.read(cx).dragging.is_none());
            assert!(!cx.has_active_drag());
            assert_eq!(workspace.read(cx).active, ids[0]);
        })
        .unwrap();
        cx.background_executor
            .advance_clock(Duration::from_millis(150));
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let from = window.find(("tab", ids[0])).bounds().center();
            let start = window.find(("tab", ids[1])).bounds().center();
            pointer_down(window, from, cx);
            pointer_move(window, start, cx);
            assert_eq!(
                workspace.read(cx).tabs[0].panes[0].terminal.entity_id(),
                ids[0]
            );
            window.press("escape", cx);
            assert_eq!(
                workspace.read(cx).tabs[2].panes[0].terminal.entity_id(),
                ids[0]
            );
            assert!(workspace.read(cx).dragging.is_none());
            assert!(!cx.has_active_drag());
            pointer_up(window, start, cx);

            cx.set_reduce_motion(true);
            window.render_frame(cx);
            let from = window.find(("tab", ids[0])).bounds().center();
            pointer_down(window, from, cx);
            pointer_move(window, middle, cx);
            let slot = window.find(("tab", ids[2])).bounds();
            let content = window.find(("tab-content", ids[2])).bounds();
            assert_eq!(
                slot.left(),
                content.left(),
                "reduced motion should move tabs immediately"
            );
            pointer_up(window, middle, cx);
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn live_drag_scrolls_at_edges_and_commits_outside_the_strip(cx: &mut TestAppContext) {
        let (handle, workspace) = open(cx);
        cx.update_window(handle.into(), |_, window, cx| {
            for _ in 0..9 {
                window.press("cmd-t", cx);
            }
            window.press("cmd-1", cx);
            let first = workspace.read(cx).tabs[0].panes[0].terminal.entity_id();
            let bounds = window.find("tab-strip").bounds();
            let from = window.find(("tab", first)).bounds().center();
            pointer_down(window, from, cx);
            let edge = point(bounds.right() - px(2.), from.y);
            pointer_move(window, edge, cx);
            let offset = workspace.read(cx).scroll.offset().x;
            assert!(offset < px(0.));
            for _ in 0..30 {
                window.simulate_next_frame(cx);
                window.render_frame(cx);
            }
            assert!(
                workspace.read(cx).scroll.offset().x < offset,
                "scrolling should continue with a stationary pointer"
            );
            let order = workspace
                .read(cx)
                .tabs
                .iter()
                .map(|tab| tab.id)
                .collect::<Vec<_>>();
            let outside = point(edge.x, bounds.bottom() + px(80.));
            pointer_move(window, outside, cx);
            pointer_up(window, outside, cx);
            assert!(workspace.read(cx).dragging.is_none());
            assert!(!cx.has_active_drag());
            assert_eq!(
                workspace
                    .read(cx)
                    .tabs
                    .iter()
                    .map(|tab| tab.id)
                    .collect::<Vec<_>>(),
                order
            );
            let offset = workspace.read(cx).scroll.offset();
            window.simulate_next_frame(cx);
            window.render_frame(cx);
            assert_eq!(workspace.read(cx).scroll.offset(), offset);
        })
        .unwrap();
    }
}
