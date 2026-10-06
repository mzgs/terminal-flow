use std::ops::Range;
use wezterm_term::{StableRowIndex, Terminal};

pub(crate) fn extract_command(path: &str, windows: bool) -> Option<String> {
    crate::ssh::selected_path(path).ok()?;
    let lower = path.to_lowercase();
    if lower.ends_with(".zst") || lower.ends_with(".tzst") || !windows && lower.ends_with(".zip") {
        let tar = lower.ends_with(".tar.zst") || lower.ends_with(".tzst");
        return Some(if windows {
            use base64::Engine as _;
            let script =
                base64::engine::general_purpose::STANDARD.encode(include_str!("zstd-extract.ps1"));
            format!(
                "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{script}')))) '{}' ${tar}",
                path.replace('\'', "''")
            )
        } else {
            // Keep paste on one line even in shells without bracketed-paste support.
            let script = include_str!("archive-extract.sh")
                .replace('\\', "\\\\")
                .replace('\n', "\\n");
            format!(
                "sh -c \"$(printf '%b' {})\" -- {} {}",
                crate::ssh::quote(&script),
                crate::ssh::quote(path),
                if tar {
                    "tar"
                } else if lower.ends_with(".zip") {
                    "zip"
                } else {
                    "file"
                }
            )
        });
    }
    if windows && lower.ends_with(".zip") {
        return Some(format!(
            "Expand-Archive -LiteralPath '{}' -DestinationPath .",
            path.replace('\'', "''")
        ));
    }
    let command = if [
        ".tar", ".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".targz",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
    {
        "tar -xf"
    } else if !windows && lower.ends_with(".gz") {
        "gzip -dk"
    } else if !windows && lower.ends_with(".bz2") {
        "bzip2 -dk"
    } else if !windows && lower.ends_with(".xz") {
        "xz -dk"
    } else {
        return None;
    };
    let quoted = if windows {
        format!("'{}'", path.replace('\'', "''"))
    } else {
        crate::ssh::quote(path)
    };
    Some(format!("{command} {quoted}"))
}

pub(crate) fn run_command(path: &str) -> Option<String> {
    crate::ssh::selected_path(path).ok()?;
    let name = path.rsplit('/').next()?;
    // ponytail: match .sh and extensionless scripts; inspect shebangs if broader detection is needed.
    if name.is_empty() || name.contains('.') && !name.to_lowercase().ends_with(".sh") {
        return None;
    }
    let quoted = crate::ssh::quote(path);
    Some(format!("chmod +x {quoted} && {quoted}"))
}

pub(crate) fn google_search_url(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut url = gpui_kit::http_client::Url::parse("https://www.google.com/search").ok()?;
    url.query_pairs_mut().append_pair("q", text);
    Some(url.into())
}

// Row first, so ordinary tuple ordering follows terminal reading order.
pub(crate) type CellPosition = (StableRowIndex, usize);

#[derive(Clone, Copy, Default)]
pub(crate) enum SelectionMode {
    #[default]
    Character,
    Word,
    Line,
}

#[derive(Clone, Copy)]
pub(crate) struct Selection {
    anchor: (CellPosition, CellPosition),
    head: (CellPosition, CellPosition),
    mode: SelectionMode,
}

impl Selection {
    pub(crate) fn new(terminal: &Terminal, at: CellPosition, mode: SelectionMode) -> Self {
        let anchor = expand(terminal, at, mode);
        Self {
            anchor,
            head: anchor,
            mode,
        }
    }

    pub(crate) fn extend(&mut self, terminal: &Terminal, at: CellPosition) {
        self.head = expand(terminal, at, self.mode);
    }

    pub(crate) fn range(start: CellPosition, end: CellPosition) -> Self {
        Self {
            anchor: (start, start),
            head: (end, end),
            mode: SelectionMode::Character,
        }
    }

    pub(crate) fn all(terminal: &Terminal) -> Self {
        let screen = terminal.screen();
        let first = (screen.phys_to_stable_row_index(0), 0);
        let last = (
            screen.phys_to_stable_row_index(screen.scrollback_rows() - 1),
            screen.physical_cols - 1,
        );
        Self {
            anchor: (first, first),
            head: (last, last),
            mode: SelectionMode::Character,
        }
    }

    pub(crate) fn bounds(&self) -> (CellPosition, CellPosition) {
        (
            self.anchor.0.min(self.head.0),
            self.anchor.1.max(self.head.1),
        )
    }

    pub(crate) fn columns(&self, row: StableRowIndex, width: usize) -> Range<usize> {
        let (start, end) = self.bounds();
        if row < start.0 || row > end.0 {
            return 0..0;
        }
        let left = if row == start.0 { start.1 } else { 0 };
        let right = if row == end.0 { end.1 + 1 } else { width };
        left.min(width)..right.min(width)
    }

    pub(crate) fn text(&self, terminal: &Terminal) -> String {
        let screen = terminal.screen();
        let (start, end) = self.bounds();
        let first = start.0.max(screen.phys_to_stable_row_index(0));
        let last = end
            .0
            .min(screen.phys_to_stable_row_index(screen.scrollback_rows() - 1));
        let Some(first_phys) = screen.stable_row_to_phys(first) else {
            return String::new();
        };
        let Some(last_phys) = screen.stable_row_to_phys(last) else {
            return String::new();
        };
        let mut text = String::new();
        for (ix, line) in screen
            .lines_in_phys_range(first_phys..last_phys + 1)
            .iter()
            .enumerate()
        {
            let row = first + ix as isize;
            let columns = self.columns(row, screen.physical_cols);
            let part = line.columns_as_str(columns.clone());
            if line.last_cell_was_wrapped() && columns.end == screen.physical_cols {
                text.push_str(&part);
            } else {
                text.push_str(part.trim_end());
                if row < last {
                    text.push('\n');
                }
            }
        }
        text.trim_end_matches('\n').to_owned()
    }
}

fn word_class(text: &str) -> u8 {
    match text.chars().next() {
        Some(c) if c.is_whitespace() => 0,
        Some(c) if c.is_alphanumeric() || "_./-~".contains(c) => 1,
        _ => 2,
    }
}

fn expand(
    terminal: &Terminal,
    at: CellPosition,
    mode: SelectionMode,
) -> (CellPosition, CellPosition) {
    let screen = terminal.screen();
    let Some(phys) = screen.stable_row_to_phys(at.0) else {
        return (at, at);
    };
    if matches!(mode, SelectionMode::Character) {
        if let Some(cell) = screen.lines_in_phys_range(phys..phys + 1)[0]
            .visible_cells()
            .find(|cell| (cell.cell_index()..cell.cell_index() + cell.width()).contains(&at.1))
        {
            return (
                (at.0, cell.cell_index()),
                (at.0, cell.cell_index() + cell.width() - 1),
            );
        }
        return (at, at);
    }
    let mut result = (at, at);
    screen.for_each_logical_line_in_stable_range(at.0..at.0 + 1, |rows, lines| {
        if matches!(mode, SelectionMode::Line) {
            result = ((rows.start, 0), (rows.end - 1, screen.physical_cols - 1));
        } else {
            let cells: Vec<_> = lines
                .iter()
                .enumerate()
                .flat_map(|(ix, line)| {
                    line.visible_cells().map(move |cell| {
                        (
                            (rows.start + ix as isize, cell.cell_index()),
                            cell.width(),
                            word_class(cell.str()),
                        )
                    })
                })
                .collect();
            if let Some(ix) = cells.iter().position(|(position, width, _)| {
                position.0 == at.0 && (position.1..position.1 + width).contains(&at.1)
            }) {
                let class = cells[ix].2;
                let mut left = ix;
                let mut right = ix;
                while left > 0 && cells[left - 1].2 == class {
                    left -= 1;
                }
                while right + 1 < cells.len() && cells[right + 1].2 == class {
                    right += 1;
                }
                result = (
                    cells[left].0,
                    (cells[right].0.0, cells[right].0.1 + cells[right].1 - 1),
                );
            }
        }
        false
    });
    result
}

#[cfg(test)]
mod tests {
    use super::{extract_command, google_search_url, run_command};

    #[test]
    fn selection_actions_choose_tools_and_encode_search_text() {
        for suffix in [
            ".tar", ".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".targz",
        ] {
            assert!(
                extract_command(&format!("/tmp/file{suffix}"), false)
                    .unwrap()
                    .starts_with("tar -xf ")
            );
        }
        for (suffix, tool) in [
            (".gz", "gzip -dk"),
            (".bz2", "bzip2 -dk"),
            (".xz", "xz -dk"),
        ] {
            assert_eq!(
                extract_command(&format!("/tmp/file{suffix}"), false).unwrap(),
                format!("{tool} '/tmp/file{suffix}'")
            );
        }
        assert_eq!(
            extract_command("C:\\file's.zip", true).unwrap(),
            "Expand-Archive -LiteralPath 'C:\\file''s.zip' -DestinationPath ."
        );
        assert_eq!(
            extract_command("C:\\file.tar", true).unwrap(),
            "tar -xf 'C:\\file.tar'"
        );
        assert!(extract_command("C:\\file.gz", true).is_none());
        for suffix in [".zst", ".tar.zst", ".tzst", ".ZIP"] {
            for windows in [false, true] {
                let command = extract_command(&format!("/tmp/file{suffix}"), windows).unwrap();
                assert!(!command.contains(['\n', '\r']));
                assert!(command.contains(&format!("/tmp/file{suffix}")));
                if !windows {
                    assert!(command.ends_with(match suffix {
                        ".zst" => " file",
                        ".ZIP" => " zip",
                        _ => " tar",
                    }));
                }
            }
        }
        for path in ["/tmp/a.txt", "/tmp/a.sh/", "/tmp/..", "/tmp/a\n.sh", ""] {
            assert!(run_command(path).is_none());
            assert!(extract_command(path, false).is_none());
        }
        assert!(run_command("/tmp/script").is_some());
        let url = google_search_url("  café & Rust + #?\nnext  ").unwrap();
        let parsed = gpui_kit::http_client::Url::parse(&url).unwrap();
        assert_eq!(
            parsed.query_pairs().collect::<Vec<_>>(),
            [("q".into(), "café & Rust + #?\nnext".into())]
        );
        assert!(parsed.fragment().is_none());
        assert!(google_search_url(" \n ").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn commands_extract_and_run_literal_paths() -> anyhow::Result<()> {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let root = std::env::temp_dir().join(format!("selection-actions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let result = (|| -> anyhow::Result<()> {
            let source = root.join("source");
            let destination = root.join("destination");
            std::fs::create_dir(&source)?;
            std::fs::create_dir(&destination)?;
            std::fs::write(source.join("contents.txt"), "archive contents")?;
            let archive = root.join("-file's $(touch injected); &.tar.gz");
            assert!(
                Command::new("tar")
                    .arg("-czf")
                    .arg(&archive)
                    .arg("-C")
                    .arg(&source)
                    .arg("contents.txt")
                    .status()?
                    .success()
            );
            assert!(
                Command::new("sh")
                    .arg("-c")
                    .arg(extract_command(archive.to_str().unwrap(), false).unwrap())
                    .current_dir(&destination)
                    .status()?
                    .success()
            );
            assert_eq!(
                std::fs::read_to_string(destination.join("contents.txt"))?,
                "archive contents"
            );
            assert!(archive.exists());
            if Command::new("zstd").arg("--version").output().is_ok() {
                let plain = source.join("-file's $(touch injected); &.txt");
                let compressed = plain.with_extension("txt.zst");
                std::fs::write(&plain, "zstandard contents")?;
                assert!(
                    Command::new("zstd")
                        .arg("-q")
                        .arg(&plain)
                        .arg("-o")
                        .arg(&compressed)
                        .status()?
                        .success()
                );
                std::fs::remove_file(&plain)?;
                assert!(
                    Command::new("sh")
                        .arg("-c")
                        .arg(extract_command(compressed.to_str().unwrap(), false).unwrap())
                        .current_dir(&destination)
                        .status()?
                        .success()
                );
                assert_eq!(std::fs::read_to_string(&plain)?, "zstandard contents");
                assert!(compressed.exists());
            }
            let script = root.join("-file's $(touch injected); &.sh");
            std::fs::write(&script, "#!/bin/sh\nprintf executed > result.txt\n")?;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o600))?;
            assert!(
                Command::new("sh")
                    .arg("-c")
                    .arg(run_command(script.to_str().unwrap()).unwrap())
                    .current_dir(&destination)
                    .status()?
                    .success()
            );
            assert_eq!(
                std::fs::read_to_string(destination.join("result.txt"))?,
                "executed"
            );
            assert_ne!(std::fs::metadata(&script)?.permissions().mode() & 0o111, 0);
            let binary = root.join("codex");
            std::fs::write(&binary, "#!/bin/sh\nprintf classified > result.txt\n")?;
            let path = crate::ssh::download_path(root.to_str().unwrap(), "codex*")?;
            let command = run_command(&path).unwrap();
            assert!(!command.contains('*'));
            assert!(
                Command::new("sh")
                    .arg("-c")
                    .arg(command)
                    .current_dir(&destination)
                    .status()?
                    .success()
            );
            assert_eq!(
                std::fs::read_to_string(destination.join("result.txt"))?,
                "classified"
            );
            assert!(!destination.join("injected").exists());
            Ok(())
        })();
        std::fs::remove_dir_all(root)?;
        result
    }
}
