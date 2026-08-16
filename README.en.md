# DeepSeek Harness Launcher (DSHL)

A one-click launcher for DeepSeek Harness: **no Node.js installation, no source download, no browser**.
Double-click and go — the DSH Web UI runs in a native Electron window.

## Highlights

- **Zero-setup**: Bundles a portable Node.js and the `@deepseek-ai/dsh` dependency closure, so end users install nothing — no runtime, no browser.
- **Truly portable**: All data (user data, sessions, Electron caches) lives inside the program folder, never in the system AppData. The whole folder is a single movable unit.
- **One-click backup & migration**: Built-in "Backup & Migrate" wizard prepares the folder automatically, so moving/copying across drives never hangs.
- **Remote connection**: Skip the local host and connect straight to a remote DSH service for remote coding sessions, with easy local/remote switching.
- **Native window experience**: Frameless window + system tray. Closing the window minimizes to tray and keeps the host and conversation running.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Electron shell (app\main.js)                │
│   ├─ Spawns the bundled dsh host (Node proc) │
│   ├─ Parses "dsh web: http://127.0.0.1:<port>"│
│   └─ BrowserWindow loads that URL            │
├─────────────────────────────────────────────┤
│ build\node\   Portable Node.js (official)    │
│ build\dsh\    npm-installed @deepseek-ai/dsh │
│               (frontend dist + native addons) │
└─────────────────────────────────────────────┘
```

Electron is only a window shell: the DSH host runs inside the bundled official Node.js process,
sidestepping Electron's dedicated Node ABI and the `node-addon-require-builtin` / `koffi`
native-module compatibility issues. The Node version is fully controlled (requires ≥ 22.19 or ≥ 24).

## Portability

### All data lives inside the program folder

Everything the program writes stays inside the **program folder**, never in the system AppData:

| Folder | Contents |
|---|---|
| `.dsh\` | DSH core data: API keys, sessions, plugins, attachments, profile config, startup logs |
| `.launcher\` | Launcher Electron data: cache, Local Storage, etc. |

The **entire program folder is a single complete unit**: copy or move it and all data comes along — no import/export needed. Reinstall the OS, switch machines, carry it on a USB stick — just copy and run.

### Backup & migrate the program folder

While running, the program maintains a managed link tree at `.dsh\profiles\node_modules` that points
into the installation. **Moving/copying the folder directly makes the file explorer chase these links
and copy content repeatedly, which hangs and corrupts the folder.** A one-click migration is built in:

Tray menu "**Backup & Migrate…**" → click "**Clear managed link tree and exit**" → the program stops
the service, clears the link tree and exits → manually move/copy the whole folder → relaunch and the
link tree is rebuilt automatically.

Both user data and Electron data migrate intact — nothing is lost. If automatic clearing fails, exit
the program and run `.clean-links.bat`, or manually delete `.dsh\profiles\node_modules` before migrating.

## Remote Connection (remote coding sessions)

The launcher can connect to a **remote DSH service without starting a local host**, for remote coding
sessions. Three ways (priority: tray menu / dialog > command line > config file):

1. **UI input** (most common): tray menu "Connect to remote service…" or shortcut `Ctrl+L`, enter a
   remote address (e.g. `http://192.168.1.100:8080`) and click Connect; on failure an in-window error
   page shows the error code and a retry button. The local host keeps running in the background; use
   "Back to local service" to switch back anytime.
2. **Command line**: `DSHL.exe --remote http://192.168.1.100:8080`
3. **Config file**: add `remoteUrl` to `.dsh\launcher.json`:
   ```json
   { "remoteUrl": "http://192.168.1.100:8080" }
   ```

With `remoteUrl` configured, the launcher loads that address directly (the window title shows it) and
does not start the local host; when unreachable, an in-window error page appears, or use
"Reconnect remote service" to retry.

**Remote deployment prerequisite**: the DSH host listens only on `127.0.0.1` by default (the CLI
deliberately rejects `--host 0.0.0.0` to prevent remote code execution). Expose a remote port via SSH
tunnel or an intranet tunnel — e.g. run `dsh web --port 8080` on the remote machine, then locally
`ssh -L 8080:127.0.0.1:8080 user@remote`, and connect the launcher to `http://127.0.0.1:8080`.

**Self-signed https**: for a remote self-signed certificate, explicitly set `"insecure": true` in
`launcher.json` to ignore certificate errors (disabled by default; trusted intranet environments only).

## Build (one-time, on a machine with Node.js)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

Artifacts (`build\dist\`):

| Artifact | Description | Startup |
|---|---|---|
| `DSHL Setup 0.1.5.exe` | NSIS installer (for permanent install) | Instant after install |
| `DSHL-0.1.5-green.exe` | Green self-extracting single file (portable) | ~1 min first run, instant after |
| `DSHL-0.1.5-win.zip` | Green folder edition | Instant after unzip |

The end-user artifacts need no Node and no browser; just double-click. Package size is ~180-250MB
(Electron runtime + portable Node + dsh closure — expected).

### Green edition (green.exe) self-extraction

`green.exe` = [C# stub] + [win-unpacked zip payload]. On double-click:

- **First run**: a progress window extracts the full runtime to the `DSHL\` subfolder next to the exe
  (~1 minute) and then launches the app; user data persists under that subfolder's `.dsh\`.
- **Subsequent runs**: already extracted → launches directly (seconds), no re-extraction.
- Copying `green.exe` elsewhere re-extracts in place on first run — naturally portable.
- Implementation: `scripts\green-stub.cs` (compiled with csc, zero external deps, long-path handled).

### Tray & close behavior

- **Integrated modern window**: frameless + **transparent rounded corners** (a 24px-radius card body
  with the corners showing the desktop). Transparency depends on system DWM; on remote-desktop /
  virtualized environments where DWM compositing is disabled, it degrades to square corners.
- Minimal window: **no menu bar** — every action lives in the **tray icon right-click menu**
  (show/hide, connect remote, back to local, reconnect remote, copy service URL, open data dir, open
  log dir, data dir info, backup & migrate, about, quit).
- **Click the tray icon to toggle the window**; closing (X) minimizes to tray by default and keeps the
  host and conversation running. Use the tray menu "Quit" to really exit.
- In-window shortcuts: `Ctrl+L` connect remote, `Ctrl+Q` quit.
- To make closing quit directly, set in `.dsh\launcher.json`:
  ```json
  { "closeToTray": false }
  ```

### Port configuration

An idle port is picked automatically; the window title shows the live service address (e.g.
`DeepSeek Harness · http://127.0.0.1:8080`). To pin a port:

1. **Config file**: create `launcher.json` in the user data folder (`.dsh\`):
   ```json
   { "port": 8080 }
   ```
2. **Command line** (higher priority): `DSHL.exe --port 8080` (the green.exe forwards args too).

On port conflict the app fails to start with an error; remove the config or pick another port.

### Usage tips

- **Portable users**: prefer `green.exe` (single file, self-extracting in place) or the zip edition;
  reinstalling the OS or switching machines only needs copying the whole folder.
- **Permanent install**: use the Setup installer.
- Configure your DeepSeek API key in the DSH onboarding flow on first use.

### Build notes

- **Node download**: falls back to npmmirror when nodejs.org / GitHub are unreachable (China network);
  Electron and electron-builder toolchains also use npmmirror via `ELECTRON_MIRROR` /
  `ELECTRON_BUILDER_BINARIES_MIRROR`.
- **npm 11 allow-scripts**: it blocks install scripts of koffi / node-pty / dsh-subprocess-local,
  causing missing native prebuilt binaries; the build script runs `approve-scripts --all` and
  `rebuild` on those packages.
- **electron-builder extraResources filters node_modules**: the `afterPack` hook
  (`app\scripts\after-pack.js`) copies `build\node` and `build\dsh` into `resources\` after app
  packaging and before portable/NSIS assembly.
- **powershell.exe 5.1 exit-crash patch**: on some machines (security-software hook) powershell.exe
  crashes with 0xC0000005 when stdout is redirected; electron-builder's module collector wraps
  `npm list` with `powershell.exe -EncodedCommand`. The build script switches the collector to
  `pwsh.exe` (PowerShell 7, must be installed).

## Development

```powershell
# Prepare the host runtime (Node + dsh closure) first
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipPack
# Then run Electron in dev mode
cd app; npm install; npm start
```

## Notes

- DeepSeek Harness is a developer preview (0.1.0-rc) with officially stated breaking changes; when
  rebuilding, follow the latest npm release (`npm view @deepseek-ai/dsh version`).
- Configure your DeepSeek API key under "Settings → Models" on first use (DSH's own onboarding).
- If the user data folder is under a protected location such as Program Files, run with admin rights.
