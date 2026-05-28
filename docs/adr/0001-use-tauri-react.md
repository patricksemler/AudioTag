# 1. Use Tauri 2 with a React + TypeScript frontend

Date: 2026-05-28

## Status

Accepted

## Context

AudioTag must run on Windows and macOS, feel lightweight, and be cheap/free to
distribute. Candidate stacks: Electron (JS), Tauri (Rust core + web UI), or
fully native (SwiftUI + WinUI).

## Decision

Use **Tauri 2** with a **React + TypeScript** frontend.

- Tauri produces small binaries with low memory use and ships native OS
  dialogs and an auto-updater — a better end-user experience than Electron.
- A Rust core pairs naturally with `lofty` (see ADR 0002) and keeps heavy I/O
  off the UI thread.
- React + TypeScript gives a mature ecosystem for the app's hardest UI piece:
  a virtualized, spreadsheet-style editable grid (TanStack Virtual).

## Consequences

- Contributors need a Rust toolchain in addition to Node/pnpm.
- Distribution benefits from code signing (Apple Developer account; Windows
  cert) to avoid OS warnings — an accepted, documented cost.
- The UI is a webview, so accessibility relies on the platform webview exposing
  the a11y tree (WKWebView → VoiceOver, WebView2 → Narrator/NVDA), which it does.
