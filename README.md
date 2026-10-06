# TerminalFlow

A native terminal for local development and remote work, built in Rust.

![TerminalFlow showcase: split panes, SSH and SFTP, and a built-in editor](assets/terminalflow-showcase.png)

**Split panes · SSH & SFTP · Built-in editor**

## Features

### Terminal and workspace

- Native terminal rendering with WezTerm's emulator and a real PTY for each shell.
- Uses your configured shell (`SHELL`), with a login shell on Unix; falls back to `/bin/sh` or PowerShell on Windows.
- ANSI colors, Unicode text, alternate-screen terminal apps, mouse reporting, and bracketed paste.
- Multiple tabs with directory or server labels and **Connecting**, **Ready**, and **Closed** indicators.
- Drag tabs to reorder them; the tab strip scrolls when tabs overflow.
- Split a tab into up to **four independent panes**, arranged side by side or in rows. New panes inherit the current directory and SSH profile.
- Switch tabs and panes with the keyboard, close individual panes, and restart a stopped shell.
- Reveal the local working directory in the system file manager, or open the SFTP panel for an SSH terminal.
- Scrollback with mouse-wheel, trackpad, and draggable scrollbar support.
- Per-pane zoom, reset to actual size, and a temporary status bar for shell and transfer messages.

### Selection, clipboard, and search

- Drag to select text, double-click for a word or path, triple-click for a line, and Shift-click to extend a selection.
- Hold **Shift** to select text in terminal apps that capture the mouse.
- Copy selected text, copy the visible screen, select all scrollback, paste from the clipboard, and paste with the middle mouse button.
- Selection handles Unicode and wrapped lines across scrollback.
- Case-insensitive literal search across the full terminal history, including wrapped lines, with highlighted results and a match counter.
- Navigate results with **Enter / Shift+Enter** or **⌘G / ⌘⇧G**; close search with **Escape**.
- Clear both the visible terminal and its scrollback.

### Actions on selected text

Select text or a filename in terminal output, then use the context menu or command palette:

- **Edit** a local or remote text file; relative paths resolve against the shell's current directory.
- **Download** a selected remote file to a local destination.
- **Extract archive** in the current shell: ZIP, TAR, compressed TAR (`.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tgz`, `.tbz2`, `.txz`, `.targz`), Zstandard (`.zst`, `.tar.zst`, `.tzst`), and standalone Gzip, Bzip2, or XZ files on Unix. Unix ZIP and Zstandard helpers can install a missing tool through a supported package manager; the Windows Zstandard helper can download an official release binary.
- **Run** a selected `.sh` or extensionless script in a Unix shell, making it executable first.
- **Search with Google** opens the selected text as a query in your browser.

### SSH connections

- Add, edit, connect to, and delete named server profiles; undo a profile deletion.
- Configure the host, port, username, optional starting directory, and a server icon from the bundled collection.
- Password authentication, default or agent keys, or a chosen private-key file with an optional saved passphrase.
- Saved passwords and passphrases use application-key encryption to obscure them in settings. The encryption key is embedded in the app binary.
- Connect from the server manager, workspace menu, or searchable command palette.
- SSH keepalives and automatic reconnect attempts every five seconds while the tab and window are active.
- One automatic recovery attempt for a changed host key during connection startup, with a message in the terminal.

### SFTP file browser and transfers

- Resizable remote file panel with an editable directory path, parent-folder navigation, and refresh.
- Case-insensitive filename filtering, folders listed first, file-type icons, sizes, and modification times.
- Open folders or edit files with **Enter**, a double-click, or the context menu.
- Create files and folders, rename entries, and delete files or folders with confirmation.
- Upload multiple files or folders, and download files or folders recursively.
- Drag local files or folders into the SFTP panel to upload them. Dropping them into an SSH terminal uploads to the remote shell's reported working directory.
- Dropping files into a local terminal inserts shell-quoted paths.
- Transfer progress with a percentage, current-file status, and cancellation controls.
- Remote folder deletion is recursive; symbolic links are removed without deleting their targets.

### Built-in file editor

- Open a local file with **⌘O**, edit a selected terminal path, or open a remote file from SFTP.
- Syntax highlighting selected from the filename for supported programming, configuration, shell, and markup languages.
- File metadata showing byte count, line count, language, line endings, and saved or unsaved state.
- Save with **⌘S**, preserving the detected LF, CRLF, or CR line endings and local file permissions.
- Detect changes made to the original file after opening it before saving over it.
- Save through atomic file replacement; remote saving requires the server's SFTP `posix-rename` extension.
- Unsaved-change prompts when closing the editor or quitting the app.
- UTF-8 text files up to **100 MiB locally** or **16 MiB remotely**; binary files and symbolic links are rejected.

### Command palette and quick commands

- **⌘P** opens a keyboard-driven palette with fuzzy, case-insensitive matching.
- Search workspace actions, saved quick commands, and SSH servers; server searches also match usernames, hosts, and ports.
- Add, edit, and delete named quick commands in **Settings → Quick Commands**, including multiline commands.
- Run a quick command in the active local or SSH pane.
- Put a **`$` marker** in a quick command to insert it without executing it and position the cursor at the marker. For example, `git commit -m '$'` leaves the cursor between the quotes. Multiline insertion requires a shell with bracketed paste enabled.

### Appearance and settings

- **12 color schemes:** Midnight Blue, Rose Pine, Dracula, Solarized Dark, Nord, Gruvbox Dark, Tokyo Night, Tomorrow Night, Catppuccin Mocha, One Dark, One Light, and Monokai.
- **10 font choices:** JetBrains Mono, Fira Code, Cascadia Code, Hack, Source Code Pro, Inconsolata, IBM Plex Mono, Ubuntu Mono, DejaVu Sans Mono, and Menlo. All except Menlo are bundled.
- Set font size (**10–32 px**), weight (**300–700** in steps of 100), and line height (**1.0–2.0**).
- Bar, block, or underline cursor; configurable blinking and bar width (**1–6 px**).
- Use palette defaults or custom cursor and selection colors, including transparency.
- Live appearance previews, a reset-to-defaults action, and saved changes applied to every open pane.
- Set the starting directory for new tabs and toggle session restoration.
- Import or export settings as JSON, including appearance, SSH profiles, and quick commands. Importing immediately replaces the current settings.
- Open the app data folder from Settings.

### Session restoration

- Automatically save tab order, the active tab, working directories, zoom, scroll positions, SFTP panel width, and window position, size, and maximized state.
- Restore up to **500 completed lines of local output per tab** and start a fresh shell in the saved directory.
- Restore SSH profile and directory information and reconnect when the tab becomes active.
- Each tab saves its active pane; split layouts and running processes are not restored. SSH output is not saved.
- A `--preview` workspace starts fresh with separate temporary app data and no personal SSH profiles or quick commands.

### macOS integration

- Install a native app bundle and a **TerminalFlow Finder** helper with the installation script below.
- The Finder helper opens a new terminal at the front Finder window's folder, or the Desktop when no Finder window is open.
- The **`terminalflow://` URL scheme** can activate the app or open a new local tab with an optional working directory, custom title, and startup command.

```sh
open 'terminalflow://activate'
open 'terminalflow://new-terminal?cwd=%2Ftmp&title=Scratch&command=pwd'
```

URL parameters are `cwd`, `title`, and `command`. Percent-encode parameter values; `cwd` must be an existing absolute directory. URL commands run in the newly opened shell.

## Workspace

![TerminalFlow with two terminal panes showing project files, Cargo metadata, a passing emulator test, and dependencies](assets/screenshots/workspace.jpg)

*A real TerminalFlow workspace: side-by-side shells, JetBrains Mono, and the Tokyo Night color scheme.*

## Command palette

Press **⌘P** to find workspace actions without leaving the keyboard.

![TerminalFlow command palette showing split-pane actions over a development workspace](assets/screenshots/command-palette.jpg)

## Run locally

Requires Rust **1.95 or newer** and Cargo. From the repository root:

```sh
./run.sh
```

For a fresh preview workspace:

```sh
./run.sh --preview
```

On macOS, build and install the app into `/Applications`:

```sh
./scripts/install-macos-app.sh
```

## Keyboard shortcuts

| Action | macOS shortcut |
| --- | --- |
| New tab | ⌘T |
| Next / previous tab | ⌃Tab / ⌃⇧Tab, or ⌘⇧] / ⌘⇧[ |
| Split right | ⌘D |
| Split down | ⌘⇧D |
| Next / previous pane | ⌘⌥→ / ⌘⌥← |
| Close pane | ⌘⇧W |
| Close tab | ⌘W |
| Command palette | ⌘P |
| Find in terminal | ⌘F |
| Next / previous search result | ⌘G / ⌘⇧G |
| Copy selection | ⌘C or ⌘⇧C |
| Copy visible screen | ⌘⌥C |
| Paste | ⌘V |
| Select all scrollback | ⌘A |
| Clear terminal and scrollback | ⌘K |
| Restart stopped shell / reconnect disconnected SSH | ⌘R |
| Show status bar | ⌘⇧B |
| Settings | ⌘, |
| Manage SSH servers | ⌘⇧S |
| Open local file | ⌘O |
| Save in file editor | ⌘S |
| Zoom in / out / reset | ⌘+ / ⌘− / ⌘0 |
| Quit | ⌘Q |

Additional Ctrl bindings are available: **Ctrl+P** for the palette, **Ctrl+T** for a new tab, **Ctrl+Shift+D / Ctrl+Alt+D** for splits, **Ctrl+Alt+←/→** for panes, **Ctrl+W** to close a tab, **Ctrl+Shift+W** to close a pane, **Ctrl+Shift+F** for search, **Ctrl+Shift+C/V/A** for copy/paste/select all, **Ctrl+Shift+K** to clear, **Ctrl+Shift+B** for status, **Ctrl+Shift+S** for servers, **Ctrl+,** for settings, and **Ctrl+Shift+=/−/0** for zoom. **Ctrl+Insert / Shift+Insert** also copy and paste. On non-macOS platforms, **Ctrl+F**, **Ctrl+O**, and **Ctrl+S** are also bound to search, open, and editor save.

Built with [GPUI Kit](https://github.com/longbridge/gpui-kit), [WezTerm's `wezterm-term`](https://github.com/wezterm/wezterm/tree/main/term) emulator, and its `portable-pty` library.
