# Implementation Roadmap

This document breaks down the implementation of scrcpy-mcp into detailed phases and sub-steps.

---

## Phase 1: Foundation + ADB Fallback

Get a working MCP server with ADB-based functionality first. This provides immediate value while scrcpy integration is built.

### 1.1 Project Initialization

- [x] 1.1.1 Initialize npm project with `npm init -y`
- [x] 1.1.2 Install production dependencies: `@modelcontextprotocol/server`, `zod`
- [x] 1.1.3 Install dev dependencies: `typescript`, `@types/node`, `tsup`, `tsx`
- [x] 1.1.4 Create `tsconfig.json` with ES2022, Node16 module resolution
- [x] 1.1.5 Create `tsup.config.ts` for bundling to single ESM file
- [x] 1.1.6 Create `.gitignore` for node_modules, dist, .env
- [x] 1.1.7 Update `package.json` with scripts, bin entry, engines field

### 1.2 ADB Utility Layer (`src/utils/adb.ts`)

- [x] 1.2.1 Create `execAdb()` function - spawn adb with args, return stdout/stderr
- [x] 1.2.2 Create `execAdbShell()` wrapper for `adb -s <serial> shell <command>`
- [x] 1.2.3 Create `execAdbRaw()` for binary output (screenshots)
- [x] 1.2.4 Create `resolveSerial()` - auto-detect single device, error on multiple
- [x] 1.2.5 Create `getDevices()` - parse `adb devices -l` output
- [x] 1.2.6 Create `getScreenSize()` - parse `adb shell wm size`
- [x] 1.2.7 Add environment variable support: `ADB_PATH`, `ANDROID_SERIAL`

### 1.3 Entry Point (`src/index.ts`)

- [x] 1.3.1 Import McpServer and StdioServerTransport from SDK
- [x] 1.3.2 Create server instance with name and version
- [x] 1.3.3 Import and register tool modules (initially just device tools)
- [x] 1.3.4 Connect StdioServerTransport and start server
- [x] 1.3.5 Add error handling and stderr logging

### 1.4 Device Tools - ADB Fallback (`src/tools/device.ts`)

- [x] 1.4.1 Implement `device_list` - list connected devices
- [x] 1.4.2 Implement `device_info` - get model, version, screen size, battery
- [x] 1.4.3 Implement `screen_on` - ADB `input keyevent KEYCODE_WAKEUP`
- [x] 1.4.4 Implement `screen_off` - ADB `input keyevent KEYCODE_SLEEP`
- [x] 1.4.5 Implement `connect_wifi` - enable TCP/IP and connect
- [x] 1.4.6 Implement `disconnect_wifi` - disconnect wireless ADB
- [x] 1.4.7 Note: expand_notifications, expand_settings, collapse_panels, rotate_device will use scrcpy in Phase 2

### 1.5 Vision Tools - ADB Fallback (`src/tools/vision.ts`)

- [x] 1.5.1 Implement `screenshot` - ADB `exec-out screencap -p`, return base64 image
- [x] 1.5.2 Implement `screen_record_start` - spawn `screenrecord` in background
- [x] 1.5.3 Implement `screen_record_stop` - kill screenrecord process

### 1.6 Input Tools - ADB Fallback (`src/tools/input.ts`)

- [x] 1.6.1 Implement `tap` - ADB `input tap x y`
- [x] 1.6.2 Implement `swipe` - ADB `input swipe x1 y1 x2 y2 duration`
- [x] 1.6.3 Implement `long_press` - ADB `input swipe x y x y duration`
- [x] 1.6.4 Implement `drag_drop` - ADB `input draganddrop`
- [x] 1.6.5 Implement `input_text` - ADB `input text` with shell escaping
- [x] 1.6.6 Implement `key_event` - ADB `input keyevent` with keycode map
- [x] 1.6.7 Implement `scroll` - ADB `input swipe` with small delta (fallback only)

### 1.7 Build and Test

- [x] 1.7.1 Run `npm run build` to compile TypeScript
- [x] 1.7.2 Test with MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`
- [x] 1.7.3 Verify `device_list` works
- [x] 1.7.4 Verify `screenshot` returns valid image
- [x] 1.7.5 Verify `tap` works on connected device

**Phase 1 Milestone:** Working MCP server with ADB-based device listing, screenshots, and input.

---

## Phase 2: scrcpy Integration

Implement the core scrcpy protocol for 10-50x faster performance. This is the main differentiator.

### 2.1 scrcpy Utility Layer Foundation (`src/utils/scrcpy.ts`)

- [x] 2.1.1 Define `ScrcpySession` class with properties: serial, controlSocket, videoProcess, frameBuffer, screenSize
- [x] 2.1.2 Implement `findScrcpyServer()` - locate scrcpy-server binary (SCRCPY_SERVER_PATH or auto-detect)
- [x] 2.1.3 Implement `pushScrcpyServer(serial)` - adb push scrcpy-server.jar to device
- [x] 2.1.4 Implement `setupPortForwarding(serial, port)` - adb forward tcp:port localabstract:scrcpy
- [x] 2.1.5 Implement `startScrcpyServer(serial, options)` - adb shell CLASSPATH... app_process

### 2.2 scrcpy Control Protocol

- [x] 2.2.1 Define control message type constants (INJECT_KEYCODE=0, INJECT_TEXT=1, etc.)
- [x] 2.2.2 Implement `serializeInjectKeycode(action, keycode, repeat, metaState)` - 14 bytes
- [x] 2.2.3 Implement `serializeInjectText(text)` - 5+len bytes, max 300 chars
- [x] 2.2.4 Implement `serializeInjectTouchEvent(action, pointerId, x, y, width, height, pressure, buttons)` - 32 bytes
- [x] 2.2.5 Implement `serializeInjectScrollEvent(x, y, width, height, hscroll, vscroll, buttons)` - 21 bytes
- [x] 2.2.6 Implement `serializeSetClipboard(sequence, paste, text)` - 14+len bytes
- [x] 2.2.7 Implement `serializeSimpleMessage(type)` - for EXPAND_NOTIFICATION_PANEL, COLLAPSE_PANELS, etc.

### 2.3 scrcpy Video Stream

- [ ] 2.3.1 Implement `startVideoStream(session)` - spawn ffmpeg to decode H.264
- [ ] 2.3.2 Handle video socket data and pipe to ffmpeg stdin
- [ ] 2.3.3 Capture decoded frames from ffmpeg stdout
- [ ] 2.3.4 Store latest frame in session.frameBuffer
- [ ] 2.3.5 Implement `getLatestFrame()` method

### 2.4 scrcpy Session Management

- [ ] 2.4.1 Implement `startSession(serial, options)` - full lifecycle: push, forward, start server, connect sockets
- [ ] 2.4.2 Implement `stopSession(serial)` - cleanup: close sockets, kill processes, remove forwarding
- [ ] 2.4.3 Implement `getSession(serial)` - retrieve active session
- [ ] 2.4.4 Implement `hasActiveSession(serial)` - check if session exists and is connected
- [ ] 2.4.5 Handle device messages (CLIPBOARD) from server

### 2.5 Session Tools (`src/tools/session.ts`)

- [ ] 2.5.1 Implement `start_session` - start scrcpy session with options (maxSize, maxFps)
- [ ] 2.5.2 Implement `stop_session` - stop scrcpy session
- [ ] 2.5.3 Update entry point to register session tools

### 2.6 Wire scrcpy Fast Path - Input Tools

- [ ] 2.6.1 Update `tap` - use scrcpy INJECT_TOUCH_EVENT when session active
- [ ] 2.6.2 Update `swipe` - use scrcpy INJECT_TOUCH_EVENT with interpolation
- [ ] 2.6.3 Update `long_press` - use scrcpy INJECT_TOUCH_EVENT (DOWN, delay, UP)
- [ ] 2.6.4 Update `drag_drop` - use scrcpy INJECT_TOUCH_EVENT
- [ ] 2.6.5 Update `input_text` - use scrcpy INJECT_TEXT
- [ ] 2.6.6 Update `key_event` - use scrcpy INJECT_KEYCODE
- [ ] 2.6.7 Update `scroll` - use scrcpy INJECT_SCROLL_EVENT

### 2.7 Wire scrcpy Fast Path - Vision Tools

- [ ] 2.7.1 Update `screenshot` - use scrcpy frame buffer when session active (~33ms)
- [ ] 2.7.2 Keep ADB fallback for when no session (~500ms)

### 2.8 Wire scrcpy Fast Path - Device Tools

- [ ] 2.8.1 Implement `screen_on` - use scrcpy SET_DISPLAY_POWER (on=true)
- [ ] 2.8.2 Implement `screen_off` - use scrcpy SET_DISPLAY_POWER (on=false)
- [ ] 2.8.3 Implement `rotate_device` - use scrcpy ROTATE_DEVICE
- [ ] 2.8.4 Implement `expand_notifications` - use scrcpy EXPAND_NOTIFICATION_PANEL (scrcpy only, no ADB fallback)
- [ ] 2.8.5 Implement `expand_settings` - use scrcpy EXPAND_SETTINGS_PANEL (scrcpy only, no ADB fallback)
- [ ] 2.8.6 Implement `collapse_panels` - use scrcpy COLLAPSE_PANELS (scrcpy only, no ADB fallback)

### 2.9 Wire scrcpy Fast Path - Clipboard Tools

- [ ] 2.9.1 Implement `clipboard_get` - use scrcpy GET_CLIPBOARD + listen for device message
- [ ] 2.9.2 Implement `clipboard_set` - use scrcpy SET_CLIPBOARD with optional paste flag

### 2.10 Wire scrcpy Fast Path - App Tools

- [ ] 2.10.1 Update `app_start` - use scrcpy START_APP when session active
- [ ] 2.10.2 Support force-stop prefix (+) via scrcpy

### 2.11 Testing

- [ ] 2.11.1 Test scrcpy session start/stop
- [ ] 2.11.2 Test screenshot speed: compare scrcpy (~33ms) vs ADB (~500ms)
- [ ] 2.11.3 Test input speed: compare scrcpy (~5-10ms) vs ADB (~100-300ms)
- [ ] 2.11.4 Test clipboard on Android 10+ (should work with scrcpy, fail with ADB)
- [ ] 2.11.5 Test expand_notifications (only works with scrcpy)

**Phase 2 Milestone:** scrcpy-first control working. Input is 10-50x faster, screenshots near-instant, clipboard works on Android 10+.

---

## Phase 3: App Management & UI Automation

Implement remaining tools that require ADB (scrcpy doesn't provide these).

### 3.1 App Management Tools (`src/tools/apps.ts`)

- [ ] 3.1.1 Implement `app_start` - ADB `am start` (already done in 2.10, ensure fallback works)
- [ ] 3.1.2 Implement `app_stop` - ADB `am force-stop`
- [ ] 3.1.3 Implement `app_install` - ADB `install -r`
- [ ] 3.1.4 Implement `app_uninstall` - ADB `uninstall`
- [ ] 3.1.5 Implement `app_list` - ADB `pm list packages` with filtering
- [ ] 3.1.6 Implement `app_current` - parse `dumpsys activity activities`

### 3.2 UI Automation Tools (`src/tools/ui.ts`)

- [ ] 3.2.1 Implement `ui_dump` - ADB `uiautomator dump /dev/tty`
- [ ] 3.2.2 Parse XML output into structured format
- [ ] 3.2.3 Implement `ui_find_element` - search by text, resourceId, className, contentDesc
- [ ] 3.2.4 Parse bounds attribute to compute center tap coordinates
- [ ] 3.2.5 Return array of matches with tap coordinates

### 3.3 Testing

- [ ] 3.3.1 Test: start session → launch app → find element → tap → verify
- [ ] 3.3.2 Test app install/uninstall
- [ ] 3.3.3 Test UI hierarchy dump

**Phase 3 Milestone:** AI can launch apps, find UI elements by text/id, and interact with them.

---

## Phase 4: Remaining Tools

Complete the tool set with shell, file, and remaining device tools.

### 4.1 Shell Tools (`src/tools/shell.ts`)

- [ ] 4.1.1 Implement `shell_exec` - arbitrary ADB shell command execution

### 4.2 File Transfer Tools (`src/tools/files.ts`)

- [ ] 4.2.1 Implement `file_push` - ADB `push`
- [ ] 4.2.2 Implement `file_pull` - ADB `pull`
- [ ] 4.2.3 Implement `file_list` - ADB `ls -la` with parsing

### 4.3 Screen Recording Tools (update `src/tools/vision.ts`)

- [ ] 4.3.1 Ensure `screen_record_start` works via ADB `screenrecord`
- [ ] 4.3.2 Ensure `screen_record_stop` properly terminates recording

### 4.4 Testing

- [ ] 4.4.1 Test shell_exec with various commands
- [ ] 4.4.2 Test file push/pull
- [ ] 4.4.3 Test screen recording

**Phase 4 Milestone:** All 34 tools implemented.

---

## Phase 5: Polish & Publish

Prepare for distribution.

### 5.1 Documentation

- [ ] 5.1.1 Write comprehensive README.md with:
  - Installation instructions
  - Prerequisites (ADB, optional scrcpy/ffmpeg)
  - MCP client configuration examples (OpenCode, Claude Code, Cursor, etc.)
  - Tool reference with examples
  - Performance comparison (scrcpy vs ADB)
  - Troubleshooting guide
- [ ] 5.1.2 Add MIT LICENSE file

### 5.2 Git Repository

- [ ] 5.2.1 Initialize git repository
- [ ] 5.2.2 Create initial commit
- [ ] 5.2.3 Create GitHub repository
- [ ] 5.2.4 Push to GitHub
- [ ] 5.2.5 Add topics: mcp, mcp-server, android, adb, scrcpy

### 5.3 Build Verification

- [ ] 5.3.1 Run full build: `npm run build`
- [ ] 5.3.2 Verify dist/ output
- [ ] 5.3.3 Test with MCP Inspector - all 34 tools
- [ ] 5.3.4 Test on real Android device
- [ ] 5.3.5 Test both scrcpy path and ADB fallback

### 5.4 npm Publishing

- [ ] 5.4.1 Create npm account if needed
- [ ] 5.4.2 Login: `npm login`
- [ ] 5.4.3 Verify package.json is correct
- [ ] 5.4.4 Publish: `npm publish`
- [ ] 5.4.5 Test installation: `npx scrcpy-mcp`

### 5.5 Optional: Smithery Listing

- [ ] 5.5.1 Create smithery.yaml
- [ ] 5.5.2 Submit to smithery.ai

**Phase 5 Milestone:** Published on npm, installable via `npx scrcpy-mcp`.

---

## Phase 6: Future Features (Post-Release)

Features to consider after initial release based on user feedback.

### 6.1 Live Video Streaming

Enable watching the device screen in real-time while MCP controls it.

- [ ] 6.1.1 Implement `start_video_stream` tool - connect to scrcpy video socket
- [ ] 6.1.2 Pipe H.264 stream to ffmpeg for decoding
- [ ] 6.1.3 Option A: Launch ffplay window for local viewing
- [ ] 6.1.4 Option B: HTTP MJPEG server for browser-based viewer
- [ ] 6.1.5 Option C: WebSocket streaming for integration with other tools
- [ ] 6.1.6 Allow simultaneous control + viewing (video socket is separate from control socket)

**Use cases:**
- Debug automation visually while it runs
- Live demos of AI-controlled device interactions
- Integration with existing scrcpy GUI (`scrcpy --serial <device>` alongside MCP)

**Technical notes:**
- Video socket sends raw H.264 (needs decoding unlike screenshots)
- Can run alongside existing control socket connection
- Alternative: Users can run scrcpy GUI separately on same forwarded port

---

## Summary

| Phase | Steps | Focus | Deliverable |
|-------|-------|-------|-------------|
| 1 | 1.1 - 1.7 | Foundation + ADB fallback | Working MCP server with ADB tools |
| 2 | 2.1 - 2.11 | scrcpy integration | 10-50x faster input, instant screenshots |
| 3 | 3.1 - 3.3 | App + UI tools | Complete app management and UI automation |
| 4 | 4.1 - 4.4 | Remaining tools | Shell, files, recording |
| 5 | 5.1 - 5.5 | Polish & publish | npm package, README, GitHub repo |

**Total steps:** 80+ individual tasks
**Estimated time:** 6-8 hours of focused work
**Final deliverable:** 34-tool MCP server published to npm
