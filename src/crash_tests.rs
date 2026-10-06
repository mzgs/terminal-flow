//! Deterministic checks for terminal boundaries and crash-prone state transitions.
use crate::{
    selection::{Selection, SelectionMode},
    session::Output,
    storage::{Settings, TabSnapshot, TabSource},
    tests::{Configuration, open_terminal},
};
use gpui_kit::{AppContext, TestAppContext, point, px, size, test::TestWindowExt};
use std::sync::{Arc, mpsc};
use wezterm_term::{Terminal, TerminalSize};

#[gpui_kit::test]
fn viewport_and_pointer_edges_never_produce_empty_or_invalid_ranges(cx: &mut TestAppContext) {
    let (handle, view, _) = open_terminal(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            for (cols, rows) in [(2, 1), (8, 2), (80, 24)] {
                view.session
                    .as_mut()
                    .unwrap()
                    .resize(TerminalSize {
                        cols,
                        rows,
                        ..Default::default()
                    })
                    .unwrap();
                view.session
                    .as_mut()
                    .unwrap()
                    .terminal
                    .advance_bytes("x\r\n".repeat(40));
                for offset in [
                    -f32::MAX,
                    -1.,
                    0.,
                    0.25,
                    1.,
                    39.75,
                    40.,
                    3500.,
                    f32::MAX,
                    f32::NEG_INFINITY,
                    f32::INFINITY,
                    f32::NAN,
                ] {
                    // A saved offset can outlive the history it referred to.
                    view.scroll_offset = offset;
                    for position in [
                        view.bounds.origin,
                        view.bounds.bottom_right(),
                        point(px(-1e9), px(-1e9)),
                        point(px(1e9), px(1e9)),
                    ] {
                        let (row, column) = view.cell_at(position).unwrap();
                        let screen = view.session.as_ref().unwrap().terminal.screen();
                        assert!(screen.stable_row_to_phys(row).is_some(), "offset={offset}");
                        assert!(column < cols);
                    }
                    let session = view.session.as_ref().unwrap();
                    let range = crate::visible_range(session, offset);
                    assert!(range.start < range.end, "offset={offset}");
                    assert!(range.end <= session.terminal.screen().scrollback_rows());
                    assert!((rows..=rows + 1).contains(&range.len()));
                    crate::screen_text(session, offset);
                }
            }
            view.set_scroll_offset(0., cx);
        });
        window.render_frame(cx);
    })
    .unwrap();
}

#[gpui_kit::test]
fn restored_offsets_are_clamped_before_the_first_frame(cx: &mut TestAppContext) {
    let (handle, _, _) = open_terminal(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        for output_rows in [0, 1, 500] {
            let view = cx.new(|cx| {
                crate::TerminalView::configured(
                    TabSnapshot {
                        id: uuid::Uuid::new_v4().to_string(),
                        source: TabSource::default(),
                        output: vec!["saved output".into(); output_rows],
                        font_scale: 1.,
                        scroll_offset: f32::MAX,
                        browser: Default::default(),
                    },
                    None,
                    None,
                    &Settings::default(),
                    window,
                    cx,
                )
            });
            let terminal = view.read(cx);
            let screen = terminal.session.as_ref().unwrap().terminal.screen();
            let history = screen.scrollback_rows() - screen.physical_rows;
            assert_eq!(terminal.scroll_offset, history as f32);
            assert!(terminal.cell_at(point(px(0.), px(0.))).is_some());
            view.update(cx, |view, _| view.close());
        }
    })
    .unwrap();
}

#[gpui_kit::test]
fn buffer_capacity_boundaries_preserve_visible_text_and_fractional_scrolling(
    cx: &mut TestAppContext,
) {
    let (handle, view, _) = open_terminal(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let rows = view
            .read(cx)
            .session
            .as_ref()
            .unwrap()
            .terminal
            .screen()
            .physical_rows;
        let capacity = rows + 3500;
        let mut written = 0;
        for total in [
            0,
            1,
            rows - 1,
            rows,
            rows + 1,
            capacity - 1,
            capacity,
            capacity + 1,
            2 * capacity,
            2 * capacity + 1,
        ] {
            view.update(cx, |view, cx| {
                for row in written..total {
                    view.session
                        .as_mut()
                        .unwrap()
                        .terminal
                        .advance_bytes(format!("row-{row:05}\r\n"));
                }
                cx.notify();
            });
            written = total;
            // Independent oracle: numbered output rows followed by blank viewport rows.
            let first = (total + 1).saturating_sub(capacity);
            let count = (total + 1).max(rows).min(capacity);
            let retained: Vec<_> = (first..first + count)
                .map(|row| {
                    if row < total {
                        format!("row-{row:05}")
                    } else {
                        String::new()
                    }
                })
                .collect();
            let history = (count - rows) as f32;
            for requested in [0., 0.25, 1., history - 0.25, history, history + 1.] {
                let offset = requested.max(0.).min(history);
                let expected = retained
                    [count - rows - offset.ceil() as usize..count - offset.floor() as usize]
                    .join("\n");
                view.update(cx, |view, cx| {
                    view.set_scroll_offset(requested, cx);
                    let session = view.session.as_ref().unwrap();
                    assert_eq!(session.terminal.screen().scrollback_rows(), count);
                    assert_eq!(
                        crate::screen_text(session, view.scroll_offset),
                        expected,
                        "total={total}, offset={offset}"
                    );
                });
                window.render_frame(cx);
                assert_eq!(window.find("terminal").value(), Some(expected.as_str()));
            }
        }
    })
    .unwrap();
}

#[gpui_kit::test]
fn resize_clear_alternate_screen_and_closed_output_reset_stale_state(cx: &mut TestAppContext) {
    let (handle, view, _) = open_terminal(cx);
    let (output, receiver) = mpsc::channel();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.session.as_mut().unwrap().output = receiver;
            output
                .send(Output::Bytes("界é🙂\r\n".repeat(3600).into_bytes()))
                .unwrap();
            view.read_output(cx);
        });
        window.render_frame(cx);
        window.click("terminal", cx);
        for bytes in [
            b"\x1b[?1049hALT".as_slice(),
            b"\x1b[?1049l",
            b"\x1b[3J\x1b[2J\x1b[H",
        ] {
            window.press("shift-home", cx);
            window.press("cmd-a", cx);
            view.update(cx, |view, cx| {
                output.send(Output::Bytes(bytes.to_vec())).unwrap();
                view.read_output(cx);
                assert_eq!(view.scroll_offset, 0.);
                if bytes != b"\x1b[3J\x1b[2J\x1b[H" {
                    assert!(view.selection.is_none());
                    assert!(view.drag_selection.is_none());
                    assert!(view.search_matches.is_empty());
                }
                // Stale selection and session snapshots must remain safe after history deletion.
                if let Some(selection) = view.selection {
                    selection.text(&view.session.as_ref().unwrap().terminal);
                }
                assert!(view.snapshot().output.len() <= 500);
            });
            window.render_frame(cx);
        }
    })
    .unwrap();
    for (width, height) in [(1., 1.), (120., 60.), (1600., 900.), (640., 480.)] {
        cx.simulate_window_resize(handle.into(), size(px(width), px(height)));
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
            let terminal = view.read(cx);
            let screen = terminal.session.as_ref().unwrap().terminal.screen();
            assert!((2..=1000).contains(&screen.physical_cols));
            assert!((1..=500).contains(&screen.physical_rows));
            assert!(screen.scrollback_rows() >= screen.physical_rows);
            assert!(terminal.cell_at(terminal.bounds.origin).is_some());
        })
        .unwrap();
    }
    for event in [
        Some(Output::Error("reader failed".into())),
        Some(Output::Closed),
        None,
    ] {
        cx.update_window(handle.into(), |_, window, cx| {
            let (sender, receiver) = mpsc::channel();
            if let Some(event) = event {
                sender.send(event).unwrap();
            }
            drop(sender);
            view.update(cx, |view, cx| {
                view.running = true;
                view.session.as_mut().unwrap().output = receiver;
                view.read_output(cx);
                assert!(!view.running);
                assert!(!view.status.is_empty());
                assert!(view.snapshot().output.len() <= 500);
            });
            window.render_frame(cx);
            window.press("cmd-alt-c", cx);
        })
        .unwrap();
    }
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, _| view.close());
        assert!(view.read(cx).cell_at(point(px(0.), px(0.))).is_none());
        window.render_frame(cx);
        window.press("cmd-alt-c", cx);
        window.press("shift-home", cx);
    })
    .unwrap();
}

#[test]
fn fragmented_unicode_invalid_bytes_and_escape_sequences_remain_bounded_and_recover() {
    let mut payload = b"\xff\xfe\xc0\xaf\xe2\x82\r\n".to_vec();
    payload.extend_from_slice("界é🙂\r\n".as_bytes());
    payload.extend_from_slice(b"\x1b[31mRED\x1b[0m\r\n\x1b[999999999999999999999;999999999999999999H\x1b[0;0r\x1b[2;1r\x1b[999999999S\x1b[999999999T\x1b[?1049hALT\x1b[?1049l");
    payload.extend_from_slice("界é🙂".repeat(600).as_bytes());
    payload.extend((0..4096).map(|i| ((i * 73 + 19) % 256) as u8));
    payload.extend_from_slice(b"\x18\x1b\\");
    for (cols, rows) in [(2, 1), (8, 2), (80, 24)] {
        let new_terminal = || {
            Terminal::new(
                TerminalSize {
                    cols,
                    rows,
                    ..Default::default()
                },
                Arc::new(Configuration),
                "test",
                "1",
                Box::new(std::io::sink()),
            )
        };
        let text = |terminal: &Terminal| {
            terminal
                .screen()
                .lines_in_phys_range(0..terminal.screen().scrollback_rows())
                .iter()
                .map(|line| line.as_str().into_owned())
                .collect::<Vec<_>>()
        };
        for chunk_size in [1, 2, 7, 31, 8192] {
            let mut terminal = new_terminal();
            for chunk in payload.chunks(chunk_size) {
                terminal.advance_bytes(chunk);
            }
            assert!(terminal.screen().scrollback_rows() <= rows + 3500);
            assert!((0..rows as i64).contains(&terminal.cursor_pos().y));
            assert!(terminal.cursor_pos().x <= cols);
            assert!(!terminal.is_alt_screen_active());
            // Repeat parser chunking cases; the largest grid needs one resize pass.
            for (new_cols, new_rows) in [(2, 1), (80, 24), (1000, 500), (8, 2)]
                .into_iter()
                .filter(|(new_cols, _)| *new_cols != 1000 || chunk_size == 1)
            {
                terminal.resize(TerminalSize {
                    cols: new_cols,
                    rows: new_rows,
                    ..Default::default()
                });
                assert!(terminal.screen().scrollback_rows() >= new_rows);
                assert!(terminal.screen().scrollback_rows() <= new_rows + 3500);
                Selection::all(&terminal).text(&terminal);
                let screen = terminal.screen();
                let lines = screen.lines_in_phys_range(0..screen.scrollback_rows());
                for query in ["", " ", "OK", "界", "é", "🙂", "İ", "missing"] {
                    for found in
                        crate::search::matches(&lines, screen.phys_to_stable_row_index(0), query)
                    {
                        assert!(screen.stable_row_to_phys(found.bounds().0.0).is_some());
                        assert!(screen.stable_row_to_phys(found.bounds().1.0).is_some());
                        assert!(found.columns(found.bounds().1.0, new_cols).end <= new_cols);
                        if !query.trim().is_empty() {
                            assert!(!found.text(&terminal).is_empty());
                        }
                    }
                }
            }
            terminal.advance_bytes(b"\x1bc\x1b[2J\x1b[HOK");
            assert!(text(&terminal)[0].starts_with("OK"));
        }
    }
}

#[test]
fn selections_expire_or_clip_safely_after_eviction_clear_and_resize() {
    let mut terminal = Terminal::new(
        TerminalSize {
            cols: 8,
            rows: 2,
            ..Default::default()
        },
        Arc::new(Configuration),
        "test",
        "1",
        Box::new(std::io::sink()),
    );
    terminal.advance_bytes("界é🙂\r\n");
    let old = Selection::all(&terminal);
    assert_eq!(old.text(&terminal), "界é🙂");
    terminal.advance_bytes("new\r\n".repeat(3600));
    assert!(old.text(&terminal).is_empty());
    let screen = terminal.screen();
    let first = screen.phys_to_stable_row_index(0);
    let mut partial = Selection::range((first - 1, 0), (first + 1, 7));
    assert_eq!(partial.text(&terminal), "new\nnew");
    for mode in [
        SelectionMode::Character,
        SelectionMode::Word,
        SelectionMode::Line,
    ] {
        let selected = Selection::new(&terminal, (first, 0), mode);
        assert!(!selected.text(&terminal).is_empty());
        partial.extend(&terminal, (first + 1, 0));
    }
    terminal.resize(TerminalSize {
        cols: 2,
        rows: 1,
        ..Default::default()
    });
    partial.text(&terminal);
    let screen = terminal.screen();
    let cursor_row = screen.phys_row(terminal.cursor_pos().y);
    let prompt = screen.lines_in_phys_range(cursor_row..cursor_row + 1)[0]
        .as_str()
        .trim_end()
        .to_string();
    terminal.erase_scrollback_and_viewport();
    assert!(partial.text(&terminal).is_empty());
    assert_eq!(Selection::all(&terminal).text(&terminal), prompt);
    terminal.advance_bytes(b"\x1b[2J");
    assert!(Selection::all(&terminal).text(&terminal).is_empty());
}

#[test]
fn saved_session_numbers_and_corrupt_files_fail_safely() -> anyhow::Result<()> {
    use crate::storage::{BrowserSnapshot, Snapshot, Store};
    for number in [
        -f32::MAX,
        -1.,
        0.,
        f32::MAX,
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
    ] {
        let mut snapshot = Snapshot {
            tabs: vec![TabSnapshot {
                id: uuid::Uuid::new_v4().to_string(),
                source: TabSource::default(),
                output: vec!["history".into(); 501],
                font_scale: number,
                scroll_offset: number,
                browser: BrowserSnapshot { width: number },
            }],
            ..Default::default()
        };
        snapshot.validate()?;
        let tab = &snapshot.tabs[0];
        assert!(tab.scroll_offset.is_finite() && tab.scroll_offset >= 0.);
        assert!((0.5..=2.5).contains(&tab.font_scale));
        assert!((15.0..=40.0).contains(&tab.browser.width));
        assert_eq!(tab.output.len(), 500);
        assert_eq!(snapshot.active_tab.as_ref(), Some(&tab.id));
        snapshot.tabs.push(tab.clone());
        assert!(
            snapshot.validate().is_err(),
            "duplicate IDs must be rejected"
        );
    }
    let directory =
        std::env::temp_dir().join(format!("terminal-corrupt-data-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory)?;
    let result = (|| -> anyhow::Result<()> {
        let store = Store::at(directory.clone());
        for bytes in [
            b"{".as_slice(),
            b"null",
            b"{\"tabs\":null}",
            b"\xff\xfe",
            b"{\"version\":999}",
            b"{\"tabs\":[{\"id\":\"bad-id\",\"source\":{\"kind\":\"local\"}}]}",
        ] {
            std::fs::write(directory.join("terminal-session.json"), bytes)?;
            if let Ok(mut snapshot) = store.load::<Snapshot>("terminal-session.json") {
                assert!(snapshot.validate().is_err());
            }
            assert_eq!(
                std::fs::read(directory.join("terminal-session.json"))?,
                bytes
            );
        }
        Ok(())
    })();
    std::fs::remove_dir_all(directory)?;
    result
}

#[test]
fn utf8_scalars_and_controls_render_identically_across_chunk_boundaries() {
    // WezTerm batches grapheme clusters per advance_bytes call. Combining marks split
    // between calls can be lost upstream; the crash stress test still exercises them.
    let payload = "ascii\r\n界é🙂\r\n\x1b[31mRED\x1b[0m\r\n\x1b[?1049hALT\x1b[?1049l\x1b[HOK";
    for (cols, rows) in [(2, 1), (8, 2), (80, 24)] {
        let terminal = || {
            Terminal::new(
                TerminalSize {
                    cols,
                    rows,
                    ..Default::default()
                },
                Arc::new(Configuration),
                "test",
                "1",
                Box::new(std::io::sink()),
            )
        };
        let mut reference = terminal();
        reference.advance_bytes(payload);
        let lines = |terminal: &Terminal| {
            terminal
                .screen()
                .lines_in_phys_range(0..terminal.screen().scrollback_rows())
                .iter()
                .map(|line| (line.as_str().into_owned(), line.last_cell_was_wrapped()))
                .collect::<Vec<_>>()
        };
        for chunk_size in [1, 2, 3, 7, 31, 8192] {
            let mut fragmented = terminal();
            for chunk in payload.as_bytes().chunks(chunk_size) {
                fragmented.advance_bytes(chunk);
            }
            assert_eq!(
                lines(&fragmented),
                lines(&reference),
                "grid={cols}x{rows}, chunk={chunk_size}"
            );
            assert_eq!(fragmented.cursor_pos().x, reference.cursor_pos().x);
            assert_eq!(fragmented.cursor_pos().y, reference.cursor_pos().y);
            assert_eq!(
                fragmented.is_alt_screen_active(),
                reference.is_alt_screen_active()
            );
        }
    }
}
