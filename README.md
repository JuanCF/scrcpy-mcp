# scrcpy-mcp

MCP server that gives AI agents full vision and control over Android devices via ADB and scrcpy.

Connect any MCP-compatible AI assistant (Claude Code, OpenCode, Cursor, VS Code Copilot, etc.) to your Android device. The AI can see the screen, tap, swipe, type, launch apps, inspect UI elements, transfer files, and run shell commands.

## Features

- **34 tools** covering screenshots, input, apps, UI automation, shell, files, and clipboard
- **scrcpy-first**: uses scrcpy's binary control protocol for 10-50x faster input and near-instant screenshots (~33ms)
- **ADB fallback**: every tool works without scrcpy — slower but always available
- **Image-returning screenshots**: the AI actually sees the screen, not just a file path
- **UI element finding**: `ui_find_element` returns tap coordinates so the AI can act on what it sees
- **Clipboard that works on Android 10+**: scrcpy bypasses the restrictions that break ADB-only solutions

## Prerequisites

### Required

| Requirement | Install | Verify |
|-------------|---------|--------|
| **Node.js 22+** | [nodejs.org](https://nodejs.org) or `nvm install` (uses [`.node_version`](.node_version)) | `node --version` |
| **ADB** (Android Platform Tools) | [developer.android.com/tools/releases/platform-tools](https://developer.android.com/tools/releases/platform-tools) | `adb version` |
| **Android device** with USB debugging | Settings → Developer Options → USB Debugging | `adb devices` |

### Optional (for enhanced performance)

| Requirement | Install | Benefit |
|-------------|---------|---------|
| **scrcpy** | [github.com/Genymobile/scrcpy](https://github.com/Genymobile/scrcpy/releases) | 10-50x faster input, ~33ms screenshots |
| **ffmpeg** | `apt install ffmpeg` / `brew install ffmpeg` | Required for scrcpy video stream decoding |

### Device setup

1. Enable Developer Options: **Settings → About Phone → tap "Build Number" 7 times**
2. Enable USB Debugging: **Settings → Developer Options → USB Debugging**
3. Connect device via USB
4. Accept the RSA fingerprint prompt on the device
5. Verify: `adb devices` should show your device as `device` (not `unauthorized`)

## Installation

```bash
# Run directly with npx (no install needed)
npx scrcpy-mcp

# Or install globally
npm install -g scrcpy-mcp
```

## MCP Client Configuration

### Claude Code

```bash
claude mcp add android -- npx scrcpy-mcp
```

Or add to `.mcp.json` in your project root:

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

### OpenCode

Add to `.mcp.json`:

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

Settings → MCP → Add Server:

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
      "args": ["scrcpy-mcp"]
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

## Tool Reference

### Session Management

| Tool | Description |
|------|-------------|
| `start_session` | Start a scrcpy session. When active, input and screenshots use the fast path (10-50x faster). |
| `stop_session` | Stop the scrcpy session. Tools fall back to ADB. |

### Device Management

| Tool | Description |
|------|-------------|
| `device_list` | List all connected devices with serial, state, and model |
| `device_info` | Get model, Android version, screen size, SDK level, battery |
| `screen_on` | Wake the device screen |
| `screen_off` | Turn the screen off |
| `rotate_device` | Rotate the screen (requires active session) |
| `expand_notifications` | Pull down the notification panel (requires active session) |
| `expand_settings` | Pull down the quick settings panel (requires active session) |
| `collapse_panels` | Collapse notification/settings panels (requires active session) |

### Vision

| Tool | Description |
|------|-------------|
| `screenshot` | Capture the screen and return it as an image. ~33ms with scrcpy, ~500ms via ADB. |
| `screen_record_start` | Start recording the screen to a file on the device |
| `screen_record_stop` | Stop recording and optionally pull the file to the host |

### Input Control

All input tools use scrcpy (~5-10ms) when a session is active, otherwise fall back to ADB (~100-300ms).

| Tool | Description |
|------|-------------|
| `tap` | Tap at screen coordinates |
| `swipe` | Swipe from one point to another |
| `long_press` | Long press at coordinates |
| `drag_drop` | Drag from one point to another |
| `input_text` | Type a text string into the focused field |
| `key_event` | Send a key event: HOME, BACK, ENTER, VOLUME_UP, VOLUME_DOWN, POWER, etc. |
| `scroll` | Scroll at a position (dx=horizontal, dy=vertical) |

### App Management

| Tool | Description |
|------|-------------|
| `app_start` | Launch an app by package name. Prefix with `+` to force-stop before launch. |
| `app_stop` | Force-stop an app |
| `app_install` | Install an APK from the host machine |
| `app_uninstall` | Uninstall an app |
| `app_list` | List installed packages, optionally filter by name or system/third-party |
| `app_current` | Get the current foreground app and activity |

### UI Automation

| Tool | Description |
|------|-------------|
| `ui_dump` | Dump the full UI hierarchy as XML |
| `ui_find_element` | Find elements by text, resource ID, class name, or content description. Returns tap coordinates. |

### Shell & Files

| Tool | Description |
|------|-------------|
| `shell_exec` | Execute an arbitrary ADB shell command and return the output |
| `file_push` | Push a file from the host machine to the device |
| `file_pull` | Pull a file from the device to the host machine |
| `file_list` | List directory contents on the device |

### Clipboard

| Tool | Description |
|------|-------------|
| `clipboard_get` | Get clipboard content. Uses scrcpy to bypass Android 10+ restrictions. |
| `clipboard_set` | Set clipboard content. Pass `paste: true` to also paste immediately. |

## Performance

| Operation | scrcpy (session active) | ADB fallback |
|-----------|------------------------|--------------|
| Screenshot | ~33ms | ~500ms |
| Tap / Swipe | ~5-10ms | ~100-300ms |
| Text input | ~5ms | ~100-300ms |
| Clipboard | ~10ms | unreliable on Android 10+ |

Start a session once at the beginning to unlock the fast path:

```
start_session → take screenshots → tap → swipe → ...
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADB_PATH` | `adb` | Path to the ADB binary |
| `ANDROID_SERIAL` | (none) | Default device serial, overrides auto-detection |
| `SCRCPY_SERVER_PATH` | (auto) | Path to the scrcpy-server binary |
| `SCRCPY_SERVER_VERSION` | (auto) | Version of the scrcpy-server binary |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary |

When only one device is connected, tools auto-detect it. With multiple devices, pass the `serial` parameter explicitly or set `ANDROID_SERIAL`.

## Troubleshooting

**`adb devices` shows `unauthorized`**
Accept the RSA fingerprint prompt on the device. If the prompt doesn't appear, revoke USB debugging authorizations in Developer Options and reconnect.

**`start_session` fails**
Make sure scrcpy is installed and the `scrcpy-server` binary is accessible. Set `SCRCPY_SERVER_PATH` if it's in a non-standard location.

**Screenshots are slow (~500ms)**
Start a scrcpy session with `start_session` to enable the fast video stream path. Requires scrcpy and ffmpeg.

**`expand_notifications` / `expand_settings` / `collapse_panels` fail**
These tools require an active scrcpy session. Run `start_session` first.

**Clipboard doesn't work on Android 10+**
ADB clipboard access is restricted on Android 10+. Start a scrcpy session — the scrcpy clipboard protocol bypasses this restriction.

**Multiple devices connected**
Pass `serial` to each tool or set the `ANDROID_SERIAL` environment variable.

## Security

This server provides full control over connected Android devices. The `shell_exec` tool can run arbitrary commands, and `file_push`/`file_pull` can read and write any file accessible to the shell user.

- The server runs locally over stdio — it is not exposed to the network
- ADB requires USB debugging to be explicitly enabled on the device
- The device must accept your host's RSA key on first connection
- Only connect devices you own and trust the AI agent you are using

## License

MIT — see [LICENSE](LICENSE)
