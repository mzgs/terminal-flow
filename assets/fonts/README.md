# Bundled terminal fonts

These font files are embedded in the executable. Licenses accompany each family and are copied into the macOS app's Resources/font-licenses directory.

| Family | Source | Bundled weights |
| --- | --- | --- |
| JetBrains Mono | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono) | 300, 400, 500, 600, 700 |
| Fira Code | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/firacode) | 300, 400, 500, 600, 700 |
| Cascadia Code | [Microsoft releases](https://github.com/microsoft/cascadia-code/releases) | 300, 400, 600, 700 |
| Hack | [Hack](https://github.com/source-foundry/Hack/tree/master/build/ttf) | 400, 700 |
| Source Code Pro | [Adobe release fonts](https://github.com/adobe-fonts/source-code-pro/tree/release/TTF) | 300, 400, 500, 600, 700 |
| Inconsolata | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/inconsolata) | 300, 400, 500, 600, 700 |
| IBM Plex Mono | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/ibmplexmono) | 300, 400, 500, 600, 700 |
| Ubuntu Mono | [Google Fonts](https://github.com/google/fonts/tree/main/ufl/ubuntumono) | 400, 700 |
| DejaVu Sans Mono | [Fontsource](https://github.com/fontsource/font-files/tree/main/fonts/other/dejavu-mono) | 400, 700 |

JetBrains Mono, Fira Code, and Inconsolata are static instances of their variable fonts; their family/style/PostScript names identify each weight. DejaVu Sans Mono's Latin WOFF2 files from the reference project's Fontsource package were converted to TTF. Other files are original upstream TTFs. GPUI uses the nearest available face where a family lacks the requested weight, and system fallbacks for missing glyphs.
