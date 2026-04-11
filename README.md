<h1 align="center">Open Autoclicker</h1>
<p align="center">A clean, open-source autoclicker for Windows and macOS with configurable intervals, hotkeys, and system tray support.</p>

<p align="center">
  <a href="https://github.com/jasperdevs/open-autoclicker/releases/latest">
    <img src="https://img.shields.io/badge/Windows-download-4c71f2?style=flat&logo=windows&logoColor=white" alt="Download for Windows" />
  </a>
  <a href="https://github.com/jasperdevs/open-autoclicker/releases/latest">
    <img src="https://img.shields.io/badge/macOS-download-4c71f2?style=flat&logo=apple&logoColor=white" alt="Download for macOS" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/jasperdevs/open-autoclicker/releases">
    <img src="https://img.shields.io/github/downloads/jasperdevs/open-autoclicker/total?style=flat&logo=github&label=downloads&color=555" alt="GitHub downloads" />
  </a>
  <a href="https://github.com/jasperdevs/open-autoclicker/releases/latest">
    <img src="https://img.shields.io/github/downloads/jasperdevs/open-autoclicker/latest/total?style=flat&logo=github&label=downloads@latest&color=555" alt="GitHub latest release downloads" />
  </a>
  <a href="https://github.com/jasperdevs/open-autoclicker/stargazers">
    <img src="https://img.shields.io/github/stars/jasperdevs/open-autoclicker?style=flat&logo=github&label=stars&color=4c71f2" alt="GitHub stars" />
  </a>
</p>

## Download

Grab the latest release from the [**Releases page**](https://github.com/jasperdevs/open-autoclicker/releases/latest).

| Platform | File |
|----------|------|
| Windows | `.exe` (setup) or `.msi` (installer) |
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |

## Features

- **Configurable click interval** — hours, minutes, seconds, and milliseconds
- **Mouse button** — left, middle, or right click
- **Click type** — single or double click
- **Repeat mode** — click until stopped or a fixed number of times
- **Cursor position** — click at current position or a fixed coordinate
- **Global hotkey** — start and stop with a customizable hotkey (default: F6)
- **System tray** — runs in the background with tray menu controls
- **Dark and light mode** — follows your system theme
- **Auto-updates** — checks for new versions from GitHub Releases
- **Cross-platform** — native builds for Windows and macOS

## Built with

- [Tauri v2](https://tauri.app) — small, fast, native app shell
- [Rust](https://www.rust-lang.org) — backend logic and mouse simulation
- [TypeScript](https://www.typescriptlang.org) — frontend UI

## Development

```bash
# install dependencies
npm install

# run in development
npm run tauri dev

# build for production
npm run tauri build
```

## License

Open Autoclicker is open source under [MIT](LICENSE).
