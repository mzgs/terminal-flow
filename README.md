# Terminal

Desktop terminal application built with Electron, React, `xterm.js`, and `node-pty`.

## Overview

This project wraps the user shell in a desktop window and renders it with `xterm.js`.
The Electron main process owns the PTY session, the preload layer exposes a small IPC
API, and the React renderer handles terminal rendering, input, and resize syncing.

## Stack

- Electron + electron-vite
- React + TypeScript
- `@xterm/xterm` for terminal rendering
- `node-pty` for shell process management
- Electron Builder for desktop packaging

## Prerequisites

- Node.js
- npm

`node-pty` is a native dependency. `npm install` runs `electron-builder install-app-deps`
after install so the local Electron build has the correct native binaries.

## Getting Started

Install dependencies:

```bash
npm install
```

Start the app in development mode:

```bash
npm run dev
```

Preview the production build locally:

```bash
npm run start
```

## Scripts

```bash
npm run dev
npm run start
npm run lint
npm run typecheck
npm run build
npm run build:unpack
npm run build:mac
npm run build:win
npm run build:linux
```

## Project Structure

```text
src/main        Electron main process and PTY lifecycle
src/preload     Safe renderer API exposed through context bridge
src/renderer    React UI and xterm.js integration
src/shared      Shared terminal event and API types
build/          Packaging assets such as icons and macOS entitlements
```

## Behavior Notes

- The app starts the first available shell from the current environment.
- On macOS and Linux, the app attempts to ensure the `node-pty` `spawn-helper` is executable.
- Terminal size is synchronized with the window using `@xterm/addon-fit` and a `ResizeObserver`.
- When the window closes, the owned PTY session is cleaned up from the main process.

## Packaging

Create distributables with Electron Builder:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

Generated app output is written under `out/`.
