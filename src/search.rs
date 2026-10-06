use crate::selection::Selection;
use wezterm_surface::Line;
use wezterm_term::StableRowIndex;

/// Case-insensitive literal matches, mapped back to complete terminal cells.
pub(super) fn matches(lines: &[Line], first_row: StableRowIndex, query: &str) -> Vec<Selection> {
    let query = query.to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }
    let mut matches = Vec::new();
    let mut text = String::new();
    let mut cells = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let row = first_row + index as StableRowIndex;
        let plain = line.as_str();
        if text.is_empty() && plain.is_ascii() && !line.last_cell_was_wrapped() {
            for (start, _) in plain.trim_end().to_ascii_lowercase().match_indices(&query) {
                matches.push(Selection::range(
                    (row, start),
                    (row, start + query.len() - 1),
                ));
            }
            continue;
        }
        let mut wrapped = false;
        for cell in line.visible_cells() {
            wrapped = cell.attrs().wrapped();
            let start = text.len();
            text.extend(cell.str().chars().flat_map(char::to_lowercase));
            cells.push((start..text.len(), (row, cell.cell_index()), cell.width()));
        }
        if wrapped && index + 1 < lines.len() {
            continue;
        }
        for (start, _) in text.trim_end().match_indices(&query) {
            let first = cells.partition_point(|(bytes, _, _)| bytes.end <= start);
            let last = cells.partition_point(|(bytes, _, _)| bytes.start < start + query.len()) - 1;
            let (_, end, width) = &cells[last];
            matches.push(Selection::range(cells[first].1, (end.0, end.1 + width - 1)));
        }
        text.clear();
        cells.clear();
    }
    matches
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use wezterm_term::{Terminal, TerminalConfiguration, TerminalSize};

    #[derive(Debug)]
    struct Configuration;
    impl TerminalConfiguration for Configuration {
        fn color_palette(&self) -> wezterm_term::color::ColorPalette {
            Default::default()
        }
    }

    fn matches(terminal: &Terminal, query: &str) -> Vec<crate::selection::Selection> {
        let screen = terminal.screen();
        super::matches(
            &screen.lines_in_phys_range(0..screen.scrollback_rows()),
            screen.phys_to_stable_row_index(0),
            query,
        )
    }

    #[test]
    fn searches_full_scrollback() {
        let mut terminal = Terminal::new(
            TerminalSize {
                rows: 24,
                cols: 160,
                ..Default::default()
            },
            Arc::new(Configuration),
            "test",
            "1",
            Box::new(std::io::sink()),
        );
        let line = format!("{}abc\r\n", "0123456789".repeat(15));
        terminal.advance_bytes(line.repeat(4000).as_bytes());
        let screen = terminal.screen();
        let first_row = screen.phys_to_stable_row_index(0);
        assert!(first_row > 0);
        let found = matches(&terminal, "abc");
        assert_eq!(found.len(), screen.scrollback_rows() - 1);
        assert_eq!(found[0].bounds().0, (first_row, 150));
        assert_eq!(found.last().unwrap().text(&terminal), "abc");
    }

    #[test]
    fn literal_search_maps_wrapped_unicode_and_colored_text_to_cells() {
        let mut terminal = Terminal::new(
            TerminalSize {
                rows: 4,
                cols: 8,
                ..Default::default()
            },
            Arc::new(Configuration),
            "test",
            "1",
            Box::new(std::io::sink()),
        );
        terminal.advance_bytes(
            "123456界AbC\r\nİ界é\r\n\x1b[31mabc\x1b[0m\r\nfirst\r\nsecond".as_bytes(),
        );
        let found = matches(&terminal, "界ABC");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text(&terminal), "界AbC");
        let (start, end) = found[0].bounds();
        assert_eq!(start.1, 6);
        assert_eq!(end.0, start.0 + 1);
        assert_eq!(end.1, 2);
        let found = matches(&terminal, "ABC");
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].text(&terminal), "abc");
        let found = matches(&terminal, "界é");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text(&terminal), "界é");
        assert_eq!(found[0].bounds().0.1, 1);
        assert_eq!(found[0].bounds().1.1, 3);
        assert!(matches(&terminal, "firstsecond").is_empty());
        assert!(matches(&terminal, "missing").is_empty());
        assert!(matches(&terminal, "").is_empty());
        terminal.advance_bytes(b"\x1b[?1049hother");
        assert!(matches(&terminal, "abc").is_empty());
        assert_eq!(matches(&terminal, "other").len(), 1);
        terminal.advance_bytes(b"\x1b[?1049l");
        assert_eq!(matches(&terminal, "abc").len(), 2);
    }
}
