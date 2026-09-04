# TubeSnag

**TubeSnag** is a fast, open-source desktop app for downloading YouTube videos as **MP3** (with embedded album art) or **MP4** — paste a link, or just copy one and it grabs it automatically. Built with [Tauri](https://tauri.app), React, and [yt-dlp](https://github.com/yt-dlp/yt-dlp).

![build](https://github.com/SamirWagle/tubesnag/actions/workflows/build.yml/badge.svg)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![built with Tauri](https://img.shields.io/badge/built%20with-Tauri-24C8DB)

## Screenshots

| Idle | Preview + quality picker |
|---|---|
| ![Idle state](.github/assets/empty-state.png) | ![Preview with quality picker](.github/assets/preview-quality.png) |

## Features

- 🎵 **Audio mode** — downloads the best available audio, converts to MP3, and embeds the video thumbnail as album art
- 🎬 **Video mode** — downloads and merges the best video + audio into MP4
- 🎚️ **Quality picker** — choose a specific resolution (video) or bitrate (audio), or just take the best available
- 📋 **Clipboard auto-detect** — copy a YouTube link anywhere and TubeSnag picks it up and previews it, no need to switch windows
- 📃 **Playlist support** — paste a playlist link and every video in it shows up ready to preview/download individually
- 📥 **Batch paste** — paste (or copy) several links at once, one per line, and they all get added together
- 📊 **Live progress** — per-download progress bar, speed, and ETA, with multiple downloads running in parallel
- 📁 **Configurable save folder** — pick where files land, open the folder from the app
- 🌓 **Clean dark UI** — custom titlebar, no browser chrome, just the app
- 💾 **Settings persist** — save folder, auto-detect toggle, and audio/video mode are remembered between launches
- 🖥️ **Cross-platform** — Windows, macOS, and Linux, all built and tested via CI

## Why

Most YouTube-downloader GUIs are either abandoned Electron apps bundling a stale `youtube-dl`, or a bare command line. TubeSnag wraps the actively-maintained [yt-dlp](https://github.com/yt-dlp/yt-dlp) engine in a small, fast native app (Tauri, not Electron — no bundled Chromium), with a UI built around the one workflow that actually matters: copy a link, get a file.

## Tech stack

| Layer | Tech |
|---|---|
| Shell | [Tauri 2](https://tauri.app) (Rust) |
| UI | React + TypeScript + Tailwind CSS |
| Download engine | [yt-dlp](https://github.com/yt-dlp/yt-dlp) (bundled as a sidecar binary) |
| Media processing | [FFmpeg](https://ffmpeg.org) (bundled as a sidecar binary) |

## Getting started (build from source)

Windows, macOS, and Linux are all supported. You'll need:

- [Node.js](https://nodejs.org) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Platform build tools:
  - **Windows**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `build-essential` (see [`.github/workflows/build.yml`](.github/workflows/build.yml) for the exact package list)

```bash
git clone https://github.com/SamirWagle/tubesnag.git
cd tubesnag
npm install
npm run setup      # downloads the yt-dlp / ffmpeg sidecar binaries for your platform
npm run tauri dev  # launches the app in dev mode
```

To build an installable package (`.msi`/`.exe` on Windows, `.dmg`/`.app` on macOS, `.deb`/`.AppImage` on Linux):

```bash
npm run tauri build
```

### Running tests

```bash
npm test              # frontend unit tests (Vitest)
cd src-tauri && cargo test   # backend unit tests
```

## How it works

TubeSnag doesn't reimplement a YouTube downloader — it drives `yt-dlp` and `ffmpeg` as bundled sidecar processes and streams their progress into the UI. Downloads land in a temp folder first and are moved into your chosen save folder only once complete, so a half-finished download never shows up as a real file (and it sidesteps cloud-sync tools like OneDrive locking files mid-write).

## Roadmap

- [ ] Auto-update yt-dlp from within the app
- [ ] Check for new TubeSnag releases and prompt to update
- [ ] Download history / library view
- [ ] Pause/cancel individual downloads
- [ ] System tray minimize
- [ ] Native macOS titlebar (traffic lights) instead of the fully custom one

Contributions welcome — open an issue or PR.

## Disclaimer

TubeSnag is a personal-use tool for downloading content you have the right to download (your own uploads, Creative Commons content, or videos where the creator/platform permits it). Respect copyright and each platform's terms of service.

## License

[MIT](./LICENSE) © Samir Wagle
