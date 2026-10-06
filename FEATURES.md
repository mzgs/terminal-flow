# TerminalFlow — features, design style, and colors

Analyzed on **2026-10-03**. Installed application: `/Applications/TerminalFlow.app`, version **1.0.0**, bundle identifier `com.terminalflow.app`.

TerminalFlow is a desktop workspace for local shells, saved SSH connections, remote file transfers, and lightweight text editing. Its visual identity is a compact dark developer tool: a black terminal canvas, navy chrome, cool text, cyan accents, and rounded outlined controls.

## 1. Evidence and scope

- Inspected the installed app's `Info.plist`, packaged `app.asar`, main-process code, preload API, renderer JavaScript, CSS, and bundled screenshots.
- Found the matching project at `/Users/mustafa/Developer/terminal-flow`. Its compiled main, preload, renderer JavaScript, renderer CSS, and HTML **exactly match the installed application**, verified with SHA-256 comparisons.
- Used that project's readable TypeScript and CSS to trace behavior and extract exact defaults.
- `/Users/mustafa/Developer/FlowPanel`, supplied as a possible project location, is a separate Go/React server control panel. Its website, database, Docker, backup, and server-management features are not TerminalFlow features.
- This is a code and bundled-image analysis. The installed app was not launched, and live SSH/SFTP operations were not tested. Defaults below describe the implementation, not the user's current saved preferences.

Visual references: [main workspace](../terminal-flow/docs/images/terminalflow-general.png) and [SFTP browser](../terminal-flow/docs/images/terminalflow-sftp-browser.png).

## 2. Feature inventory

### Local terminal workspace

| Feature | Implemented behavior |
| --- | --- |
| Local shells | Native PTY processes through `node-pty`, displayed with `xterm.js`. |
| Multiple tabs | Create, activate, and close local or SSH terminal tabs. |
| Tab identification | Tabs show a status dot, title, and SSH server icon where applicable. Local titles incorporate working-directory/shell information. |
| Tab reordering | Drag tabs to change their order; the strip scrolls horizontally when needed. |
| Split panes | Split right into columns or split down into rows; up to **four panes per tab**. |
| Pane focus | Activate a pane independently; split panes have their own headers and close controls. |
| Resize handling | Terminal dimensions adapt to the available space and propagate to the PTY. |
| Scrollback | **5,000 lines** configured per terminal. |
| Clipboard and selection | Terminal context menu offers Copy, Paste, Select All, and Clear. |
| Selection actions | Selected paths can expose local/remote editing, remote downloading, archive extraction, and `chmod +x` followed by execution, where applicable. |
| Web search | Search selected terminal text using Google in the external browser. |
| File dropping | Dropping files into a local terminal inserts shell-quoted paths. Dropping into an SSH workspace uploads them to the remote target. |
| Open local folder | Open the active local terminal's working directory in the system file manager. |

The Rust app implements selection actions in the terminal context menu and command palette: edit local/remote paths, download remote paths, extract archives, make `.sh` or extensionless scripts executable and run them, and search selected text with Google in the external browser. Relative paths use the selected pane’s current directory. Extraction and execution send shell-quoted commands to that pane, with output and tool errors shown in the terminal. Extraction supports ZIP, TAR, compressed TAR (`.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tar.zst`, `.tgz`, `.tbz2`, `.txz`, `.tzst`, `.targz`), and standalone GZ/BZ2/XZ/ZST, using installed tools and keeping compressed originals. Standalone `.zst` files use `zstd -dk` on local or SSH panes, preserving the compressed file. When `zstd` or `unzip` is missing, extraction automatically installs it on the machine running the shell: apt-get, dnf/yum, zypper, apk, pacman, pkg, or Homebrew (binary bottles only). Linux/BSD installs use sudo when needed and may prompt in the terminal. Package-manager versions follow the configured repositories. Windows downloads the latest official Zstandard release binary from GitHub into `%LOCALAPPDATA%\RustTerminal\bin` and reuses it. Source builds are never used. Local Windows panes use PowerShell `Expand-Archive` for ZIP, `tar` for TAR, and `zstd` for ZST; chmod/run and standalone GZ/BZ2/XZ decompression are unavailable there.

Splits use a single orientation per tab. Once a tab contains columns, further splits remain columns; stacked panes remain rows. This is an equal-sized row/column layout, not an arbitrary nested split tree.

The Rust app implements this split-pane behavior with independent local/SSH sessions, pane headers and close controls, keyboard focus cycling, and split commands in the workspace menu and command palette. Session restore records the active pane per tab; split layouts are not persisted. See [controls](README.md#controls).

### Terminal search

- Find text in the active terminal's buffer with **Cmd/Ctrl+F**.
- Floating search bar near the terminal's upper-right corner.
- Match count, previous/next controls, and highlighted selection.
- **Enter** advances; **Shift+Enter** goes backward; **Escape** closes the search UI.
- Searches are case-insensitive literal substring matches, including reconstructed wrapped lines. The implementation does not provide regex, whole-word, or case-sensitive toggles.
- Search results refresh as terminal output changes, with a 120 ms debounce.

### SSH server management

| Feature | Implemented behavior |
| --- | --- |
| Saved profiles | Add, edit, and delete SSH servers. |
| Profile fields | Name, description, host, port, username, authentication method, private-key path/password, icon, and default remote start path. |
| Authentication | Password or private-key authentication. |
| Profile defaults | Port **22**, username **root**, private-key authentication, Linux icon. |
| Server picker | Top-right menu lists saved connections with an icon, name, and connection target. |
| Icon chooser | Searchable collection of operating-system, cloud-provider, database, and infrastructure SVG icons. These identify profiles; they do not imply integrations with those products. |
| SSH terminal | Start a remote shell from a saved profile using the system SSH client. |
| Working-directory tracking | Local and remote directory information is tracked where shell integration is available. |
| Reconnection | Retry interrupted SSH panes after a **5-second** delay and show connection/retry state. |
| Host-key maintenance | Profile dialog includes removal of saved host keys for rebuilt or re-keyed hosts; the main process also contains changed-host-key recovery logic. |

### Built-in SFTP browser

- Right-side browser associated with an SSH tab, with server identity and connection details.
- Navigate directories, go to the parent folder, and refresh the listing.
- Display names, file/folder type, permission strings, file size, and modification time.
- Group directories before files and filter the listing with a case-insensitive text query.
- Distinguish folders, archives, code, scripts, documents, images, audio, and video with file icons.
- Upload multiple files or folders through a native picker or drag and drop.
- Download files or directories with recursive transfer support.
- Create files and folders, rename entries, and delete entries with confirmation.
- Open eligible text files in the editor with Enter, double-click, or the context menu.
- Show upload/download progress as circular indicators in the titlebar, including completion state and tooltips.
- Resize the browser with a pointer or keyboard-accessible separator.
- Choose whether opening the browser restores its last folder or uses the current remote folder.

The browser starts at **320 px** wide, is constrained to **240–640 px**, and leaves at least **320 px** for the terminal. Below the **900 px** layout breakpoint it becomes an overlay panel.

### Local and remote text editor

- Modal editor powered by CodeMirror for local and remote text files.
- Syntax selection based on filename or extension, with plain text as the fallback.
- Highlighting for JavaScript/TypeScript/JSX/TSX, HTML, CSS/SCSS, JSON, Markdown, Python, Java, SQL, XML, YAML, shell scripts, PowerShell, Dockerfiles, Nginx configuration, TOML, INI/properties, diffs, and related configuration files.
- Header shows filename and path; metadata shows size, line count, language, line endings, and saved/unsaved status.
- Save with **Cmd/Ctrl+S**, revert edits, or close.
- Preserve detected LF, CRLF, or CR line endings on save.
- Confirm before discarding unsaved changes; disable editing and relevant controls while saving.
- Reject oversized files: **100 MiB local**, **16 MiB remote**; reject content detected as binary.

This is a quick-edit workflow in a single modal, rather than a project IDE with a persistent file tree and multiple editor tabs.

### Command palette and quick commands

- Open the command palette with **Cmd/Ctrl+P**.
- Search three groups: application commands, saved quick commands, and SSH servers.
- Matching scores support substrings, token prefixes, acronyms, and fuzzy token matches.
- Navigate with Up/Down, execute with Enter, dismiss with Escape.
- Built-in actions include Settings, New Tab, Split Right, Split Down, Clean, Close Pane, and Close Tab.
- Create, edit, and delete named command snippets in Settings → Quick Commands.
- Execute a saved command in the active connected terminal pane, local or SSH.
- Disable actions when the current state cannot support them, such as another split after the four-pane limit.

### Preferences and persistence

Settings has three sections: **General**, **Appearance**, and **Quick Commands**.

| Preference | Default / available values |
| --- | --- |
| Startup | Restore previous session; alternatively start clean. |
| New-tab directory | Configurable default working directory. |
| SFTP opening behavior | Restore last session; alternatively open current folder. |
| Terminal scheme | Midnight Blue by default; 12 built-in schemes listed below. |
| Font | JetBrains Mono Variable by default; nine bundled choices. |
| Font size | **14 px** default, range **10–24 px**. |
| Font weight | **400** default; 300, 400, 500, 600, 700. |
| Line height | **1.35** default, range **1.0–2.0**. |
| Cursor shape | **Bar** default; bar, block, underline. |
| Cursor blink | Enabled by default. |
| Cursor width | **2 px** default, range **1–6 px**. |
| Cursor/selection colors | Optional overrides of scheme colors. |
| Settings transfer | Import/export settings using native file dialogs. |
| Window state | Persist window bounds and maximized state. |

Appearance changes apply to existing terminal runtimes. Theme previews show sample terminal output, ANSI swatches, cursor appearance, and selection appearance.

The Rust app now implements **General** and **Appearance** settings tabs, all 12 schemes below, previews, nine embedded fonts, weights 300–700, line height, cursor shape/blink/width, and optional cursor/selection overrides (`#RRGGBB` or `#RRGGBBAA`). The Appearance layout matches TerminalFlow: typography and a live terminal preview, palette/custom color pickers, and a selectable theme grid. Cursor and spacing defaults live under General. Save updates every open pane without restarting shells; Cancel discards the draft. Programs may request their own cursor shape. Existing saved font families remain available; new installs default to JetBrains Mono. The Rust font-size range remains **10–32 px** for compatibility. The Rust app also implements a **Quick Commands** tab for adding, editing, and deleting named multiline shell snippets. Save commits the draft and Cancel discards it. The command palette searches saved snippets by name and runs them in the active local/SSH pane; closed or connecting panes disable execution. Settings import/export uses native file dialogs and includes Quick Commands.

Session restore reopens saved local/SSH tabs and restores their recorded directories, active-tab selection, and SSH browser path. It stores up to **500 plain-text output lines for local tabs**; SSH output is not persisted. The snapshot stores one restore state per tab and does **not** preserve the split-pane tree, live processes, or full terminal emulator state.

### macOS integration and automation

- Native traffic-light window buttons with a custom draggable titlebar.
- Single-instance application behavior.
- Registered **`terminalflow://`** URL scheme.
- `terminalflow://activate` brings the app forward.
- `terminalflow://new-terminal` creates a local tab; accepts percent-encoded `cwd`, `title`, and `command` parameters.
- The project includes an AppleScript Finder helper to open TerminalFlow at the current Finder folder. It is built as a separate helper app, rather than being a built-in Finder toolbar button.
- Packaging is configured for macOS, Windows, and Linux. This analysis verifies the installed macOS build only.

### Main keyboard shortcuts

“Primary” means Cmd on macOS and Ctrl elsewhere; the renderer accepts either modifier for these actions.

| Action | Shortcut |
| --- | --- |
| New tab | Primary+T |
| Close tab | Primary+W |
| Settings | Primary+, |
| Command palette | Primary+P |
| Find terminal output | Primary+F |
| Activate tab 1–9 | Primary+1…9 |
| Next tab | Ctrl+Tab or Primary+Shift+} |
| Previous tab | Ctrl+Shift+Tab or Primary+Shift+{ |
| Next / previous search match | Enter / Shift+Enter in search |
| Save edited file | Primary+S in editor |

## 3. Design style

### Overall visual character

**Dark, compact, technical, and terminal-first.** Most of the window is terminal output. Navigation lives in the titlebar, secondary tools appear in a side panel, and occasional tasks use menus or modal dialogs.

- Near-black and blue-black surfaces with pale cool text.
- Fine 1 px borders, translucent white/cyan fills, and restrained shadows.
- Small rounded rectangles, generally **8–12 px** radii.
- Lucide line icons for actions; colorful SVG product/OS icons for SSH profiles.
- Compact typography and modest headings, with enough space in forms and editors for readability.
- Brief color/opacity transitions, usually **140–160 ms**, plus draggable-tab motion, progress animation, and loading spinners.
- Limited glass effects: the search overlay uses `backdrop-filter: blur(12px)`. Most panels are solid dark surfaces or high-opacity fills.

The vivid pink/orange/yellow and purple/blue gradients around the windows in the reference screenshots are presentation backdrops, not the application's primary interface colors.

### Layout and sizing

| Element | Source-defined design |
| --- | --- |
| Default window | **1000 × 600 px**; minimum **640 × 480 px**. |
| Main shell | Two rows: **52 px titlebar** and the remaining workspace. |
| Titlebar | Native macOS controls, brand/tab count, scrollable tabs, then compact actions. |
| macOS titlebar inset | **88 px** left padding to make room for native controls. |
| Tabs | **34 px** high, **160–220 px** wide, **8 px** radius. |
| Tab status indicators | **6 px** circular dots. |
| Action icons | Commonly **14–18 px**, around 2–2.25 px stroke width. |
| Split-pane headers | **32 px** high; equal-sized panes separated by 1 px gaps/borders. |
| SFTP panel | Right side; **16 px 12 px 14 px** padding, **18 px** grid gaps. |
| Command palette | Up to **680 px** wide and **520 px** high; positioned near the upper center. |
| Settings dialog | Up to **820 px** wide, **24 px** padding, **10 px** radius. |
| SSH profile dialog | Up to **520 px** wide, **24 px** inner padding, **10 px** radius. |
| File editor | Up to **960 × 720 px**, constrained to the viewport, **10 px** radius. |

Main titlebar actions create a tab, open the active folder/browser, and open the server/settings menu. The active tab uses a brighter translucent fill and border rather than a large saturated color block.

### Typography

| Use | Font and sizing |
| --- | --- |
| UI font stack | `IBM Plex Sans`, `Segoe UI`, `-apple-system`, `BlinkMacSystemFont`, sans-serif. These are declared fallbacks; the actual UI font depends on availability. |
| Brand/titlebar | **13 px**, weight **600**, `0.03em` letter spacing. |
| Tab count/subtitle | **11 px**, muted blue-gray. |
| General UI copy | Commonly **12–14 px**. |
| SFTP/editor headings | **18 px**, weight **600**. |
| SSH dialog heading | **20 px**. |
| Terminal | JetBrains Mono Variable, **14 px / 1.35**, weight **400** by default. |
| Editor | JetBrains Mono Variable with IBM Plex Mono fallback, **13 px / 1.6**. |

Bundled terminal fonts: **Fira Code, JetBrains Mono, Cascadia Code, Hack, Source Code Pro, Inconsolata, IBM Plex Mono, Ubuntu Mono, and DejaVu Sans Mono**.

### Interaction states

- Connection dots use yellow for connecting, mint for ready, and salmon for closed.
- Hover increases surface brightness and border opacity; active tabs use stronger white tint.
- Active terminal panes receive a subtle cyan outline.
- Selected menu/palette rows use a tinted background; keyboard shortcut badges remain small.
- Disabled controls lose opacity and use the appropriate unavailable cursor.
- Forms show loading/saving labels and inline error states.
- Menus and dialogs use ARIA labels/roles; the SFTP separator supports keyboard resizing. These are implementation observations, not a full accessibility audit.

## 4. Exact interface colors

### Shared workspace tokens

Values are taken from `src/renderer/src/assets/base.css`. RGBA values are intentionally retained because their visible result depends on the surface beneath them.

| Role / token | Value | Use |
| --- | --- | --- |
| Background | `#09111B` | Base body background token. |
| Surface | `rgba(10, 17, 29, 0.82)` | Translucent navy surface. |
| Strong surface | `rgba(7, 13, 22, 0.96)` | Deeper, more opaque surface. |
| Border | `rgba(112, 150, 189, 0.22)` | Muted blue-gray separation. |
| Primary text | `#EEF4FF` | Cool near-white interface text. |
| Muted text | `#94A8C3` | Secondary metadata and descriptions. |
| Accent | `#77D7FF` | Cyan borders, progress, focus, and selected details. |
| Soft accent | `rgba(119, 215, 255, 0.14)` | Tinted accent backgrounds. |
| Success | `#7BF2B0` | Ready status and completed transfers. |
| Warning | `#FFD479` | Connecting status. |
| Danger | `#FF8D89` | Closed status and general error emphasis. |
| Scrollbar thumb | `rgba(82, 88, 96, 0.92)` | Neutral dark-gray thumb. |
| Scrollbar hover | `rgba(108, 115, 124, 0.96)` | Brighter gray thumb on hover. |

### Component-specific surfaces

The declared background token is not the final fill for every screen; `main.css` applies component backgrounds and gradients.

| Component | Exact styling |
| --- | --- |
| Body background | Radial glow `rgba(52, 127, 188, 0.18)` fading at 38%, over `#03070C → #000000`. |
| App shell | Vertical gradient `rgba(10, 16, 25, 0.96) → rgba(0, 0, 0, 0.96)`. |
| Titlebar | `rgba(8, 12, 18, 0.92)` background; `#CFD9EA` text. |
| Titlebar divider | `rgba(119, 215, 255, 0.12)`. |
| Inactive tab | White at **4%** fill and **8%** border opacity. |
| Active tab | White at **10%** fill and **16%** border opacity. |
| Tab hover | White at **8%** fill and **14%** border opacity. |
| Server menu | `rgba(8, 12, 18, 0.98)`; white border at **10%**. |
| SFTP/settings/editor dialog | `#0C121C`. |
| Command palette | `#0B111A`. |
| Editor canvas | `#090E16`. |
| Search overlay | `rgba(8, 14, 23, 0.94)` with 12 px backdrop blur. |
| Modal scrim | `rgba(5, 10, 16, 0.82)` for settings/editor. |
| Active pane border | `rgba(119, 215, 255, 0.22)`. |
| Search highlight | `#E0CB7D` background, `#171102` text; inactive selection `#FFD84A`. |

### SSH configuration dialog palette

This dialog defines a separate neutral charcoal palette in `.ssh-config-dialog-shell`.

| Role | Value |
| --- | --- |
| Background / input surface | `#121212` |
| Dialog surface | `#1E1E1E` |
| Text | `#FFFFFF` |
| Muted text | `rgba(255, 255, 255, 0.72)` |
| Border | `rgba(225, 225, 225, 0.14)` |
| Primary action / active border | `#4F8CFF` |
| Primary hover | `#76A6FF` |
| Primary soft fill | `rgba(79, 140, 255, 0.18)` |
| Secondary / accent | `#03DAC6` |
| Accent hover fill | `rgba(3, 218, 198, 0.08)` |
| Danger button | `#EF4444` |
| Danger hover | `#F87171` |
| Focus ring | `rgba(79, 140, 255, 0.22)` |

This is a visible design inconsistency to account for when using TerminalFlow as a reference: the workspace uses blue-black/cyan with soft salmon errors, while SSH forms use neutral charcoal/blue/teal with stronger red destructive actions.

## 5. Terminal color schemes

Terminal schemes change terminal appearance. They do not provide a complete theme switch for the surrounding menus, settings, SFTP panel, or editor.

| Scheme | Background | Foreground | Character |
| --- | --- | --- | --- |
| **Midnight Blue — default** | `#000000` | `#F5F5F5` | Hard black with cool blue and pastel ANSI colors. |
| Rose Pine | `#191724` | `#E0DEF4` | Muted mauve and soft cyan. |
| Dracula | `#282A36` | `#F8F8F2` | Violet-gray with vivid accents. |
| Solarized Dark | `#002B36` | `#839496` | Low-glare blue-green with muted text. |
| Nord | `#2E3440` | `#D8DEE9` | Cool gray and restrained arctic colors. |
| Gruvbox Dark | `#282828` | `#EBDBB2` | Warm earthy accents. |
| Tokyo Night | `#1A1B26` | `#C0CAF5` | Navy with blue, pink, and purple. |
| Tomorrow Night | `#1D1F21` | `#C5C8C6` | Muted classic dark colors. |
| Catppuccin Mocha | `#1E1E2E` | `#CDD6F4` | Dark mocha with pastel accents. |
| One Dark | `#1E2127` | `#ABB2BF` | Balanced cool gray. |
| One Light | `#F9F9F9` | `#383A42` | Light terminal canvas with dark text. |
| Monokai | `#272822` | `#F8F8F2` | Olive-black with saturated accents. |

### Default Midnight Blue ANSI palette

| ANSI color | Normal | Bright |
| --- | --- | --- |
| Black | `#000000` | `#4C566A` |
| Red | `#FF7B72` | `#FF8E8E` |
| Green | `#8FE388` | `#98F5A7` |
| Yellow | `#E6C15A` | `#FFE08A` |
| Blue | `#7AA2F7` | `#8DB0FF` |
| Magenta | `#C792EA` | `#D6A3FF` |
| Cyan | `#63D3FF` | `#7DE3FF` |
| White | `#F5F5F5` | `#FFFFFF` |

Default cursor: `#F5F5F5`, cursor accent: `#000000`. Default active/inactive selection background: `rgba(255, 255, 255, 0.18)`. Terminal ANSI colors and UI status colors are separate palettes.

## 6. Practical reference for this Rust app

Based on the current Rust project's README, it already has one local PTY session, selection/copy/paste, scrollback, zoom, clear, context menus, and terminal mouse reporting. TerminalFlow's main additions to study are:

1. **Tabs and pane ownership:** multiple independent runtimes with status, titles, focus, close behavior, and reordering.
2. **Search:** an overlay with match navigation and buffer-aware highlighting.
3. **SSH profiles and reconnection:** a saved server picker plus connection state and retry feedback.
4. **SFTP and quick editing:** a resizable remote browser beside the terminal and an editor for occasional file changes.
5. **Preferences and palette:** live terminal typography/cursor settings, command snippets, and configurable schemes.
6. **Persistence and automation:** restore recorded session metadata and support external requests to open a terminal at a directory.

For a similar visual direction, the most characteristic combination is a `#000000` terminal, `#0C121C` auxiliary panels, `#EEF4FF` primary text, `#94A8C3` secondary text, `#77D7FF` accents, 1 px low-opacity borders, compact controls, and 8–10 px corner radii. This is a reference recommendation, not an implemented change to the Rust application.

## 7. Source map

| Evidence | Local source |
| --- | --- |
| Application metadata | `/Applications/TerminalFlow.app/Contents/Info.plist` |
| Installed implementation | `/Applications/TerminalFlow.app/Contents/Resources/app.asar` |
| Product overview and screenshots | [TerminalFlow README](../terminal-flow/README.md) |
| UI features, defaults, schemes, editor, search | [App.tsx](../terminal-flow/src/renderer/src/App.tsx) |
| Shared color tokens and font stack | [base.css](../terminal-flow/src/renderer/src/assets/base.css) |
| Layout, component colors, states, dimensions | [main.css](../terminal-flow/src/renderer/src/assets/main.css) |
| PTY, SSH/SFTP, persistence, automation, file limits | [main process](../terminal-flow/src/main/index.ts) |
| Exposed desktop APIs | [preload](../terminal-flow/src/preload/index.ts) |
| Settings contract | [settings.ts](../terminal-flow/src/shared/settings.ts) |
| Session persistence contract | [session.ts](../terminal-flow/src/shared/session.ts) |
| Platform packaging | [electron-builder.yml](../terminal-flow/electron-builder.yml) |
| Current Rust app capabilities | [workspace README](README.md) |

The source links assume this workspace and `terminal-flow` remain sibling folders under `/Users/mustafa/Developer`.
