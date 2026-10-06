use crate::selection::{CellPosition, Selection};
use gpui_kit::http_client::Url;
use wezterm_term::Terminal;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Url(String),
    File(String),
}

pub(super) struct Link {
    pub selection: Selection,
    pub target: Target,
}

impl Target {
    pub(super) fn parse(text: &str) -> Option<Self> {
        let text = text.trim().trim_matches(['\'', '"']);
        if text.chars().any(char::is_control) {
            return None;
        }
        if text.contains("://") {
            let url = Url::parse(text).ok()?;
            return match url.scheme() {
                "http" | "https" if url.host_str().is_some() => Some(Self::Url(url.into())),
                "file" => Some(Self::File(url.to_file_path().ok()?.to_str()?.to_owned())),
                _ => None,
            };
        }
        // ponytail: recognize path-shaped tokens; shell-escaped spaces need a shell parser.
        let mut path = text.trim_end_matches([':', ',', ';']);
        for _ in 0..2 {
            if let Some((prefix, suffix)) = path.rsplit_once(':')
                && !suffix.is_empty()
                && suffix.bytes().all(|b| b.is_ascii_digit())
            {
                path = prefix;
            }
        }
        let name = path.rsplit(['/', '\\']).next()?;
        if path.contains(['<', '>', '|', '=', '*', '?'])
            || name.is_empty()
            || matches!(name, "." | "..")
            || !(path.contains(['/', '\\']) || name.contains('.'))
        {
            return None;
        }
        Some(Self::File(path.to_owned()))
    }
}

pub(super) fn at(terminal: &Terminal, at: CellPosition) -> Option<Link> {
    let screen = terminal.screen();
    screen.stable_row_to_phys(at.0)?;
    let mut found = None;
    screen.for_each_logical_line_in_stable_range(at.0..at.0 + 1, |rows, lines| {
        let mut text = String::new();
        let mut cells = Vec::new();
        for (ix, line) in lines.iter().enumerate() {
            for cell in line.visible_cells() {
                let start = text.len();
                text.push_str(cell.str());
                cells.push((
                    start..text.len(),
                    (rows.start + ix as isize, cell.cell_index()),
                    cell.width(),
                    cell.attrs().hyperlink().cloned(),
                    cell.attrs().invisible(),
                ));
            }
        }
        let Some(ix) = cells.iter().position(|(_, position, width, _, _)| {
            position.0 == at.0 && (position.1..position.1 + width).contains(&at.1)
        }) else {
            return false;
        };
        if cells[ix].4 {
            return false;
        }
        let (start, end, target) = if let Some(link) = &cells[ix].3 {
            let Some(target) = Target::parse(link.uri()) else {
                return false;
            };
            let mut start = ix;
            let mut end = ix;
            while start > 0 && cells[start - 1].3.as_ref() == Some(link) {
                start -= 1;
            }
            while end + 1 < cells.len() && cells[end + 1].3.as_ref() == Some(link) {
                end += 1;
            }
            (start, end, target)
        } else {
            let byte = cells[ix].0.start;
            let mut tokens = text.char_indices();
            let mut token = None;
            while let Some((start, character)) = tokens.next() {
                if character.is_whitespace() || "<>".contains(character) {
                    continue;
                }
                let quoted = matches!(character, '\'' | '"');
                let mut end = text.len();
                for (offset, next) in tokens.by_ref() {
                    if if quoted {
                        next == character
                    } else {
                        next.is_whitespace() || "<>\"'".contains(next)
                    } {
                        end = offset;
                        break;
                    }
                }
                let raw = &text[start..end];
                let trimmed = raw.trim_start_matches(['\'', '"', '(', '[', '{']);
                let start = start + raw.len() - trimmed.len();
                let mut trimmed = trimmed.trim_end_matches(['.', ',', ';', ':', '\'', '"']);
                for (open, close) in [('(', ')'), ('[', ']'), ('{', '}')] {
                    while trimmed.ends_with(close)
                        && trimmed.matches(close).count() > trimmed.matches(open).count()
                    {
                        trimmed = &trimmed[..trimmed.len() - 1];
                    }
                }
                if (start..start + trimmed.len()).contains(&byte) {
                    token =
                        Target::parse(trimmed).map(|target| (start, start + trimmed.len(), target));
                    break;
                }
            }
            let Some((start, end, target)) = token else {
                return false;
            };
            let first = cells.partition_point(|(bytes, ..)| bytes.end <= start);
            let last = cells.partition_point(|(bytes, ..)| bytes.start < end) - 1;
            (first, last, target)
        };
        found = Some(Link {
            selection: Selection::range(
                cells[start].1,
                (cells[end].1.0, cells[end].1.1 + cells[end].2 - 1),
            ),
            target,
        });
        false
    });
    found
}

#[cfg(test)]
mod tests {
    use super::{Target, at};
    use crate::tests::Configuration;
    use std::sync::Arc;
    use wezterm_term::{Terminal, TerminalSize};

    #[test]
    fn detects_urls_paths_and_explicit_links_across_wrapped_unicode_cells() {
        let mut terminal = Terminal::new(
            TerminalSize {
                rows: 8,
                cols: 18,
                ..Default::default()
            },
            Arc::new(Configuration),
            "test",
            "1",
            Box::new(std::io::sink()),
        );
        terminal.advance_bytes("界 (https://example.com/a_(b)?x=1#here).\r\n'src/notes file.rs:12:3'\r\n\x1b]8;;https://example.org/docs\x07Read docs\x1b]8;;\x07\r\n\x1b]8;;javascript:alert(1)\x07unsafe\x1b]8;;\x07".as_bytes());
        let screen = terminal.screen();
        let first = screen.phys_to_stable_row_index(0);
        let link = at(&terminal, (first + 1, 2)).unwrap();
        assert_eq!(
            link.target,
            Target::Url("https://example.com/a_(b)?x=1#here".into())
        );
        assert_eq!(
            link.selection.text(&terminal),
            "https://example.com/a_(b)?x=1#here"
        );
        assert!(at(&terminal, (first, 0)).is_none());
        let link = at(&terminal, (first + 3, 9)).unwrap();
        assert_eq!(link.target, Target::File("src/notes file.rs".into()));
        assert_eq!(link.selection.text(&terminal), "src/notes file.rs:12:3");
        let link = at(&terminal, (first + 5, 6)).unwrap();
        assert_eq!(link.target, Target::Url("https://example.org/docs".into()));
        assert_eq!(link.selection.text(&terminal), "Read docs");
        assert!(at(&terminal, (first + 6, 0)).is_none());
        for input in [
            "",
            "word",
            ".",
            "../",
            "ftp://example.org/file",
            "https://",
            "file:///tmp/a%20b.txt\nnext",
            "a.txt\nnext",
        ] {
            assert!(Target::parse(input).is_none(), "{input}");
        }
        assert_eq!(
            Target::parse("file:///tmp/a%20b.txt"),
            Some(Target::File("/tmp/a b.txt".into()))
        );
        assert_eq!(
            Target::parse(r"C:\src\main.rs:42:7"),
            Some(Target::File(r"C:\src\main.rs".into()))
        );
        assert_eq!(
            Target::parse("../README.md"),
            Some(Target::File("../README.md".into()))
        );
    }
}
