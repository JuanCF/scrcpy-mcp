# scrcpy-mcp — Implementation Plan

> MCP (Model Context Protocol) server that gives AI agents full vision and control over Android devices via ADB + scrcpy.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Technology Stack & Dependencies](#3-technology-stack--dependencies)
4. [Project Structure](#4-project-structure)
5. [Tool Inventory (~34 tools)](#5-tool-inventory-34-tools)
6. [Resources (MCP Resources)](#6-resources-mcp-resources)
7. [Implementation Details](#7-implementation-details)
   - 7.1 [Entry Point](#71-entry-point--srcindexts)
   - 7.2 [ADB Utility Layer](#72-adb-utility-layer--srcutilsadbts)
   - 7.3 [scrcpy Utility Layer (PRIMARY)](#73-scrcpy-utility-layer--srcutilsscrcpyts-primary-control-module)
   - 7.4 [Session Tools](#74-session-tools--srctoolssessionts)
   - 7.5 [Device Tools](#75-device-tools--srctoolsdevicets)
   - 7.6 [Vision Tools](#76-vision-tools--srctoolsvisionts)
   - 7.7 [Input Tools](#77-input-tools--srctoolsinputts)
   - 7.8 [App Management Tools](#78-app-management-tools--srctoolsappsts)
   - 7.9 [UI Automation Tools](#79-ui-automation-tools--srctoolsuits)
   - 7.10 [Shell Tools](#710-shell-tools--srctoolsshellts)
   - 7.11 [File Transfer Tools](#711-file-transfer-tools--srctoolsfilests)
   - 7.12 [Clipboard Tools](#712-clipboard-tools--srctoolsclipboardts)
8. [Configuration Files](#8-configuration-files)
9. [Publishing & Distribution](#9-publishing--distribution)
10. [MCP Client Integration](#10-mcp-client-integration)
11. [Testing Strategy](#11-testing-strategy)
12. [Implementation Order](#12-implementation-order)
13. [Security Considerations](#13-security-considerations)
14. [Existing Alternatives & Differentiation](#14-existing-alternatives--differentiation)
15. [Prerequisites for Users](#15-prerequisites-for-users)

---

## 1. Project Overview

### What is this?

`scrcpy-mcp` is a **Model Context Protocol (MCP) server** written in TypeScript that allows AI coding agents (OpenCode, Claude Code, Cursor, VS Code Copilot, etc.) to **see and control Android devices** in real-time.

### Why build this?

AI agents are powerful at reasoning but blind to mobile screens. By exposing Android device control as MCP tools, any MCP-compatible AI assistant can:

- **See** the device screen (screenshots returned as images the AI can analyze)
- **Interact** with the device (tap, swipe, type, press keys)
- **Automate** tasks (launch apps, install APKs, run shell commands)
- **Debug** mobile apps (inspect UI hierarchy, read logs, transfer files)
- **Test** Android applications through natural language instructions

### How does MCP work?

MCP is an open protocol by Anthropic — think "USB-C for AI." It uses **JSON-RPC 2.0** over **stdio** (stdin/stdout) to let AI hosts discover and call tools exposed by servers:

```
┌──────────────┐  JSON-RPC (stdio)  ┌──────────────┐
│  AI Client   │ ◄────────────────► │  MCP Server  │
│  (OpenCode)  │   tools/list       │ (scrcpy-mcp) │
│              │   tools/call       │              │
└──────────────┘                    └──────────────┘
```

The AI client launches the MCP server as a child process, discovers available tools via `tools/list`, and calls them via `tools/call` with structured arguments. The server returns text, images, or structured data.

### Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript / Node.js | Most mature MCP SDK, largest ecosystem |
| Transport | stdio | Standard for local MCP servers, universal client support |
| **Primary control** | **scrcpy binary protocol** | **10-50x faster** than ADB shell for input and screenshots |
| Fallback control | ADB commands | Reliable fallback when scrcpy session is not active |
| Screenshot (primary) | scrcpy video stream + ffmpeg decode | ~33ms per frame at 30fps |
| Screenshot (fallback) | `adb exec-out screencap` | ~500ms, works without scrcpy |
| Input (primary) | scrcpy control socket | ~5-10ms per action (inject touch/key events) |
| Input (fallback) | `adb shell input` | ~100-300ms per action |
| Clipboard | scrcpy clipboard sync | Bypasses Android 10+ clipboard restrictions |
| UI analysis | `uiautomator dump` (ADB) | scrcpy doesn't provide UI tree — ADB is the only option |
| App management | ADB (`am`, `pm`) | scrcpy doesn't handle app lifecycle — ADB is the only option |
| File transfer | ADB (`push`, `pull`) | scrcpy doesn't handle files — ADB is the only option |
| Device selection | Optional `serial` parameter | Auto-selects when only one device is connected |

### scrcpy-first philosophy

This project is **built on top of scrcpy**, not just ADB. Reading the [scrcpy developer documentation](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md), scrcpy's architecture is:

1. **scrcpy-server** — a Java app pushed to and executed on the Android device as `shell` user
2. **scrcpy client** — connects via up to 3 sockets: **video**, **audio**, **control**
3. The control socket uses a **custom binary protocol** for bidirectional communication

The scrcpy control protocol natively provides these capabilities (no ADB shell needed):

| Capability | scrcpy control message | Latency |
|---|---|---|
| **Touch injection** (tap, swipe, drag) | `INJECT_TOUCH_EVENT` (type 2) | ~5-10ms |
| **Key injection** (home, back, enter, etc.) | `INJECT_KEYCODE` (type 0) | ~5-10ms |
| **Text input** | `INJECT_TEXT` (type 1) | ~5ms total |
| **Scroll** | `INJECT_SCROLL_EVENT` (type 3) | ~5-10ms |
| **Screen on/off** | `SET_DISPLAY_POWER` (type 10) | ~5ms |
| **Back or screen on** | `BACK_OR_SCREEN_ON` (type 4) | ~5ms |
| **Clipboard get** | `GET_CLIPBOARD` (type 8) | ~10ms |
| **Clipboard set** | `SET_CLIPBOARD` (type 9) | ~5ms |
| **Expand notifications** | `EXPAND_NOTIFICATION_PANEL` (type 5) | ~5ms |
| **Expand settings** | `EXPAND_SETTINGS_PANEL` (type 6) | ~5ms |
| **Collapse panels** | `COLLAPSE_PANELS` (type 7) | ~5ms |
| **Rotate device** | `ROTATE_DEVICE` (type 11) | ~5ms |
| **Start app** | `START_APP` (type 16) | ~50ms |
| **Video stream** (screenshots) | Video socket (H.264) | ~33ms/frame |
| **Clipboard auto-sync** | Device → client message | automatic |

ADB is used **only** for things scrcpy's protocol doesn't cover:

| Capability | Why ADB | scrcpy alternative? |
|---|---|---|
| Device listing | Need `adb devices` to enumerate | None |
| Device info (model, version, battery) | Need `getprop`, `dumpsys` | scrcpy only sends device name |
| App stop / install / uninstall / list | Need `am`, `pm`, `adb install` | scrcpy can start apps (`START_APP`) but not stop/install/list |
| UI hierarchy dump | Need `uiautomator dump` | None |
| Shell command execution | Arbitrary `adb shell` | None |
| File transfer | `adb push` / `adb pull` | None (scrcpy has drag-drop but it's GUI-only) |
| WiFi ADB connection | `adb tcpip` / `adb connect` | scrcpy has `--tcpip` but it's CLI-only |
| Screen recording to file | `adb shell screenrecord` or `scrcpy --record` | scrcpy can record but only via CLI flag, not control protocol |

---

## 2. Architecture

### High-level diagram

```
┌─────────────────────────────────────────────────────────┐
│                     MCP Client                          │
│  (OpenCode / Claude Code / Cursor / VS Code / etc.)     │
└──────────────────────┬──────────────────────────────────┘
                       │ stdio (JSON-RPC 2.0)
                       │ ← tools/list, tools/call
                       │ → results (text, images, errors)
┌──────────────────────▼──────────────────────────────────┐
│                   scrcpy-mcp server                     │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ Session  │ │ Vision   │ │ Input    │ │ Apps      │  │
│  │ + Device │ │ Tools    │ │ Tools    │ │ Tools     │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│  ┌────┴─────┐ ┌────┴─────┐ ┌────┴─────┐ ┌─────┴─────┐  │
│  │ UI       │ │ Shell    │ │ Files    │ │ Clipboard │  │
│  │ Tools    │ │ Tools    │ │ Tools    │ │ Tools     │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       └──────┬─────┴──────┬─────┴──────┬───────┘        │
│              │            │            │                 │
│      ┌───────▼────────┐ ┌─▼──────────┐                  │
│      │  scrcpy.ts     │ │  adb.ts    │ ← utility layer  │
│      │  (PRIMARY)     │ │ (FALLBACK) │                   │
│      │  - control sock│ │ - shell cmd│                   │
│      │  - video stream│ │ - screencap│                   │
│      │  - clipboard   │ │ - file xfer│                   │
│      └───────┬────────┘ └──┬─────────┘                  │
└──────────────┼─────────────┼────────────────────────────┘
               │             │
               ▼             ▼
    ┌──────────────────┐  ┌──────────┐
    │  scrcpy-server   │  │   ADB    │
    │  (on device)     │  │          │
    └────────┬─────────┘  └────┬─────┘
             │                 │
             └────────┬────────┘
                      │ USB / TCP
                      ▼
           ┌─────────────────────┐
           │   Android Device    │
           └─────────────────────┘
```

### Two modes of operation

| | scrcpy session active | No scrcpy session (fallback) |
|---|---|---|
| **Screenshots** | From video stream via ffmpeg (~33ms) | `adb exec-out screencap -p` (~500ms) |
| **Tap/Swipe/Input** | scrcpy control socket (~5-10ms) | `adb shell input` (~100-300ms) |
| **Text input** | scrcpy injects keystrokes | `adb shell input text` |
| **Key events** | scrcpy control socket | `adb shell input keyevent` |
| **Clipboard** | scrcpy clipboard sync | `adb shell cmd clipboard` (limited on Android 10+) |
| **App mgmt** | ADB (always) | ADB (always) |
| **UI hierarchy** | ADB (always) | ADB (always) |
| **Shell commands** | ADB (always) | ADB (always) |
| **File transfer** | ADB (always) | ADB (always) |

### Data flow: screenshot (scrcpy active)

```
1. AI Client → tools/call "screenshot" { serial: "abc123" }
2. scrcpy-mcp → reads latest frame from scrcpy video stream buffer
3. Frame is already decoded to JPEG/PNG by ffmpeg
4. scrcpy-mcp → base64-encodes the frame
5. scrcpy-mcp → returns: { content: [{ type: "image", data: "<base64>", mimeType: "image/png" }] }
6. Total latency: ~33ms
```

### Data flow: screenshot (ADB fallback)

```
1. AI Client → tools/call "screenshot" { serial: "abc123" }
2. scrcpy-mcp → no active session, falls back to ADB
3. scrcpy-mcp → spawns: adb -s abc123 exec-out screencap -p
4. ADB streams raw PNG bytes back to Node.js
5. scrcpy-mcp → base64-encodes the PNG
6. scrcpy-mcp → returns: { content: [{ type: "image", data: "<base64>", mimeType: "image/png" }] }
7. Total latency: ~500ms
```

### Data flow: tap (scrcpy active)

```
1. AI Client → tools/call "tap" { x: 540, y: 1200 }
2. scrcpy-mcp → writes touch event to scrcpy control socket (binary protocol)
3. scrcpy-server injects via InputManager.injectInputEvent() on device
4. scrcpy-mcp → returns: { content: [{ type: "text", text: "Tapped at (540, 1200)" }] }
5. Total latency: ~5-10ms
```

### Data flow: tap (ADB fallback)

```
1. AI Client → tools/call "tap" { x: 540, y: 1200 }
2. scrcpy-mcp → no active session, falls back to ADB
3. scrcpy-mcp → spawns: adb shell input tap 540 1200
4. ADB injects touch event on device
5. scrcpy-mcp → returns: { content: [{ type: "text", text: "Tapped at (540, 1200)" }] }
6. Total latency: ~100-300ms
```

---

## 3. Technology Stack & Dependencies

### Runtime

| Component | Version | Purpose |
|-----------|---------|---------|
| Node.js | >= 18.0.0 | JavaScript runtime |
| TypeScript | ~5.x | Type safety, modern JS features |

### Production dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/server` | ^1.x | MCP server SDK (McpServer, StdioServerTransport, types) |
| `zod` | ^3.x | Input schema validation (required peer dep of MCP SDK) |

### Dev dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.x | TypeScript compiler |
| `@types/node` | ^20.x | Node.js type definitions |
| `tsup` | ^8.x | Fast TypeScript bundler (bundles to single file for distribution) |
| `tsx` | ^4.x | TypeScript execution for development |

> **Minimal dependencies by design.** ADB and scrcpy are invoked as system binaries via `child_process.execFile` / `child_process.spawn` — no wrapper libraries needed.

### System requirements (user's machine)

| Binary | Required | Purpose |
|--------|----------|---------|
| `adb` | **Yes** | Android Debug Bridge — device communication, fallback control |
| `scrcpy` | **Recommended** | Provides the scrcpy-server binary for fast input/screenshots |
| `ffmpeg` | **Recommended** | Decodes H.264 video stream from scrcpy for screenshots |

> **Without scrcpy/ffmpeg:** The server still works using ADB fallback for everything, but input is 10-50x slower and screenshots take ~500ms instead of ~33ms. With scrcpy installed, the server automatically uses the fast path.

---

## 4. Project Structure

```
scrcpy-mcp/
├── src/
│   ├── index.ts                 # Entry point: create server, register all tools, start transport
│   ├── tools/
│   │   ├── session.ts           # start_session, stop_session — manage scrcpy connection lifecycle
│   │   ├── device.ts            # device_list, device_info, screen_on/off, rotate, expand/collapse panels
│   │   ├── vision.ts            # screenshot, screen_record_start, screen_record_stop
│   │   ├── input.ts             # tap, swipe, long_press, drag_drop, input_text, key_event
│   │   ├── apps.ts              # app_start, app_stop, app_install, app_uninstall, app_list, app_current
│   │   ├── ui.ts                # ui_dump, ui_find_element
│   │   ├── shell.ts             # shell_exec
│   │   ├── files.ts             # file_push, file_pull, file_list
│   │   └── clipboard.ts         # clipboard_get, clipboard_set
│   └── utils/
│       ├── adb.ts               # ADB command execution helpers, device resolution, output parsing
│       └── scrcpy.ts            # scrcpy-server lifecycle, control socket, video stream, clipboard sync
├── package.json                 # Project metadata, scripts, dependencies, npm publish config
├── tsconfig.json                # TypeScript compiler configuration
├── tsup.config.ts               # Bundler configuration (for npm publish)
├── .gitignore                   # Standard Node.js gitignore
├── .mcp.json                    # Example MCP client configuration for OpenCode
├── LICENSE                      # MIT license
└── README.md                    # User-facing docs: install, config, usage, tools reference
```

### File responsibilities & estimated sizes

| File | Lines (est.) | Responsibility |
|------|-------------|----------------|
| `src/index.ts` | ~60 | Import all tool modules, create `McpServer`, connect `StdioServerTransport` |
| `src/utils/adb.ts` | ~150 | `execAdb()`, `resolveSerial()`, `getDeviceProperty()`, `getScreenSize()` |
| `src/utils/scrcpy.ts` | ~400 | **Core module**: scrcpy-server push/launch, control socket (binary protocol for input injection), video stream management (ffmpeg decode to frame buffer), clipboard sync, session lifecycle |
| `src/tools/session.ts` | ~80 | 2 tools: `start_session` / `stop_session` to manage scrcpy connection |
| `src/tools/device.ts` | ~200 | 8 tools: device listing (ADB), screen on/off + rotate + panels (scrcpy native) |
| `src/tools/vision.ts` | ~120 | 3 tools for screenshots and recording |
| `src/tools/input.ts` | ~220 | 7 tools (including scroll) — scrcpy control socket / ADB fallback |
| `src/tools/apps.ts` | ~170 | 6 tools: app_start (scrcpy `START_APP`), rest via ADB |
| `src/tools/ui.ts` | ~150 | 2 tools for UI hierarchy analysis (always ADB) |
| `src/tools/shell.ts` | ~40 | 1 tool for arbitrary shell commands (always ADB) |
| `src/tools/files.ts` | ~100 | 3 tools for file transfer (always ADB) |
| `src/tools/clipboard.ts` | ~80 | 2 tools — use scrcpy clipboard sync when session active, ADB fallback |

**Estimated total: ~1,800 lines of TypeScript**

---

## 5. Tool Inventory (~34 tools)

### 5.1 Session Management (2 tools)

These tools manage the scrcpy connection to the device. When a session is active, input/vision/clipboard tools use the fast scrcpy path. When no session is active, they fall back to ADB.

| Tool Name | Parameters | Returns | Description |
|-----------|-----------|---------|-------------|
| `start_session` | `serial?`, `maxSize?`, `maxFps?`, `videoBitRate?` | Text (JSON) | Start a scrcpy session: push scrcpy-server to device, establish control socket + video stream. Returns session info. |
| `stop_session` | `serial?` | Text | Stop the scrcpy session and clean up resources |

> **Auto-session:** If scrcpy and ffmpeg are available, the server can optionally auto-start a session on first tool call. Configurable via `AUTO_START_SESSION` env var.

### 5.2 Device Management (8 tools)

| Tool Name | Parameters | Returns | Via | Description |
|-----------|-----------|---------|-----|-------------|
| `device_list` | — | Text (JSON array) | ADB | List all connected devices with serial, state, model |
| `device_info` | `serial?` | Text (JSON) | ADB | Detailed device info: model, Android version, screen size, SDK level, battery |
| `screen_on` | `serial?` | Text | **scrcpy** `SET_DISPLAY_POWER` / ADB | Wake the screen |
| `screen_off` | `serial?` | Text | **scrcpy** `SET_DISPLAY_POWER` / ADB | Turn screen off (keep mirroring) |
| `rotate_device` | `serial?` | Text | **scrcpy** `ROTATE_DEVICE` / ADB | Rotate the device screen |
| `expand_notifications` | `serial?` | Text | **scrcpy** `EXPAND_NOTIFICATION_PANEL` | Pull down the notification panel |
| `expand_settings` | `serial?` | Text | **scrcpy** `EXPAND_SETTINGS_PANEL` | Pull down the quick settings panel |
| `collapse_panels` | `serial?` | Text | **scrcpy** `COLLAPSE_PANELS` | Collapse notification/settings panels |

### 5.3 Vision (3 tools)

| Tool Name | Parameters | Returns | Via | Description |
|-----------|-----------|---------|-----|-------------|
| `screenshot` | `serial?` | **Image** (base64 PNG) | **scrcpy** / ADB | Capture screen — reads from scrcpy frame buffer (~33ms) or falls back to `adb screencap` (~500ms) |
| `screen_record_start` | `serial?`, `duration?`, `filename?` | Text | ADB | Start recording screen to device file |
| `screen_record_stop` | `serial?` | Text | ADB | Stop recording (sends SIGINT to screenrecord process) |

### 5.4 Input Control (7 tools)

All input tools use **scrcpy's control protocol natively** when a session is active (~5-10ms). These are the same mechanisms scrcpy uses internally — `INJECT_TOUCH_EVENT`, `INJECT_KEYCODE`, `INJECT_TEXT`, `INJECT_SCROLL_EVENT` — sent directly over the control socket. Falls back to `adb shell input` when no session is active.

| Tool Name | Parameters | Returns | Via | Description |
|-----------|-----------|---------|-----|-------------|
| `tap` | `x`, `y`, `serial?` | Text | **scrcpy** `INJECT_TOUCH_EVENT` / ADB | Tap at screen coordinates |
| `swipe` | `x1`, `y1`, `x2`, `y2`, `duration?`, `serial?` | Text | **scrcpy** `INJECT_TOUCH_EVENT` / ADB | Swipe gesture between two points |
| `long_press` | `x`, `y`, `duration?`, `serial?` | Text | **scrcpy** `INJECT_TOUCH_EVENT` / ADB | Long press at coordinates |
| `drag_drop` | `startX`, `startY`, `endX`, `endY`, `duration?`, `serial?` | Text | **scrcpy** `INJECT_TOUCH_EVENT` / ADB | Drag from one point to another |
| `input_text` | `text`, `serial?` | Text | **scrcpy** `INJECT_TEXT` / ADB | Type a text string into the focused field |
| `key_event` | `keycode`, `serial?` | Text | **scrcpy** `INJECT_KEYCODE` / ADB | Send a key event (HOME, BACK, ENTER, POWER, VOLUME_UP, etc.) |
| `scroll` | `x`, `y`, `dx`, `dy`, `serial?` | Text | **scrcpy** `INJECT_SCROLL_EVENT` / ADB | Scroll at position (dx=horizontal, dy=vertical) |

### 5.5 App Management (6 tools)

| Tool Name | Parameters | Returns | Via | Description |
|-----------|-----------|---------|-----|-------------|
| `app_start` | `packageName`, `forceStop?`, `serial?` | Text | **scrcpy** `START_APP` / ADB | Launch an app (scrcpy natively supports `+` prefix to force-stop before launch) |
| `app_stop` | `packageName`, `serial?` | Text | ADB | Force-stop an app |
| `app_install` | `apkPath`, `serial?` | Text | ADB | Install an APK file from host machine |
| `app_uninstall` | `packageName`, `serial?` | Text | ADB | Uninstall an app |
| `app_list` | `filter?`, `system?`, `serial?` | Text (JSON array) | ADB | List installed packages, optionally filter by name |
| `app_current` | `serial?` | Text (JSON) | ADB | Get the current foreground activity and package |

### 5.6 UI Automation (2 tools)

| Tool Name | Parameters | Returns | Via | Description |
|-----------|-----------|---------|-----|-------------|
| `ui_dump` | `serial?` | Text (XML) | ADB | Dump the full UI hierarchy via uiautomator |
| `ui_find_element` | `text?`, `resourceId?`, `className?`, `contentDesc?`, `serial?` | Text (JSON array) | ADB | Find UI elements matching criteria, return with bounds/tap coordinates |

### 5.7 Shell (1 tool)

| Tool Name | Parameters | Returns | Description |
|-----------|-----------|---------|-------------|
| `shell_exec` | `command`, `serial?` | Text | Execute an arbitrary ADB shell command and return output |

### 5.8 File Transfer (3 tools)

| Tool Name | Parameters | Returns | Via | Description |
|-----------|-----------|---------|-----|-------------|
| `file_push` | `localPath`, `remotePath`, `serial?` | Text | ADB | Push a file from host to device |
| `file_pull` | `remotePath`, `localPath`, `serial?` | Text | ADB | Pull a file from device to host |
| `file_list` | `path`, `serial?` | Text (JSON array) | ADB | List directory contents on device |

### 5.9 Clipboard (2 tools)

| Tool Name | Parameters | Returns | Via | Description |
|-----------|-----------|---------|-----|-------------|
| `clipboard_get` | `serial?` | Text | **scrcpy** `GET_CLIPBOARD` / ADB | Get clipboard content (scrcpy uses `GET_CLIPBOARD` control message — bypasses Android 10+ restrictions) |
| `clipboard_set` | `text`, `paste?`, `serial?` | Text | **scrcpy** `SET_CLIPBOARD` / ADB | Set clipboard content (scrcpy can optionally also paste with `paste=true`) |

### Tool count summary

| Category | scrcpy native | ADB only | Total |
|---|---|---|---|
| Session | — | — | 2 |
| Device Management | 4 (screen on/off, rotate, panels) | 2 (list, info) | 8* |
| Vision | 1 (screenshot via stream) | 2 (record start/stop) | 3 |
| Input | 7 (all via control socket) | 0 (ADB fallback only) | 7 |
| App Management | 1 (start) | 5 (stop, install, uninstall, list, current) | 6 |
| UI Automation | 0 | 2 | 2 |
| Shell | 0 | 1 | 1 |
| File Transfer | 0 | 3 | 3 |
| Clipboard | 2 (get/set) | 0 (ADB fallback only) | 2 |
| **Total** | **15** | **13** | **34** |

*\* expand_notifications, expand_settings, collapse_panels have no ADB fallback — they require a scrcpy session.*

**Total: 34 tools** (15 scrcpy-native, 13 ADB-only, 6 with ADB fallback)

---

## 6. Resources (MCP Resources)

MCP resources are read-only data endpoints clients can subscribe to:

| Resource URI | MIME Type | Description |
|-------------|-----------|-------------|
| `android://devices` | `application/json` | JSON array of currently connected devices |
| `android://device/{serial}/info` | `application/json` | Device info for a specific device |

Resources are secondary to tools — the tools are the primary interface. Resources provide passive data that clients can poll.

---

## 7. Implementation Details

### 7.1 Entry Point — `src/index.ts`

The entry point is minimal. It:
1. Creates an `McpServer` instance
2. Imports all tool registration functions from `src/tools/*.ts`
3. Calls each registration function, passing the server instance
4. Connects via `StdioServerTransport`

```typescript
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { registerSessionTools } from "./tools/session.js";
import { registerDeviceTools } from "./tools/device.js";
import { registerVisionTools } from "./tools/vision.js";
import { registerInputTools } from "./tools/input.js";
import { registerAppTools } from "./tools/apps.js";
import { registerUiTools } from "./tools/ui.js";
import { registerShellTools } from "./tools/shell.js";
import { registerFileTools } from "./tools/files.js";
import { registerClipboardTools } from "./tools/clipboard.js";

const server = new McpServer({
  name: "scrcpy-mcp",
  version: "0.1.0",
});

// Register all tool groups
registerSessionTools(server);   // scrcpy session lifecycle (start/stop)
registerDeviceTools(server);    // device listing and management (ADB)
registerVisionTools(server);    // screenshots (scrcpy/ADB), recording (ADB)
registerInputTools(server);     // tap, swipe, text, keys (scrcpy/ADB)
registerAppTools(server);       // app management (ADB)
registerUiTools(server);        // UI hierarchy (ADB)
registerShellTools(server);     // shell commands (ADB)
registerFileTools(server);      // file transfer (ADB)
registerClipboardTools(server); // clipboard (scrcpy/ADB)

// Connect transport and start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[scrcpy-mcp] Server running on stdio");
}

main().catch((err) => {
  console.error("[scrcpy-mcp] Fatal error:", err);
  process.exit(1);
});
```

**Critical rule:** Never use `console.log()` — it writes to stdout and corrupts the JSON-RPC protocol. Always use `console.error()` for any logging.

### 7.2 ADB Utility Layer — `src/utils/adb.ts`

This is the foundation that all tools build on. It provides:

#### `execAdb(args: string[]): Promise<{ stdout: string; stderr: string }>`

Spawns `adb` with the given arguments using `child_process.execFile`. Handles:
- Configurable ADB binary path via `ADB_PATH` environment variable (defaults to `"adb"`)
- Timeout (default 30 seconds, configurable per call)
- Error handling: throws descriptive errors on non-zero exit codes
- Stderr capture for debugging

#### `execAdbShell(serial: string, command: string): Promise<string>`

Convenience wrapper: `adb -s <serial> shell <command>`. Returns stdout trimmed.

#### `execAdbRaw(args: string[]): Promise<Buffer>`

Like `execAdb` but returns raw binary output (used for `screencap -p` which returns PNG bytes).

#### `resolveSerial(serial?: string): Promise<string>`

Resolves the device serial to use:
1. If `serial` is provided, use it directly
2. If `ANDROID_SERIAL` env var is set, use that
3. Run `adb devices` and:
   - If exactly 1 device is connected, use it
   - If 0 devices, throw `"No Android devices connected"`
   - If 2+ devices, throw `"Multiple devices connected. Specify serial parameter. Available: [...]"`

#### `getDevices(): Promise<DeviceInfo[]>`

Parses `adb devices -l` output into structured data:

```typescript
interface DeviceInfo {
  serial: string;
  state: "device" | "unauthorized" | "offline";
  model?: string;
  product?: string;
  transportId?: string;
}
```

#### `getScreenSize(serial: string): Promise<{ width: number; height: number }>`

Parses `adb shell wm size` output (e.g., `"Physical size: 1080x2400"`) into width/height.

### 7.3 scrcpy Utility Layer — `src/utils/scrcpy.ts` (PRIMARY CONTROL MODULE)

This is the **core module** of the project. It manages the scrcpy-server process on the device, the control socket for input injection, and the video stream for screenshots.

#### Session lifecycle

```
start_session():
  1. Locate scrcpy-server binary (SCRCPY_SERVER_PATH or bundled)
  2. Push scrcpy-server to device: adb push scrcpy-server /data/local/tmp/scrcpy-server.jar
  3. Set up port forwarding: adb forward tcp:<port> localabstract:scrcpy
  4. Start server on device: adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
       app_process / com.genymobile.scrcpy.Server <version> \
       tunnel_forward=true control=true audio=false clipboard_autosync=true \
       max_size=1024 max_fps=30
  5. Connect to the forwarded TCP port from Node.js
  6. Receive device metadata (device name, screen size)
  7. Split connection into: video socket + control socket
  8. Start ffmpeg process to decode H.264 video stream → frame buffer
  9. Store session in a Map<serial, ScrcpySession>

stop_session():
  1. Close control socket
  2. Kill ffmpeg process
  3. Kill scrcpy-server on device
  4. Remove port forwarding
  5. Clean up session from Map
```

#### ScrcpySession class

```typescript
class ScrcpySession {
  serial: string;
  controlSocket: net.Socket;     // TCP socket for sending control messages
  videoProcess: ChildProcess;     // ffmpeg decoding H.264 → raw frames
  frameBuffer: Buffer | null;     // Latest decoded frame (JPEG/PNG)
  screenSize: { width: number; height: number };
  
  // Input injection via control socket (binary protocol)
  async injectTouch(action: number, x: number, y: number, pressure?: number): Promise<void>;
  async injectKeycode(action: number, keycode: number, repeat?: number, metaState?: number): Promise<void>;
  async injectText(text: string): Promise<void>;
  async injectScroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  
  // Screen control
  async setScreenPowerMode(mode: number): Promise<void>;
  
  // Clipboard
  async setClipboard(text: string, paste?: boolean): Promise<void>;
  async getClipboard(): Promise<string>; // via device message from scrcpy-server
  
  // Video
  getLatestFrame(): Buffer | null;  // Returns latest JPEG from frame buffer
}
```

#### scrcpy binary control protocol

The control socket uses a custom binary protocol. Each message is a fixed-size byte array. The protocol is documented through scrcpy's unit tests:

**Control message types (sent from client → server):**

Derived from [control_msg.h](https://github.com/Genymobile/scrcpy/blob/master/app/src/control_msg.h) and [test_control_msg_serialize.c](https://github.com/Genymobile/scrcpy/blob/master/app/tests/test_control_msg_serialize.c):

| Type | ID | Size (bytes) | Payload | Used by tools |
|------|-----|------|---------|---------------|
| `INJECT_KEYCODE` | 0 | 14 | action(1) + keycode(4) + repeat(4) + metaState(4) | `key_event` |
| `INJECT_TEXT` | 1 | 5+len | length(4) + text(UTF-8, max 300 bytes) | `input_text` |
| `INJECT_TOUCH_EVENT` | 2 | 32 | action(1) + pointerId(8) + x(4) + y(4) + width(2) + height(2) + pressure(2) + actionButton(4) + buttons(4) | `tap`, `swipe`, `long_press`, `drag_drop` |
| `INJECT_SCROLL_EVENT` | 3 | 21 | x(4) + y(4) + width(2) + height(2) + hscroll(2) + vscroll(2) + buttons(4) | `scroll` |
| `BACK_OR_SCREEN_ON` | 4 | 2 | action(1) | `key_event` (BACK) |
| `EXPAND_NOTIFICATION_PANEL` | 5 | 1 | — | `expand_notifications` |
| `EXPAND_SETTINGS_PANEL` | 6 | 1 | — | `expand_settings` |
| `COLLAPSE_PANELS` | 7 | 1 | — | `collapse_panels` |
| `GET_CLIPBOARD` | 8 | 2 | copy_key(1) | `clipboard_get` |
| `SET_CLIPBOARD` | 9 | 14+len | sequence(8) + paste(1) + length(4) + text(UTF-8) | `clipboard_set` |
| `SET_DISPLAY_POWER` | 10 | 2 | on(1) | `screen_on`, `screen_off` |
| `ROTATE_DEVICE` | 11 | 1 | — | `rotate_device` |
| `UHID_CREATE` | 12 | variable | id(2) + vendor(2) + product(2) + name_len(1) + name + desc_len(2) + desc | (future: HID keyboard/mouse) |
| `UHID_INPUT` | 13 | variable | id(2) + size(2) + data | (future: HID input) |
| `UHID_DESTROY` | 14 | 3 | id(2) | (future: HID cleanup) |
| `OPEN_HARD_KEYBOARD_SETTINGS` | 15 | 1 | — | (not exposed) |
| `START_APP` | 16 | 2+len | name_length(1) + name(UTF-8) | `app_start` |
| `RESET_VIDEO` | 17 | 1 | — | (not exposed) |

**Key constants:**
- `SC_POINTER_ID_MOUSE` = `0xFFFFFFFFFFFFFFFF` (-1 as u64) — use for mouse-style touches
- `SC_POINTER_ID_GENERIC_FINGER` = `0xFFFFFFFFFFFFFFFE` (-2 as u64) — use for finger-style touches
- `SC_POINTER_ID_VIRTUAL_FINGER` = `0xFFFFFFFFFFFFFFFD` (-3 as u64) — for pinch-to-zoom second finger
- Touch pressure: `0xFFFF` = 1.0 (max), `0x0000` = 0.0 (release)
- Scroll values: i16 encoded as float in range [-1.0, 1.0] where `0x7FFF` = 1.0, `0x8000` = -1.0

**Device messages (received from server → client):**

| Type | ID | Payload | Used by tools |
|------|-----|---------|---------------|
| `CLIPBOARD` | 0 | length(4) + text(UTF-8) | `clipboard_get` (auto-sync) |

Reference: [test_control_msg_serialize.c](https://github.com/Genymobile/scrcpy/blob/master/app/tests/test_control_msg_serialize.c) | [control_msg.h](https://github.com/Genymobile/scrcpy/blob/master/app/src/control_msg.h)

#### Video stream decoding

The video socket receives an H.264 (or H.265) encoded stream. We pipe it through ffmpeg to decode frames:

```typescript
// Spawn ffmpeg to decode H.264 stream → JPEG frames
const ffmpeg = spawn("ffmpeg", [
  "-i", "pipe:0",           // Read H.264 from stdin
  "-vframes", "1",          // Decode 1 frame (for snapshot) or continuous
  "-f", "image2pipe",       // Output as image pipe
  "-vcodec", "mjpeg",       // Encode to JPEG
  "-q:v", "2",              // Quality level
  "pipe:1",                 // Write to stdout
]);

// Pipe video socket data to ffmpeg stdin
videoSocket.pipe(ffmpeg.stdin);

// Read decoded JPEG frames from ffmpeg stdout
ffmpeg.stdout.on("data", (chunk) => {
  this.frameBuffer = chunk; // Store latest frame
});
```

For continuous streaming, ffmpeg runs persistently and we maintain a circular buffer of the latest N frames.

#### Fallback detection

```typescript
function hasActiveSession(serial: string): boolean {
  return sessions.has(serial) && sessions.get(serial)!.controlSocket.writable;
}

// Used by input/vision/clipboard tools:
if (hasActiveSession(serial)) {
  // Use scrcpy control socket (fast path)
} else {
  // Fall back to ADB commands (slow path)
}
```

### 7.4 Session Tools — `src/tools/session.ts`

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveSerial } from "../utils/adb.js";
import { startSession, stopSession, getSession } from "../utils/scrcpy.js";

export function registerSessionTools(server: McpServer) {

  server.registerTool("start_session", {
    title: "Start scrcpy Session",
    description: "Start a scrcpy session for fast input control and screenshots. When a session is active, tap/swipe/text/screenshot are 10-50x faster. If scrcpy is not installed, tools still work via ADB fallback.",
    inputSchema: z.object({
      serial: z.string().optional().describe("Device serial number"),
      maxSize: z.number().optional().default(1024).describe("Max screen dimension in pixels (default 1024)"),
      maxFps: z.number().optional().default(30).describe("Max frames per second (default 30)"),
    }),
  }, async ({ serial, maxSize, maxFps }) => {
    const s = await resolveSerial(serial);
    const session = await startSession(s, { maxSize, maxFps });
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "connected",
        serial: s,
        screenSize: session.screenSize,
        message: "scrcpy session active. Input and screenshots will use the fast path.",
      }, null, 2) }],
    };
  });

  server.registerTool("stop_session", {
    title: "Stop scrcpy Session",
    description: "Stop the active scrcpy session. Tools will fall back to ADB commands.",
    inputSchema: z.object({
      serial: z.string().optional(),
    }),
  }, async ({ serial }) => {
    const s = await resolveSerial(serial);
    await stopSession(s);
    return {
      content: [{ type: "text", text: "scrcpy session stopped. Tools will use ADB fallback." }],
    };
  });
}
```

### 7.5 Device Tools — `src/tools/device.ts`

Each tool module exports a `register*Tools(server: McpServer)` function. Device tools always use ADB.

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDevices, execAdbShell, resolveSerial } from "../utils/adb.js";

export function registerDeviceTools(server: McpServer) {

  // device_list
  server.registerTool("device_list", {
    title: "List Devices",
    description: "List all connected Android devices with their serial numbers, state, and model",
  }, async () => {
    const devices = await getDevices();
    return {
      content: [{ type: "text", text: JSON.stringify(devices, null, 2) }],
    };
  });

  // device_info
  server.registerTool("device_info", {
    title: "Device Info",
    description: "Get detailed info about a device: model, Android version, screen size, SDK level, battery level",
    inputSchema: z.object({
      serial: z.string().optional().describe("Device serial number. If omitted, uses the only connected device."),
    }),
  }, async ({ serial }) => {
    const s = await resolveSerial(serial);
    const [model, version, sdk, screenSize, battery] = await Promise.all([
      execAdbShell(s, "getprop ro.product.model"),
      execAdbShell(s, "getprop ro.build.version.release"),
      execAdbShell(s, "getprop ro.build.version.sdk"),
      execAdbShell(s, "wm size"),
      execAdbShell(s, "dumpsys battery"),
    ]);
    // Parse and return structured info ...
  });

  // screen_on, screen_off, connect_wifi, disconnect_wifi ...
}
```

#### ADB commands used

| Tool | ADB Command |
|------|-------------|
| `device_list` | `adb devices -l` |
| `device_info` | `adb -s <serial> shell getprop ...`, `wm size`, `dumpsys battery` |
| `screen_on` | `adb -s <serial> shell input keyevent KEYCODE_WAKEUP` |
| `screen_off` | `adb -s <serial> shell input keyevent KEYCODE_SLEEP` |
| `connect_wifi` | `adb -s <serial> tcpip <port>`, then `adb -s <serial> shell ip route` to get IP, then `adb connect <ip>:<port>` |
| `disconnect_wifi` | `adb disconnect <address>` |

### 7.6 Vision Tools — `src/tools/vision.ts`

#### `screenshot` — The most important tool

This is the tool that gives AI agents "eyes." It captures the screen and returns the image inline so the AI model can analyze it.

**scrcpy path (~33ms):** Reads the latest decoded frame from the scrcpy video stream buffer.
**ADB fallback (~500ms):** Uses `adb exec-out screencap -p` to stream PNG from device.

```typescript
server.registerTool("screenshot", {
  title: "Screenshot",
  description: "Take a screenshot of the Android device screen. Returns the image so you can see what is displayed. Uses scrcpy stream when a session is active (~33ms), otherwise falls back to ADB (~500ms).",
  inputSchema: z.object({
    serial: z.string().optional().describe("Device serial number"),
  }),
}, async ({ serial }) => {
  const s = await resolveSerial(serial);
  
  // Try scrcpy fast path first
  const session = getSession(s);
  if (session) {
    const frame = session.getLatestFrame();
    if (frame) {
      return {
        content: [{
          type: "image",
          data: frame.toString("base64"),
          mimeType: "image/jpeg",
        }],
      };
    }
  }
  
  // ADB fallback
  const pngBuffer = await execAdbRaw(["-s", s, "exec-out", "screencap", "-p"]);
  return {
    content: [{
      type: "image",
      data: pngBuffer.toString("base64"),
      mimeType: "image/png",
    }],
  };
});
```

#### `screen_record_start` / `screen_record_stop`

Screen recording uses `adb shell screenrecord` (ADB always — scrcpy's recording is tied to its GUI client). Since it runs as a persistent process:
- `screen_record_start` spawns `adb shell screenrecord /sdcard/scrcpy-mcp-recording.mp4 --time-limit <duration>` in the background
- `screen_record_stop` sends interrupt via `adb shell pkill -INT screenrecord`, waits, then optionally pulls the file to the host

### 7.7 Input Tools — `src/tools/input.ts`

All input tools use scrcpy control socket when a session is active, otherwise fall back to ADB.

#### Dual-path implementation

```typescript
// Example: tap tool
async ({ x, y, serial }) => {
  const s = await resolveSerial(serial);
  const session = getSession(s);
  
  if (session) {
    // scrcpy fast path: inject touch event via control socket (~5-10ms)
    await session.injectTouch(ACTION_DOWN, x, y);
    await session.injectTouch(ACTION_UP, x, y);
  } else {
    // ADB fallback (~100-300ms)
    await execAdbShell(s, `input tap ${x} ${y}`);
  }
  
  return { content: [{ type: "text", text: `Tapped at (${x}, ${y})` }] };
};
```

#### scrcpy control protocol for input

| Action | scrcpy message | Binary format |
|--------|---------------|---------------|
| Tap | INJECT_TOUCH_EVENT (ACTION_DOWN then ACTION_UP) | type(1) + action(1) + pointerId(8) + x(4) + y(4) + w(2) + h(2) + pressure(2) + actionButton(4) + buttons(4) |
| Swipe | Series of INJECT_TOUCH_EVENT (DOWN, MOVE..., UP) | Same format, interpolated positions over duration |
| Long press | INJECT_TOUCH_EVENT (DOWN, delay, UP) | Hold DOWN for duration then send UP |
| Text | INJECT_TEXT | type(1) + length(4) + text(UTF-8) |
| Key event | INJECT_KEYCODE | type(1) + action(1) + keycode(4) + repeat(4) + metaState(4) |
| Scroll | INJECT_SCROLL_EVENT | type(1) + x(4) + y(4) + w(2) + h(2) + hscroll(4) + vscroll(4) + buttons(4) |

#### ADB fallback commands

| Tool | ADB Command |
|------|-------------|
| `tap` | `adb shell input tap <x> <y>` |
| `swipe` | `adb shell input swipe <x1> <y1> <x2> <y2> [duration_ms]` |
| `long_press` | `adb shell input swipe <x> <y> <x> <y> <duration_ms>` (swipe to same point = long press) |
| `drag_drop` | `adb shell input draganddrop <x1> <y1> <x2> <y2> [duration_ms]` |
| `input_text` | `adb shell input text "<escaped_text>"` |
| `key_event` | `adb shell input keyevent <keycode>` |

#### Text escaping

The `input_text` tool must escape special characters for the shell. Spaces become `%s`, special chars need quoting. This is handled in the utility layer.

#### Key event reference

The `key_event` tool accepts either numeric keycodes or string names. A built-in map provides friendly names:

```typescript
const KEY_MAP: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  END_CALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  ENTER: 66,
  DELETE: 67,       // Backspace
  TAB: 61,
  MENU: 82,
  APP_SWITCH: 187,  // Recent apps
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  WAKEUP: 224,
  SLEEP: 223,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  BRIGHTNESS_UP: 221,
  BRIGHTNESS_DOWN: 220,
  NOTIFICATION: 83,
};
```

The tool description will include this list so the AI knows what keys are available.

### 7.8 App Management Tools — `src/tools/apps.ts`

#### ADB commands used

| Tool | ADB Command |
|------|-------------|
| `app_start` | `adb shell am start <packageName>` or `adb shell am start -n <packageName>/<activity>` |
| `app_stop` | `adb shell am force-stop <packageName>` |
| `app_install` | `adb install -r <apkPath>` (from host filesystem) |
| `app_uninstall` | `adb uninstall <packageName>` |
| `app_list` | `adb shell pm list packages [-f] [-s\|-3]` |
| `app_current` | `adb shell dumpsys activity activities \| grep mResumedActivity` |

#### `app_list` filtering

- `system: boolean` — if true, include system apps (`-s`), if false, only third-party (`-3`), if omitted, all
- `filter: string` — grep-style filter on package names

#### `app_current` parsing

The `dumpsys activity activities` output contains a line like:
```
mResumedActivity: ActivityRecord{... com.example.app/.MainActivity ...}
```
The tool parses this to extract the package name and activity class.

### 7.9 UI Automation Tools — `src/tools/ui.ts`

#### `ui_dump` — Raw UI hierarchy

```
adb shell uiautomator dump /dev/tty
```

Dumps the UI hierarchy XML directly to stdout. The XML contains every visible UI element with attributes like:

```xml
<node index="0" text="Login" resource-id="com.app:id/login_btn"
      class="android.widget.Button" content-desc="Login button"
      bounds="[360,1140][720,1260]" />
```

The tool returns the full XML so the AI can reason about the UI structure.

#### `ui_find_element` — Smart element search

Parses the uiautomator XML and finds elements matching the given criteria. For each match, it computes the **center tap coordinates** from the `bounds` attribute.

```typescript
server.registerTool("ui_find_element", {
  title: "Find UI Element",
  description: "Find UI elements on screen by text, resource ID, class name, or content description. Returns matching elements with their tap coordinates.",
  inputSchema: z.object({
    serial: z.string().optional(),
    text: z.string().optional().describe("Text content to search for (partial match)"),
    resourceId: z.string().optional().describe("Resource ID to match (e.g., 'com.app:id/button')"),
    className: z.string().optional().describe("Class name (e.g., 'android.widget.Button')"),
    contentDesc: z.string().optional().describe("Content description (accessibility label)"),
  }),
}, async ({ serial, text, resourceId, className, contentDesc }) => {
  // 1. Dump UI hierarchy
  // 2. Parse XML
  // 3. Filter nodes by criteria
  // 4. For each match, parse bounds "[x1,y1][x2,y2]" → compute center (x, y)
  // 5. Return array of { text, resourceId, className, contentDesc, bounds, tapX, tapY }
});
```

This lets the AI say "find the Login button" and get back coordinates it can pass to `tap`.

### 7.10 Shell Tools — `src/tools/shell.ts`

A single general-purpose tool for arbitrary ADB shell commands:

```typescript
server.registerTool("shell_exec", {
  title: "Execute Shell Command",
  description: "Execute an arbitrary ADB shell command on the device and return the output. Use this for any device operation not covered by other tools.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute on the device"),
    serial: z.string().optional(),
  }),
}, async ({ command, serial }) => {
  const s = await resolveSerial(serial);
  const output = await execAdbShell(s, command);
  return {
    content: [{ type: "text", text: output }],
  };
});
```

This is the "escape hatch" — if no specialized tool exists, the AI can always fall back to raw shell commands.

### 7.11 File Transfer Tools — `src/tools/files.ts`

#### ADB commands used

| Tool | ADB Command |
|------|-------------|
| `file_push` | `adb -s <serial> push <localPath> <remotePath>` |
| `file_pull` | `adb -s <serial> pull <remotePath> <localPath>` |
| `file_list` | `adb -s <serial> shell ls -la <path>` |

#### `file_list` output parsing

The `ls -la` output is parsed into structured JSON:

```typescript
interface FileEntry {
  permissions: string;  // e.g., "drwxrwx--x"
  owner: string;
  group: string;
  size: number;
  date: string;
  name: string;
  isDirectory: boolean;
}
```

### 7.12 Clipboard Tools — `src/tools/clipboard.ts`

#### scrcpy path (preferred)

When a scrcpy session is active, clipboard operations use the scrcpy protocol:
- **Set clipboard:** Sends `SET_CLIPBOARD` control message with `paste=true` to also paste the text
- **Get clipboard:** Reads the latest `CLIPBOARD` device message from scrcpy-server (scrcpy-server sends clipboard content whenever it changes on device, and the session caches the latest value)

This **bypasses Android 10+ clipboard restrictions** that block `adb shell` clipboard access.

#### ADB fallback

| Tool | ADB Command |
|------|-------------|
| `clipboard_get` | `adb shell cmd clipboard get` (Android 12+), fallback: `adb shell service call clipboard 2` |
| `clipboard_set` | `adb shell cmd clipboard set "<text>"` (Android 10+), fallback: `adb shell am broadcast -a clipper.set -e text "<text>"` |

> **Note:** ADB clipboard access is unreliable on Android 10+. The scrcpy path is strongly preferred — start a session for reliable clipboard operations.

---

## 8. Configuration Files

### `package.json`

```json
{
  "name": "scrcpy-mcp",
  "version": "0.1.0",
  "description": "MCP server for Android device control via ADB and scrcpy — gives AI agents vision and control over Android devices",
  "keywords": [
    "mcp",
    "mcp-server",
    "android",
    "adb",
    "scrcpy",
    "model-context-protocol",
    "ai",
    "automation",
    "mobile",
    "screen-control"
  ],
  "author": "Your Name",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/YOUR_USERNAME/scrcpy-mcp"
  },
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "scrcpy-mcp": "dist/index.js"
  },
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "inspect": "npx @modelcontextprotocol/inspector node dist/index.js",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^1.0.0",
    "zod": "^3.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsup": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### `tsup.config.ts`

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
```

### `.gitignore`

```
node_modules/
dist/
*.tgz
.env
```

### `.mcp.json` (for OpenCode / Claude Code)

```json
{
  "mcpServers": {
    "scrcpy-mcp": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "ADB_PATH": "adb"
      }
    }
  }
}
```

---

## 9. Publishing & Distribution

### npm publishing

The package will be published to npm so users can install and run it with:

```bash
# Global install
npm install -g scrcpy-mcp

# Or run directly with npx (no install needed)
npx scrcpy-mcp
```

#### Steps to publish

1. Create an npm account at https://www.npmjs.com/signup
2. Login locally: `npm login`
3. Ensure `package.json` has correct `name`, `version`, `description`, `repository`, `license`
4. Build: `npm run build`
5. Test locally: `npx @modelcontextprotocol/inspector node dist/index.js`
6. Publish: `npm publish`
7. For updates: bump version in `package.json`, then `npm publish`

#### npm package contents

The `"files"` field in `package.json` ensures only the `dist/` folder is published (not source code). The package will be small (<50KB).

### GitHub repository setup

1. Create repository on GitHub
2. Add topics: `mcp`, `mcp-server`, `android`, `adb`, `scrcpy`, `model-context-protocol`
3. Create a proper README.md (see Section 10 for what clients need)
4. Add MIT LICENSE file
5. Optional: Add GitHub Actions CI for automated builds and npm publishing on tag


### MCP Registry (GitHub)

GitHub now has an [MCP Registry](https://github.com/mcp). Consider registering the server there for discoverability.

---

## 10. MCP Client Integration

### OpenCode

Add to your project's `.mcp.json` or global config:

```json
{
  "mcpServers": {
    "android": {
      "command": "npx",
      "args": ["scrcpy-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add android -- npx scrcpy-mcp
```

Or add to `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "android": {
      "command": "npx",
      "args": ["scrcpy-mcp"]
    }
  }
}
```

### Cursor

Settings > MCP > Add Server:

```json
{
  "android": {
    "command": "npx",
    "args": ["scrcpy-mcp"]
  }
}
```

### Claude Desktop

Edit `~/.config/Claude/claude_desktop_config.json` (Linux) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "android": {
      "command": "npx",
      "args": ["scrcpy-mcp"],
      "env": {
        "ADB_PATH": "adb"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "android": {
      "command": "npx",
      "args": ["scrcpy-mcp"]
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADB_PATH` | `"adb"` | Path to ADB binary |
| `ANDROID_SERIAL` | (none) | Default device serial (overrides auto-detection) |
| `SCRCPY_SERVER_PATH` | (auto-detect) | Path to scrcpy-server binary (extracted from scrcpy installation) |
| `SCRCPY_SERVER_VERSION` | (auto-detect) | Version of scrcpy-server (must match the binary exactly) |
| `FFMPEG_PATH` | `"ffmpeg"` | Path to ffmpeg binary (for video stream decoding) |
| `SCREENSHOT_MAX_WIDTH` | `1024` | Maximum screenshot dimension in pixels |
| `AUTO_START_SESSION` | `"false"` | If `"true"`, auto-start scrcpy session on first tool call |

---

## 11. Testing Strategy

### Manual testing with MCP Inspector

The MCP Inspector is a browser-based tool that connects to your server and lets you interactively test every tool:

```bash
# Build first
npm run build

# Launch inspector (opens browser)
npx @modelcontextprotocol/inspector node dist/index.js
```

In the inspector, you can:
- See all registered tools and their schemas
- Call tools with custom parameters
- View the returned content (text, images)
- Debug errors

### Test checklist

Before publishing, verify each tool works:

- [ ] `device_list` — with 0, 1, and 2+ devices connected
- [ ] `device_info` — returns correct model, version, screen size
- [ ] `screenshot` — returns a valid PNG image
- [ ] `tap` — taps the correct screen location
- [ ] `swipe` — swipe gesture works
- [ ] `input_text` — types text including special characters
- [ ] `key_event` — HOME, BACK, ENTER all work
- [ ] `app_list` — lists packages correctly
- [ ] `app_start` — launches an app
- [ ] `app_stop` — force-stops an app
- [ ] `app_current` — shows correct foreground activity
- [ ] `ui_dump` — returns valid XML
- [ ] `ui_find_element` — finds elements and returns correct coordinates
- [ ] `shell_exec` — arbitrary commands work
- [ ] `file_push` / `file_pull` — file transfer works
- [ ] `clipboard_set` / `clipboard_get` — clipboard works (Android 10+ tested)
- [ ] Error handling: no device connected, invalid serial, invalid coordinates

### Automated testing (future)

For CI, you could use an Android emulator:

```bash
# Start emulator
emulator -avd test_device -no-window -no-audio &
adb wait-for-device

# Run tests
npm test
```

---

## 12. Implementation Order

The implementation will proceed in phases, with each phase producing a working server:

### Phase 1: Foundation + ADB Fallback (get a working MCP server)

| Step | Task | Files |
|------|------|-------|
| 1 | Initialize project (`npm init`, install deps, create tsconfig, tsup config) | `package.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore` |
| 2 | Implement ADB utility layer | `src/utils/adb.ts` |
| 3 | Implement entry point | `src/index.ts` |
| 4 | Implement `device_list` and `device_info` | `src/tools/device.ts` |
| 5 | Implement `screenshot` (ADB fallback only for now) | `src/tools/vision.ts` |
| 6 | Implement input tools (ADB fallback only for now) | `src/tools/input.ts` |
| 7 | **Build and test** — verify MCP Inspector shows tools, screenshots work | — |

**Milestone: Working MCP server with ADB-based device listing, screenshots, and input.**

### Phase 2: scrcpy Integration (The core differentiator)

| Step | Task | Files |
|------|------|-------|
| 8 | Implement scrcpy utility layer: server push, launch, port forwarding | `src/utils/scrcpy.ts` |
| 9 | Implement control socket: binary protocol for input injection | `src/utils/scrcpy.ts` |
| 10 | Implement video stream: ffmpeg decode to frame buffer | `src/utils/scrcpy.ts` |
| 11 | Implement clipboard sync via scrcpy protocol | `src/utils/scrcpy.ts` |
| 12 | Implement `start_session` / `stop_session` tools | `src/tools/session.ts` |
| 13 | Wire scrcpy fast path into input, vision, and clipboard tools | `src/tools/input.ts`, `vision.ts`, `clipboard.ts` |
| 14 | **Test**: start session → screenshot (fast) → tap (fast) → screenshot | — |

**Milestone: scrcpy-first control working. Input is 10-50x faster, screenshots near-instant.**

### Phase 3: App Management & UI Automation

| Step | Task | Files |
|------|------|-------|
| 15 | Implement app tools | `src/tools/apps.ts` |
| 16 | Implement `ui_dump` and `ui_find_element` | `src/tools/ui.ts` |
| 17 | Test: start session → launch app → find element → tap → verify | — |

**Milestone: AI can launch apps, find UI elements by text/id, and interact with them.**

### Phase 4: Remaining Tools

| Step | Task | Files |
|------|------|-------|
| 18 | Implement `shell_exec` | `src/tools/shell.ts` |
| 19 | Implement file tools | `src/tools/files.ts` |
| 20 | Implement clipboard tools (with scrcpy fast path) | `src/tools/clipboard.ts` |
| 21 | Implement remaining device tools (screen_on/off, wifi) | `src/tools/device.ts` |
| 22 | Implement screen recording tools | `src/tools/vision.ts` |

**Milestone: All 34 tools implemented.**

### Phase 5: Polish & Publish

| Step | Task | Files |
|------|------|-------|
| 23 | Comprehensive testing of scrcpy + ADB fallback paths | — |
| 24 | Write README.md with full usage guide and tool reference | `README.md` |
| 25 | Add LICENSE | `LICENSE` |
| 26 | Git init, create GitHub repo, push | — |
| 27 | Publish to npm | — |

**Milestone: Published on npm, installable via `npx scrcpy-mcp`.**

---

## 13. Security Considerations

This MCP server provides **full control** over connected Android devices. Users must understand:

### Risks

- `shell_exec` allows **arbitrary command execution** on the device
- `file_push` / `file_pull` can read/write **any file** accessible to the shell user
- `app_install` can install **any APK**
- The AI agent has full control over touch input, keyboard, and system settings

### Mitigations

1. **Local-only by default** — stdio transport means the server only runs locally, not over a network
2. **User-initiated** — the user must explicitly configure and start the server
3. **MCP client confirmation** — most MCP clients (Claude Code, OpenCode) show the user what tool the AI wants to call and ask for confirmation before executing
4. **ADB authorization** — the device must have USB debugging enabled and the host's RSA key must be accepted
5. **Documentation** — the README will clearly state: "Only connect devices you own and trust the AI agent"

### Future: tool-level permissions

Consider adding an optional allowlist/blocklist in configuration:

```json
{
  "allowedTools": ["screenshot", "tap", "swipe", "input_text", "key_event", "device_list"],
  "blockedTools": ["shell_exec", "file_push", "app_install"]
}
```

This would let users restrict what the AI can do.

---

## 14. Existing Alternatives & Differentiation

| Project | Stars | Language | Approach | Our differentiation |
|---------|-------|----------|----------|-------------------|
| [mobile-mcp](https://github.com/mobile-next/mobile-mcp) | 3,400+ | TypeScript | iOS + Android via custom protocol | We focus specifically on scrcpy/ADB. Simpler setup, no custom agent needed. |
| [android-mcp-server](https://github.com/minhalvp/android-mcp-server) | 660+ | Python | ADB only | We're in TypeScript (faster startup), include scrcpy integration, and plan npm distribution. |
| [adb-mcp](https://github.com/srmorete/adb-mcp) | 33 | TypeScript | ADB basic | We have more tools (29 vs ~10), UI element finding, image return for screenshots. |
| [mcp-scrcpy-vision](https://github.com/invidtiv/mcp-scrcpy-vision) | 7 | TypeScript | scrcpy streaming + ADB | Similar scope. We aim for simpler setup (scrcpy optional, not required) and better docs. |

### Our advantages

1. **scrcpy-first architecture** — uses scrcpy's binary control protocol for 10-50x faster input and near-instant screenshots, with ADB as automatic fallback
2. **npm publishable** — `npx scrcpy-mcp` just works, no cloning repos
3. **Comprehensive tool set** — 34 tools (15 scrcpy-native, 13 ADB-only, 6 with dual path) covering session, vision, input, apps, UI, shell, files, clipboard, device panels
4. **Image-returning screenshots** — the `screenshot` tool returns actual image content the AI can see (not just a file path)
5. **Smart device selection** — auto-selects when one device is connected, clear errors otherwise
6. **UI element finding** — `ui_find_element` returns tap coordinates, bridging the gap between "I see a button" and "tap at x,y"
7. **Clipboard that actually works** — scrcpy clipboard sync bypasses Android 10+ restrictions that break ADB-only solutions
8. **Graceful degradation** — every tool works without scrcpy (ADB fallback), so users can start simple and upgrade to scrcpy for performance

---

## 15. Prerequisites for Users

### Required

| Requirement | How to install | Verification |
|-------------|---------------|-------------|
| **Node.js 18+** | https://nodejs.org or `nvm install 18` | `node --version` |
| **ADB** (Android Platform Tools) | https://developer.android.com/tools/releases/platform-tools | `adb version` |
| **Android device** with USB debugging | Settings > Developer Options > USB Debugging | `adb devices` shows the device |

### Optional (for enhanced performance)

| Requirement | How to install | Benefit |
|-------------|---------------|---------|
| **scrcpy** | https://github.com/Genymobile/scrcpy/releases | Faster screenshots via streaming |
| **ffmpeg** | `apt install ffmpeg` / `brew install ffmpeg` | Required for scrcpy streaming decode |

### Device setup

1. Enable Developer Options: Settings > About Phone > tap "Build Number" 7 times
2. Enable USB Debugging: Settings > Developer Options > USB Debugging
3. Connect device via USB
4. Accept RSA fingerprint prompt on device when first connecting
5. Verify: `adb devices` should show your device as "device" (not "unauthorized")

---

## Summary

This plan produces a **34-tool MCP server** built on top of **scrcpy's binary control protocol** for near-instant input injection, screenshots, clipboard sync, panel control, app launching, and screen management — with automatic ADB fallback when scrcpy is not available. 15 of the 34 tools use scrcpy's native protocol, 13 use ADB for things scrcpy doesn't handle, and 6 have both paths. The implementation is split into 5 phases, with ADB-based functionality working after Phase 1, and the full scrcpy-first fast path after Phase 2. The package will be published to npm for easy `npx scrcpy-mcp` usage by the wider developer community.

**Estimated implementation time:** 6-8 hours for all phases (scrcpy binary protocol adds complexity).
**Estimated package size:** <50KB (bundled).
**Lines of code:** ~1,800 lines of TypeScript.
