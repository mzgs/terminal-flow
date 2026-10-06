use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use wezterm_surface::CursorShape;
use wezterm_term::color::{ColorPalette, SrgbaTuple};

pub(crate) const FONTS: [&str; 10] = [
    "JetBrains Mono",
    "Fira Code",
    "Cascadia Code",
    "Hack",
    "Source Code Pro",
    "Inconsolata",
    "IBM Plex Mono",
    "Ubuntu Mono",
    "DejaVu Sans Mono",
    "Menlo",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Cursor {
    #[default]
    Bar,
    Block,
    Underline,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Appearance {
    pub scheme: String,
    pub font_weight: u16,
    pub line_height: f32,
    pub cursor_shape: Cursor,
    pub cursor_blink: bool,
    pub cursor_width: f32,
    pub cursor_color: Option<String>,
    pub selection_color: Option<String>,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            scheme: "midnight-blue".into(),
            font_weight: 400,
            line_height: 1.35,
            cursor_shape: Cursor::Bar,
            cursor_blink: true,
            cursor_width: 2.,
            cursor_color: None,
            selection_color: None,
        }
    }
}

impl Appearance {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            SCHEMES.iter().any(|s| s.id == self.scheme),
            "Choose a terminal scheme."
        );
        ensure!(
            [300, 400, 500, 600, 700].contains(&self.font_weight),
            "Choose a font weight from 300 to 700."
        );
        ensure!(
            self.line_height.is_finite() && (1.0..=2.0).contains(&self.line_height),
            "Line height must be between 1.0 and 2.0."
        );
        ensure!(
            self.cursor_width.is_finite() && (1.0..=6.0).contains(&self.cursor_width),
            "Cursor width must be between 1 and 6."
        );
        for (name, value) in [
            ("Cursor", &self.cursor_color),
            ("Selection", &self.selection_color),
        ] {
            ensure!(
                value.as_ref().is_none_or(|v| parse_color(v).is_some()),
                "{name} color must use #RRGGBB or #RRGGBBAA, or be empty for the scheme default."
            );
        }
        Ok(())
    }

    pub(crate) fn palette(&self) -> ColorPalette {
        let scheme = SCHEMES
            .iter()
            .find(|s| s.id == self.scheme)
            .unwrap_or(&SCHEMES[0]);
        let mut palette = ColorPalette {
            background: color(scheme.background),
            foreground: color(scheme.foreground),
            cursor_bg: self
                .cursor_color
                .as_deref()
                .and_then(parse_color)
                .unwrap_or(color(scheme.cursor)),
            cursor_fg: color(scheme.background),
            selection_fg: color(scheme.selection_foreground),
            selection_bg: self
                .selection_color
                .as_deref()
                .and_then(parse_color)
                .unwrap_or_else(|| {
                    let mut value = color(scheme.selection.0);
                    value.3 = scheme.selection.1;
                    value
                }),
            ..ColorPalette::default()
        };
        palette.cursor_border = palette.cursor_bg;
        for (ix, value) in scheme.ansi.iter().enumerate() {
            palette.colors.0[ix] = color(*value);
        }
        palette
    }

    // Programs can request their own cursor; the preference supplies the default.
    pub(crate) fn cursor(&self, requested: CursorShape) -> (Cursor, bool) {
        match requested {
            CursorShape::Default => (self.cursor_shape, self.cursor_blink),
            CursorShape::BlinkingBlock => (Cursor::Block, self.cursor_blink),
            CursorShape::BlinkingBar => (Cursor::Bar, self.cursor_blink),
            CursorShape::BlinkingUnderline => (Cursor::Underline, self.cursor_blink),
            CursorShape::SteadyBlock => (Cursor::Block, false),
            CursorShape::SteadyBar => (Cursor::Bar, false),
            CursorShape::SteadyUnderline => (Cursor::Underline, false),
        }
    }
}

fn color(value: u32) -> SrgbaTuple {
    SrgbaTuple(
        ((value >> 16) & 255) as f32 / 255.,
        ((value >> 8) & 255) as f32 / 255.,
        (value & 255) as f32 / 255.,
        1.,
    )
}

pub(crate) fn parse_color(value: &str) -> Option<SrgbaTuple> {
    let hex = value.strip_prefix('#')?;
    if !matches!(hex.len(), 6 | 8) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    Some(if hex.len() == 8 {
        let mut rgb = color(value >> 8);
        rgb.3 = (value & 255) as f32 / 255.;
        rgb
    } else {
        color(value)
    })
}

pub(crate) struct Scheme {
    pub id: &'static str,
    pub name: &'static str,
    background: u32,
    foreground: u32,
    cursor: u32,
    selection: (u32, f32),
    selection_foreground: u32,
    ansi: [u32; 16],
}

pub(crate) const SCHEMES: [Scheme; 12] = [
    Scheme {
        id: "midnight-blue",
        name: "Midnight Blue",
        background: 0x000000,
        foreground: 0xf5f5f5,
        cursor: 0xf5f5f5,
        selection: (0xffffff, 0.18),
        selection_foreground: 0xf5f5f5,
        ansi: [
            0x000000, 0xff7b72, 0x8fe388, 0xe6c15a, 0x7aa2f7, 0xc792ea, 0x63d3ff, 0xf5f5f5,
            0x4c566a, 0xff8e8e, 0x98f5a7, 0xffe08a, 0x8db0ff, 0xd6a3ff, 0x7de3ff, 0xffffff,
        ],
    },
    Scheme {
        id: "rose-pine",
        name: "Rose Pine",
        background: 0x191724,
        foreground: 0xe0def4,
        cursor: 0xe0def4,
        selection: (0xc4a7e7, 0.2),
        selection_foreground: 0xe0def4,
        ansi: [
            0x26233a, 0xeb6f92, 0x31748f, 0xf6c177, 0x9ccfd8, 0xc4a7e7, 0x9ccfd8, 0xe0def4,
            0x6e6a86, 0xeb6f92, 0x31748f, 0xf6c177, 0xc4a7e7, 0xebbcba, 0x9ccfd8, 0xe0def4,
        ],
    },
    Scheme {
        id: "dracula",
        name: "Dracula",
        background: 0x282a36,
        foreground: 0xf8f8f2,
        cursor: 0xf8f8f2,
        selection: (0xbd93f9, 0.28),
        selection_foreground: 0xf8f8f2,
        ansi: [
            0x21222c, 0xff5555, 0x50fa7b, 0xf1fa8c, 0xbd93f9, 0xff79c6, 0x8be9fd, 0xf8f8f2,
            0x6272a4, 0xff6e6e, 0x69ff94, 0xffffa5, 0xd6acff, 0xff92df, 0xa4ffff, 0xffffff,
        ],
    },
    Scheme {
        id: "solarized-dark",
        name: "Solarized Dark",
        background: 0x002b36,
        foreground: 0x839496,
        cursor: 0x839496,
        selection: (0x268bd2, 0.28),
        selection_foreground: 0x839496,
        ansi: [
            0x073642, 0xdc322f, 0x859900, 0xb58900, 0x268bd2, 0xd33682, 0x2aa198, 0xeee8d5,
            0x002b36, 0xcb4b16, 0x586e75, 0x657b83, 0x839496, 0x6c71c4, 0x93a1a1, 0xfdf6e3,
        ],
    },
    Scheme {
        id: "nord",
        name: "Nord",
        background: 0x2e3440,
        foreground: 0xd8dee9,
        cursor: 0xd8dee9,
        selection: (0x81a1c1, 0.28),
        selection_foreground: 0xd8dee9,
        ansi: [
            0x3b4252, 0xbf616a, 0xa3be8c, 0xebcb8b, 0x81a1c1, 0xb48ead, 0x88c0d0, 0xe5e9f0,
            0x4c566a, 0xbf616a, 0xa3be8c, 0xebcb8b, 0x81a1c1, 0xb48ead, 0x8fbcbb, 0xeceff4,
        ],
    },
    Scheme {
        id: "gruvbox-dark",
        name: "Gruvbox Dark",
        background: 0x282828,
        foreground: 0xebdbb2,
        cursor: 0xebdbb2,
        selection: (0x458588, 0.28),
        selection_foreground: 0xebdbb2,
        ansi: [
            0x282828, 0xcc241d, 0x98971a, 0xd79921, 0x458588, 0xb16286, 0x689d6a, 0xa89984,
            0x928374, 0xfb4934, 0xb8bb26, 0xfabd2f, 0x83a598, 0xd3869b, 0x8ec07c, 0xebdbb2,
        ],
    },
    Scheme {
        id: "tokyo-night",
        name: "Tokyo Night",
        background: 0x1a1b26,
        foreground: 0xc0caf5,
        cursor: 0xc0caf5,
        selection: (0x7aa2f7, 0.28),
        selection_foreground: 0xc0caf5,
        ansi: [
            0x15161e, 0xf7768e, 0x9ece6a, 0xe0af68, 0x7aa2f7, 0xbb9af7, 0x7dcfff, 0xa9b1d6,
            0x414868, 0xf7768e, 0x9ece6a, 0xe0af68, 0x7aa2f7, 0xbb9af7, 0x7dcfff, 0xc0caf5,
        ],
    },
    Scheme {
        id: "tomorrow-night",
        name: "Tomorrow Night",
        background: 0x1d1f21,
        foreground: 0xc5c8c6,
        cursor: 0xc5c8c6,
        selection: (0x373b41, 1.0),
        selection_foreground: 0xc5c8c6,
        ansi: [
            0x000000, 0xcc6666, 0xb5bd68, 0xf0c674, 0x81a2be, 0xb294bb, 0x8abeb7, 0xffffff,
            0x000000, 0xcc6666, 0xb5bd68, 0xf0c674, 0x81a2be, 0xb294bb, 0x8abeb7, 0xffffff,
        ],
    },
    Scheme {
        id: "catppuccin-mocha",
        name: "Catppuccin Mocha",
        background: 0x1e1e2e,
        foreground: 0xcdd6f4,
        cursor: 0xcdd6f4,
        selection: (0x89b4fa, 0.28),
        selection_foreground: 0xcdd6f4,
        ansi: [
            0x45475a, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xbac2de,
            0x585b70, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xa6adc8,
        ],
    },
    Scheme {
        id: "one-dark",
        name: "One Dark",
        background: 0x1e2127,
        foreground: 0xabb2bf,
        cursor: 0x5c6370,
        selection: (0x3a3f4b, 1.0),
        selection_foreground: 0xabb2bf,
        ansi: [
            0x1e2127, 0xe06c75, 0x98c379, 0xd19a66, 0x61afef, 0xc678dd, 0x56b6c2, 0xabb2bf,
            0x5c6370, 0xe06c75, 0x98c379, 0xd19a66, 0x61afef, 0xc678dd, 0x56b6c2, 0xffffff,
        ],
    },
    Scheme {
        id: "one-light",
        name: "One Light",
        background: 0xf9f9f9,
        foreground: 0x383a42,
        cursor: 0x383a42,
        selection: (0x3a3f4b, 1.0),
        selection_foreground: 0xffffff,
        ansi: [
            0x000000, 0xe45649, 0x50a14f, 0x986801, 0x4078f2, 0xa626a4, 0x0184bc, 0xa0a1a7,
            0x383a42, 0xe45649, 0x50a14f, 0x986801, 0x4078f2, 0xa626a4, 0x0184bc, 0xffffff,
        ],
    },
    Scheme {
        id: "monokai",
        name: "Monokai",
        background: 0x272822,
        foreground: 0xf8f8f2,
        cursor: 0xf8f8f2,
        selection: (0x66d9ef, 0.28),
        selection_foreground: 0xf8f8f2,
        ansi: [
            0x272822, 0xf92672, 0xa6e22e, 0xf4bf75, 0x66d9ef, 0xae81ff, 0xa1efe4, 0xf8f8f2,
            0x75715e, 0xf92672, 0xa6e22e, 0xf4bf75, 0x66d9ef, 0xae81ff, 0xa1efe4, 0xf9f8f5,
        ],
    },
];

pub(crate) fn register_fonts(cx: &gpui_kit::App) -> anyhow::Result<()> {
    cx.text_system().add_fonts(vec![
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/CascadiaCode-300.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/CascadiaCode-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/CascadiaCode-600.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/CascadiaCode-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/DejaVuSansMono-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/DejaVuSansMono-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/FiraCode-300.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/FiraCode-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/FiraCode-500.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/FiraCode-600.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/FiraCode-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/Hack-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/Hack-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexMono-300.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexMono-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexMono-500.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexMono-600.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexMono-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/Inconsolata-300.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/Inconsolata-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/Inconsolata-500.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/Inconsolata-600.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/Inconsolata-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-300.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-500.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-600.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/SourceCodePro-300.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/SourceCodePro-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/SourceCodePro-500.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/SourceCodePro-600.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/SourceCodePro-700.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/UbuntuMono-400.ttf")),
        std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/UbuntuMono-700.ttf")),
    ])
}

#[cfg(test)]
mod tests {
    use super::{Appearance, Cursor, FONTS, SCHEMES, parse_color};
    use crate::storage::Settings;
    use wezterm_surface::CursorShape;

    #[test]
    fn appearance_defaults_validation_palettes_and_legacy_settings() {
        let legacy: Settings =
            serde_json::from_str(r#"{"font_family":"Menlo","font_size":18}"#).unwrap();
        assert_eq!(legacy.appearance, Appearance::default());
        assert_eq!(legacy.font_family, "Menlo");
        assert_eq!(FONTS.len(), 10);
        assert!(FONTS.contains(&"Menlo"));
        for scheme in &SCHEMES {
            let mut appearance = Appearance {
                scheme: scheme.id.into(),
                ..Appearance::default()
            };
            appearance.validate().unwrap();
            let palette = appearance.palette();
            assert_ne!(palette.foreground, palette.background);
            appearance.cursor_color = Some("#123456".into());
            appearance.selection_color = Some("#abcdef80".into());
            assert_eq!(
                appearance.palette().cursor_bg,
                parse_color("#123456").unwrap()
            );
            assert_eq!(
                appearance.palette().selection_bg,
                parse_color("#abcdef80").unwrap()
            );
            assert_eq!(
                serde_json::from_str::<Appearance>(&serde_json::to_string(&appearance).unwrap())
                    .unwrap(),
                appearance
            );
        }
        for value in ["", "fff", "#12345", "#1234567", "#gg0000", "#é0000"] {
            assert!(parse_color(value).is_none());
        }
        let mut appearance = Appearance::default();
        assert_eq!(appearance.cursor(CursorShape::Default), (Cursor::Bar, true));
        assert_eq!(
            appearance.cursor(CursorShape::SteadyBlock),
            (Cursor::Block, false)
        );
        appearance.cursor_blink = false;
        assert_eq!(
            appearance.cursor(CursorShape::BlinkingUnderline),
            (Cursor::Underline, false)
        );
        for value in [0., 2.1, f32::NAN, f32::INFINITY] {
            appearance.line_height = value;
            assert!(appearance.validate().is_err());
        }
        appearance.line_height = 1.35;
        appearance.cursor_width = 7.;
        assert!(appearance.validate().is_err());
        appearance.cursor_width = 2.;
        appearance.font_weight = 450;
        assert!(appearance.validate().is_err());
        appearance.font_weight = 400;
        appearance.scheme = "missing".into();
        assert!(appearance.validate().is_err());
    }
}
