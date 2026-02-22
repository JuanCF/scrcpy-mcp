# Known Issues — scrcpy-mcp v3 upgrade

## Fixed Issues

### 1. Session timeout: "Timeout waiting for device metadata on port 27183"

**Root cause:** Three separate bugs combined to prevent session startup.

#### 1a. Forward tunnel phantom connections (primary cause)

In forward tunnel mode, `adb forward tcp:27183 localabstract:scrcpy_XXX` makes the
host port accept TCP connections **even when no scrcpy server is listening** behind
the tunnel. The retry loop would connect on the first attempt (to the empty tunnel),
treat it as the video socket, then connect again for control. Both connections were
orphaned. When the server finally created its `LocalServerSocket`, it blocked on
`accept()` waiting for connections that would never arrive.

**Fix:** After TCP connect, read the **dummy byte** that the server sends
(`send_dummy_byte=true`) to verify it is actually listening. Failed reads trigger a
retry. This mirrors the native scrcpy client behavior
(`connect_and_read_byte` in `app/src/server.c:466-483`).

*File: `src/utils/scrcpy.ts` — `connectAndVerify()`*

#### 1b. Socket accept ordering deadlock

The scrcpy server in forward mode calls `accept()` for **all** configured sockets
(video, then control) before sending any metadata. The MCP client connected the
video socket, then immediately tried to read device metadata — which would never
arrive because the server was blocking on `accept()` for the control socket.

**Fix:** Connect both sockets (video and control) before reading device metadata.

*File: `src/utils/scrcpy.ts` — `startSession()`*

#### 1c. Missing `scid` parameter

scrcpy v3 requires a `scid` (Session Connection ID) that determines the Unix
abstract socket name. The server creates `localabstract:scrcpy_XXXXXXXX`, but the
MCP was forwarding to `localabstract:scrcpy` (without scid). The tunnel pointed to
a non-existent socket.

**Fix:** Generate a random `scid`, pass it to both `adb forward` and the server
arguments.

*Files: `src/utils/scrcpy.ts` — `generateScid()`, `getSocketName()`,
`setupPortForwarding()`, `startScrcpyServer()`*

### 2. Wrong default server version

The fallback version string was `"2.7"`. When `scrcpy --version` detection fails,
the MCP passed `"2.7"` as the first argument to the server. The server (v3.3.4)
performs a strict equality check (`Options.java:298`) and immediately exits — before
opening any socket.

**Fix:** Updated default to `"3.3.4"`.

*File: `src/utils/constants.ts` — `SCRCPY_SERVER_VERSION`*

### 3. Wrong control message type constants

scrcpy v3 inserted `TYPE_BACK_OR_SCREEN_ON = 4` into the control message enum,
shifting every subsequent type:

| Constant               | v2 value | v3 value |
|------------------------|----------|----------|
| `SET_DISPLAY_POWER`    | 4        | 10       |
| `EXPAND_NOTIFICATION`  | 5        | 5        |
| `EXPAND_SETTINGS`      | 6        | 6        |
| `COLLAPSE_PANELS`      | 7        | 7        |
| `GET_CLIPBOARD`        | 8        | 8        |
| `SET_CLIPBOARD`        | 9        | 9        |
| `ROTATE_DEVICE`        | 10       | 11       |
| `START_APP`            | 16       | 16       |

Only `SET_DISPLAY_POWER` (4→10) and `ROTATE_DEVICE` (10→11) actually changed
values. The others kept the same numeric value because the new
`BACK_OR_SCREEN_ON = 4` pushed `SET_DISPLAY_POWER` from 4 to 10.

**Fix:** Updated all constants to match v3 enum values and added the missing types
(`UHID_CREATE`, `UHID_INPUT`, `UHID_DESTROY`, `OPEN_HARD_KEYBOARD_SETTINGS`,
`RESET_VIDEO`).

*File: `src/utils/constants.ts`*

### 4. Video stream not producing frames

The `startVideoStream` function pipes the video socket to ffmpeg, but:

- The `fps=30` video filter introduced latency that prevented frames from flushing.
- ffmpeg's default probing behavior waited for too much data before starting decode.
- Any bytes that arrived in the same TCP chunk as the device metadata (overflow) were
  silently discarded, potentially losing the h264 SPS/PPS and first keyframe.

**Fix:**
- Removed the `fps=30` filter.
- Added `-probesize 1024`, `-flags low_delay`, and `-flush_packets 1` to minimize
  buffering.
- `receiveDeviceMeta()` now returns overflow bytes, which are written to ffmpeg's
  stdin before piping the socket.

*File: `src/utils/scrcpy.ts` — `startVideoStream()`, `receiveDeviceMeta()`*

---

## Open Issues

### 5. Touch injection not working (INJECT_TOUCH_EVENT ignored by server)

**Status:** Not fixed. Text injection (`INJECT_TEXT`) and key events
(`INJECT_KEYCODE`) work correctly through the scrcpy control socket. Only touch
events are silently dropped.

**Observed behavior:** `scrcpy_tap` sends the correct binary message over the
control socket, but the device does not register any touch. Key presses and text
input sent over the same socket work fine, confirming the control channel is healthy.

**Binary layout:** The MCP serializes touch events as a 32-byte message matching the
scrcpy protocol:

```
Offset  Size  Field
  0       1   msg type (2 = INJECT_TOUCH_EVENT)
  1       1   action (0=DOWN, 1=UP)
  2       8   pointer ID (u64be)
 10       4   x (i32be)
 14       4   y (i32be)
 18       2   screen width (u16be)
 20       2   screen height (u16be)
 22       2   pressure (u16 fixed-point)
 24       4   action button (u32be)
 28       4   buttons (u32be)
```

This matches the scrcpy C client serialization (`app/src/control_msg.c:118-127`)
and the Java server parser (`ControlMessageReader.java:103-111`).

**Likely cause:** The server's `PositionMapper.map()` compares the `screenSize`
from the touch event against the server's `videoSize`. If they don't match,
the event is silently ignored
(`Controller.java:389-396`):

```java
point = displayData.positionMapper.map(position);
if (point == null) {
    // "Ignore positional event generated for size X (current size is Y)"
    return null;
}
```

The MCP sends `screenWidth=576, screenHeight=1024` (from `session.screenSize`,
which comes from the codec metadata header). The server's `videoSize` should also
be 576x1024, so this should match. Possible explanations for mismatch:

1. **Race condition:** The `PositionMapper` is set asynchronously via
   `onNewVirtualDisplay()` when the video encoder starts. If touch events are sent
   before this callback fires, `displayData` may be null or stale.

2. **Size rounding:** scrcpy forces the video size to a multiple of 8
   (`max_size` is applied as `value & ~7`). The codec metadata header reports the
   actual encoded size, but `PositionMapper` may use a slightly different value.

3. **Rotation handling:** If the device rotates between session start and the touch
   event, the video size changes but `session.screenSize` is stale.

**Investigation steps:**

- Enable verbose logging on the server (`log_level=verbose`) and check for the
  message `"Ignore positional event generated for size X (current size is Y)"`.
- Compare the exact `videoSize` in the server's `PositionMapper` against the
  `screenSize` values the MCP sends in touch messages.
- Test with `adb shell` to verify the scrcpy server is receiving control messages
  at all (check logcat for touch event parsing).

**Workaround:** Use `adb shell input tap X Y` (ADB fallback) for touch events.
The MCP tools already fall back to this when no scrcpy session is active.
