---
name: scrcpy-gotchas
description: Use when interacting with Android devices via scrcpy-mcp tools (tap, swipe, input_text, key_event, ui_dump, ui_find_element, app_start, etc.). Documents common pitfalls and lessons learned.
---

# scrcpy-mcp Gotchas

## Coordinate systems: always use native coordinates

`scrcpy_tap`, `scrcpy_swipe`, `scrcpy_long_press`, and `scrcpy_scroll` take **device-native coordinates** — the same space that `scrcpy_ui_dump` / `scrcpy_ui_find_element` report in their `bounds` and `tapX`/`tapY`, and the same space `adb shell input tap` uses. So the reliable workflow needs no scaling math:

```typescript
// Find the element (returns native tapX/tapY), then tap them straight through
const el = scrcpy_ui_find_element({ text: "<label>" })  // → { tapX, tapY }
scrcpy_tap({ x: el.tapX, y: el.tapY })
```

The input tools scale native → video-frame coordinates **internally** before sending the touch to the scrcpy server, so you never compute a scale factor yourself.

### Don't tap screenshot pixels

`scrcpy_screenshot` returns a **downscaled** image (e.g. `576×1024` at `maxSize=1024`), not the native frame. Tapping a pixel coordinate read off the screenshot lands in the wrong place. Always source coordinates from `ui_dump` / `ui_find_element` (native), never from the screenshot.

> Why internal scaling is required: the scrcpy server's touch protocol is **not** resolution-independent — the touch message's screen size must exactly match the encoder's video-frame size, or the server silently drops the event. The tools handle this conversion; you just supply native coords.

## ui_find_element matching rules

The four search criteria have different matching behaviors:

| Criterion | Match type | Case sensitivity |
|-----------|-----------|-----------------|
| `text` | **Partial substring** (`includes`) | **Case-insensitive** |
| `contentDesc` | **Partial substring** (`includes`) | **Case-insensitive** |
| `resourceId` | **Exact equality** (`===`) | **Case-sensitive** |
| `className` | **Exact equality** (`===`) | **Case-sensitive** |

All criteria are combined with **AND** logic — an element must satisfy every supplied criterion.

```typescript
// text: case-insensitive substring — "bater" matches "Batería"
scrcpy_ui_find_element({ text: "bater" })  // ✓

// resourceId: exact match only — must be full string
scrcpy_ui_find_element({ resourceId: "android:id/title" })  // must match exactly

// className: full qualified name — "Button" won't match "android.widget.Button"
scrcpy_ui_find_element({ className: "android.widget.Button" })  // full name required
```

### Accent caveat

`text` and `contentDesc` matching lowercases both sides and uses `String.includes()`. However, Unicode normalization differences between the XML dump (from `uiautomator`) and your query string can cause mismatches. Searching for an accented word (e.g. `"Batería"`) may return 0 even though the element displays that exact text, while a partial ASCII-only substring (e.g. `"bater"`) will find it.

**Rule of thumb:** Search with lowercase ASCII-only substrings when possible. If that fails, use `ui_dump` and check the raw XML for the actual byte sequence.

## Search list/feed items by contentDesc, not text

For tappable cards — search results, feed rows, media thumbnails — the visible label is often rendered by a child view that the clickable wrapper `ViewGroup` does **not** expose as `text`. A `text:` query then returns 0 matches (or only matches an unrelated element like the search bar).

The label instead lives in the wrapper's **`contentDesc`**, which is usually richer (e.g. it bundles secondary metadata into one string) and easier to disambiguate between similar items:

```typescript
// May return 0 — the result card has no `text`
scrcpy_ui_find_element({ text: "<title>" })

// Matches the clickable wrapper's contentDesc, which carries the label
scrcpy_ui_find_element({ contentDesc: "<title>" })
// → { contentDesc: "...", tapX, tapY, clickable: true }
```

Rule of thumb: if `text:` finds nothing for something you can clearly see on screen, retry with `contentDesc:` (or fall back to `scrcpy_ui_dump` and grep the XML) before assuming it isn't there.

## contentDesc quoting can break parsing

`uiautomator dump` wraps attribute values in double quotes (`"`) by default. But when a value itself contains double quotes (common in X/Twitter content-desc fields), it switches to **single quotes** (`'`). The `parseUiNodes()` parser only handles double-quote delimiters:

```
HTML attr regex: content-desc="([^"]*)"
                            ↑ only matches "..."
```

So `content-desc='tweet with "quoted" text'` → `contentDesc: ""` (empty string — parser misses it entirely).

**Impact:** `ui_find_element` won't find tweets/items whose contentDesc contains double quotes. The element is still in the dump but its contentDesc is silently empty.

**Workaround:** for text that reliably exists, use `text:` queries instead. For X timeline tweets, search by partial lowercase ASCII snippets that avoid quoted substrings.

```typescript
// This tweet: "a company just fired 90% of their dev team because claude code..."
// Won't match — contentDesc parsing fails due to embedded double quotes
scrcpy_ui_find_element({ contentDesc: "claude" })  // → 0 results

// But this promoted tweet has no embedded quotes → contentDesc parses fine
scrcpy_ui_find_element({ contentDesc: "runpod" })  // → found
```

## Non-ASCII text input (tildes, ¡, ¿, ñ...)

ADB's `input text` (used by `scrcpy_input_text`) **crashes on non-ASCII characters** like `¡`, `¿`, `ñ`, accented vowels (`é`, `á`, etc.), and `!`. The command throws a `NullPointerException` and silently fails.

**Workaround:** Use `scrcpy_clipboard_set` with `paste: true` instead — it handles any Unicode text:

```typescript
// BAD — crashes with special characters
scrcpy_input_text({ text: "¡Hola, mamá!" })

// GOOD — clipboard handles all characters
scrcpy_clipboard_set({ text: "¡Hola, mamá!", paste: true })
```

**Critical: `paste: true` requires an active scrcpy session.** Without one, the clipboard is set but the paste action is silently skipped (message: "Paste action not performed"). Always `scrcpy_start_session` before sending non-ASCII text.

### Exclamation mark (`!`) causes partial text loss

Even though `scrcpy_input_text` returns success, using `!` in the string can cause **partial text loss** — leading characters may be dropped. For example, `"Hello world!"` may type as `"llo world!"` (the `!` causes the ADB `input text` command to partially fail). The clipboard workaround above avoids this completely.

## Start the scrcpy session early

Start a scrcpy session proactively when doing multi-step interactions. It unlocks:
- Fast clipboard paste (`scrcpy_clipboard_set` with `paste: true`)
- Fast screenshots (10-50× faster than ADB)
- Fast input (tap, swipe, etc.)

Without a session, clipboard paste silently degrades and every screenshot is a slow ADB call.

### Session persists across screen on/off

Input (tap, swipe) and screenshots continue to work even when the screen is turned off via `scrcpy_screen_off`. Screenshots taken while screen is off will show a black/dark frame. Use `scrcpy_screen_on` to wake the device when needed.

### clipboard_get may be unreliable

`scrcpy_clipboard_get` can fail even with an active scrcpy session, especially on Android 10 devices. If it returns an error, the clipboard content is still likely not critical — rely on direct state checks via `ui_dump` instead.

## Scroll vs Swipe for scrolling content

**`scrcpy_scroll` does NOT work reliably on `RecyclerView` or `ScrollView` containers.** Many Android apps (Settings, Chrome, launchers, messaging apps) use `RecyclerView` for scrollable lists. `scrcpy_scroll` may return success but produce no visible movement.

**Use `scrcpy_swipe` instead for scrolling:**

```typescript
// BAD — may have no effect on RecyclerView
scrcpy_scroll({ x: 720, y: 1500, dx: 0, dy: 1 })

// GOOD — swipe gestures reliably scroll all scrollable views
scrcpy_swipe({ x1: 720, y1: 1800, x2: 720, y2: 800, duration: 500 })
```

For a swipe-down (content scrolls up): y1 > y2. For a swipe-up (content scrolls down): y1 < y2. Duration 300-500ms is a good default for natural scrolling.

**Watch for momentum side effects:** Long swipes can carry momentum that collapses toolbars, scrolls beyond intended position, or triggers overscroll actions. For precise scrolling, use shorter swipe distances (e.g., 200-400px delta).

## Send button tap vs. Enter key

When sending messages in WhatsApp (and likely other messaging apps), `scrcpy_tap` on the send button can silently miss — the hit target is small and easy to land just outside. Prefer `scrcpy_key_event` with `ENTER` instead, which is more reliable.

## Verified key events

These keycodes have been confirmed working via `scrcpy_key_event`:

| Keycode | Effect |
|---------|--------|
| `HOME` (3) | Go to home screen |
| `BACK` (4) | Navigate back |
| `ENTER` (66) | Submit/send in input fields |
| `APP_SWITCH` (187) | Open recent apps |
| `VOLUME_UP` (24) | Increase volume |
| `VOLUME_DOWN` (25) | Decrease volume |
| `MENU` (82) | Open menu (context-dependent) |

Use `scrcpy_key_event` with the string name (e.g., `"HOME"`) or numeric keycode.

## app_start reuses existing tasks

`scrcpy_app_start` brings an app to the foreground but reuses its existing task, preserving scroll position, UI state, and back stack. This is efficient for quick app switching but can be surprising:

```typescript
// Opens Settings but preserves scroll position from previous session
scrcpy_app_start({ packageName: "com.android.settings" })
```

**To force a clean launch**, prefix the package name with `+`:

```typescript
scrcpy_app_start({ packageName: "+com.android.settings" })
```

This force-stops the app before launching, clearing its state.

## Tool context

Use only `scrcpy_*` tools when controlling an Android device. Do not reach for browser tools (`browser_*`, `chrome-devtools_*`) in an Android context. Common mistake: using `browser_wait` instead of just proceeding to the next action.

## Locale-independent targeting

**Visible text labels (in `text`, `contentDesc`, `hint`) are locale-dependent.** What reads "Chats" in English is "Chats" in Spanish, "Discussions" in French, etc. Hardcoding text strings makes the skill fragile across devices.

**Always prefer locale-independent selectors first:**

| Selector | Locale-safe? | Example |
|----------|-------------|---------|
| `resourceId` | Yes | `com.whatsapp:id/entry` |
| `className` | Yes | `android.widget.Switch` |
| `text` | **No** | `"Mensaje"` (placeholder, varies) |
| `contentDesc` | **No** | `"Nuevo chat"` (varies) |

**Workflow for text-based targeting:**
1. Use `scrcpy_ui_dump` to discover the actual label on the device
2. Search with partial, lowercase substrings — avoids case/accent/unicode issues
3. Fall back to `resourceId` + `className` when possible

**In this document**, example labels are shown as generic patterns like `<app-name>` or with English/Spanish examples marked `(locale-dependent)`. Treat them as illustrations of the *type* of text to expect, not exact strings to copy.

## X (Twitter) specifics

- Package name: `com.twitter.android`
- **Timeline is a RecyclerView** (`android:id/list`) inside nested ViewPager + ScrollView. Scroll with `scrcpy_swipe`.
- **Timeline tweets store all content in `contentDesc`** — the row's `text` field is always empty. The `contentDesc` bundles author, handle, tweet body, engagement stats, and timestamp into one long string.
- **Ad tweets with external links open in Chrome Custom Tabs**, not in X's own browser. Use `BACK` to return to X.
- **Bottom navigation tabs** (5 tabs: home, search, grok, notifications, messages) are `android.widget.FrameLayout` elements with `contentDesc` labels (locale-dependent). Active tab has `selected="true"`. Discover actual labels via `ui_dump`.
- **Top timeline tabs** (e.g., "For You" / "Following") use `contentDesc` on the parent `LinearLayout`; active tab has `selected="true"`.
- **Long swipes collapse the toolbar** — toolbar and tab bar scroll away with the ViewPager's nested scroll. `BACK` restores them.
- **The new-posts banner** appears when fresh content loads while scrolled. It has `resourceId="com.twitter.android:id/banner_text"`. Tapping it scrolls to top.
- **Search/Explore tab** has a `HorizontalScrollView` sub-tab bar (`tab_layout`). Tab labels are locale-dependent; discover via `ui_dump`. Trending topic titles use `text` (not `contentDesc`).
- **Ad badge** has `resourceId="com.twitter.android:id/tweet_ad_badge_top_right"` with a short text label (locale-dependent, e.g. "Ad" / "Anuncio").

## Chrome/web browsing

- Package name: `com.android.chrome`
- **Web content IS accessible via `ui_dump`** when pages have proper accessibility markup (semantic HTML, ARIA). Plain pages like google.com may not expose content.
- **The WebView (`android.webkit.WebView`) is scrollable** — use `scrcpy_swipe` on the web content area (below the toolbar, y > 280).
- **URL bar** is an EditText at `com.android.chrome:id/url_bar`. Tap it, paste a URL via `clipboard_set`, and press `ENTER` to navigate.
- **Off-screen web elements** show as `bounds="[0,0][0,0]"` or zero-dimension bounds. Elements scrolled past the top show `bounds="[x,top][x,top]"` (height=0). Filter these out: only tap elements with positive height.
- **Chrome Custom Tabs** (opened from other apps' links) have a simpler toolbar with close, share, and minimize buttons. Use `BACK` to dismiss them.
- **Web pages with complex a11y trees** produce enormous XML dumps (30KB+). `ui_find_element` with targeted criteria is far more efficient than parsing the full `ui_dump` response.

## Multi-app switching

- **`APP_SWITCH` (keycode 187)** opens the recents overview with scrollable app previews.
- **Tap a preview** to switch to that app. The app restores its previous state.
- **`BACK` in recents** returns to the previously focused app.
- **`HOME` then `app_start`** is a reliable alternative when recents navigation gets confusing.
- **The prediction row** (bottom app icons) in recents is the same as the launcher dock.

## Settings deep navigation

- Package name: `com.android.settings`
- **Each sub-screen replaces the main view** — a back button (contentDesc like "Navigate up", locale-dependent), title, and search icon appear at the top.
- **Navigation depth** is unlimited; each level adds to the back stack. `BACK` returns one level.
- **Switch/toggle widgets** are `android.widget.Switch` with `checkable="true"`, `checked="true"|"false"`. The `text` shows on/off state (locale-dependent, e.g. "On"/"Off"). The parent row also has `checkable="true"`.
- **WiFi network rows** use comma-separated `contentDesc` on the clickable row: `<ssid>,<status>,<signal>,<security>`. The title and summary are separate `text` fields.
- **Scanning status** appears as a `ProgressBar` with resource ID `com.android.settings:id/progress_bar_animation` and a scanning message (locale-dependent).
- **Items with settings gears** have child elements like `com.android.settings:id/settings_button_no_background`.

## Screen recording

- `scrcpy_screen_record_start` with `duration` (seconds) auto-stops after that duration. The video is written to the specified `remotePath` on the device.
- After auto-stop, `scrcpy_screen_record_stop` reports "No recording in progress" — this is expected. The file is already saved.
- Use `scrcpy_file_pull` with `pullToHost: true` to retrieve the recording if you still need it.
- 10 seconds of recording at 1440×2560 produces ~2.6 MB of MP4.
- Without a `duration` parameter, recording continues indefinitely until `screen_record_stop` is called.

```typescript
// Start a 10-second recording
scrcpy_screen_record_start({ duration: 10, remotePath: "/sdcard/demo.mp4" })

// Pull it after it auto-stops
scrcpy_file_pull({ remotePath: "/sdcard/demo.mp4", localPath: "/tmp/demo.mp4" })
```

## File push/pull

- `scrcpy_file_push` copies a file from the host to the device. Both paths must be absolute.
- `scrcpy_file_pull` copies from the device to the host. Both paths must be absolute.
- Both report transfer speed (e.g., "62.8 MB/s") and skip count (0 when successful).
- `scrcpy_file_list` verifies file presence and shows metadata: permissions, owner, group, size, date, isDirectory.
- Files transfer byte-for-byte — verified with diff.

```typescript
scrcpy_file_push({ localPath: "/tmp/data.txt", remotePath: "/sdcard/data.txt" })
scrcpy_file_list({ path: "/sdcard/" })  // verify it's there
scrcpy_file_pull({ remotePath: "/sdcard/data.txt", localPath: "/tmp/copy.txt" })
```

## Rotation

- `scrcpy_rotate_device` toggles between portrait and landscape. There's no separate portrait/landscape command — each call flips orientation.
- After rotation, `scrcpy_ui_dump` shows `rotation="1"` (landscape) or `rotation="0"` (portrait) on the root `<hierarchy>` node.
- Bounds swap dimensions: portrait `[0,0][1440,2560]` → landscape `[0,0][2392,1440]`. Height is reduced by status bar area.
- All coordinates in the dump are in the **current rotation's coordinate space**. Element `tapX`/`tapY` from a landscape dump are valid for taps in landscape — no manual coordinate transformation needed.
- Toolbar elements stretch to fill the new width; content reflows.

## Shell exec

- `scrcpy_shell_exec` runs arbitrary shell commands on the device via `adb shell`.
- Output is raw text (stdout). Multiple commands can be chained with `&&` or `;`.
- Useful for system info not covered by other tools: `getprop`, `settings get`, `dumpsys`, `pm list`, `wm`, `df`, `top`, `ps`.

```typescript
// Device properties
scrcpy_shell_exec({ command: "getprop ro.build.version.release && getprop ro.product.model" })
// → "10\nNokia 8 Sirocco"

// Screen info
scrcpy_shell_exec({ command: "wm size && wm density" })
// → "Physical size: 1440x2560\nPhysical density: 560"

// Battery details
scrcpy_shell_exec({ command: "dumpsys battery | grep level" })
// → "  level: 100"

// Installed third-party packages
scrcpy_shell_exec({ command: "pm list packages -3" })
// → "package:com.whatsapp\npackage:com.twitter.android\n..."
```

## Video streaming (screen mirroring)

- `scrcpy_start_video_stream` starts an HTTP MJPEG stream at `http://127.0.0.1:7183` and opens an ffplay viewer window on the host.
- The stream shows the device screen in real-time — useful for visual feedback during multi-step interactions.
- Video streaming automatically starts a scrcpy session if one is not active. Closing the ffplay window does NOT stop the stream; use `scrcpy_stop_video_stream` to clean up.
- The max resolution is controlled by the `maxSize` parameter (default 1024). Use `maxFps` to cap frame rate (default 30).

```typescript
scrcpy_start_video_stream()  // opens ffplay window at http://127.0.0.1:7183

// Optional: custom port and resolution
scrcpy_start_video_stream({ port: 8080, maxSize: 720, maxFps: 15 })

scrcpy_stop_video_stream()  // close the stream and ffplay window
```

## Launcher home screen + app drawer

- The launcher workspace is an `android.widget.ScrollView` with `com.android.launcher3:id/workspace`. Horizontal swipes navigate between home screen pages.
- **The bottom dock** (fixed app shortcuts) stays visible across all pages. App labels vary by device.
- **App drawer opens with a swipe-up** from the bottom of the home screen — tapping the app-list icon alone may not work.
- The app drawer contains:
  - A search `EditText` at `com.android.launcher3:id/fallback_search_view` with a placeholder hint (locale-dependent)
  - An `androidx.recyclerview.widget.RecyclerView` (`com.android.launcher3:id/apps_list_view`) with app icons as `android.widget.TextView` elements
  - A prediction row (`com.android.launcher3:id/prediction_row`) showing 5 suggested apps at the top
- App icons have both `text` and `contentDesc` set to the same app name. Off-screen icons show `bounds="[0,0][0,0]"`.
- **Widgets** on home screens (clocks, fitness, search bars) appear as `LauncherAppWidgetHostView` nodes with descriptive `contentDesc` (e.g. "At a Glance" / "De un vistazo", "Digital Clock" / "Reloj digital").

## Quick Settings tiles

- `scrcpy_expand_settings` opens the Quick Settings panel (requires active scrcpy session). `scrcpy_collapse_panels` closes it.
- **Tiles are `android.widget.Switch`** widgets with `checkable="true"` and `checked="true"/"false"`. Use `checked` to determine state; `text` shows locale-dependent on/off labels.
- **Compound contentDesc**: Switch tiles bundle state info as comma-separated `contentDesc`. Example: WiFi tile → `"Wi-Fi,<signal-strength>,<ssid>"`.
- **Non-toggle tiles** (like battery saver, screenshot) use `android.widget.LinearLayout` with `clickable="true"` instead of Switch.
- **The tiles are paged** via an `androidx.viewpager.widget.ViewPager` (`quick_settings_panel`). A page indicator shows the current page (contentDesc like "Page 1 of 2"). Swipe horizontally on the ViewPager to change pages.
- **Brightness slider** is an `android.widget.SeekBar` at `com.android.systemui:id/slider`.
- **Footer buttons**: edit button (`android:id/edit`), user switch, settings gear (opens Settings app).
- To **toggle a tile**, find it by a stable substring of its `contentDesc` (e.g., "Flashlight" for English, "Linterna" for Spanish — discover via `ui_dump` first) and tap its center coordinates.

```typescript
// Toggle the flashlight tile (find by contentDesc substring)
const tile = scrcpy_ui_find_element({ contentDesc: "flashlight" })  // try English first
if (!tile.count) tile = scrcpy_ui_find_element({ contentDesc: "linterna" }) // fall back
scrcpy_tap({ x: tile.elements[0].tapX, y: tile.elements[0].tapY })
// Verify: tile.text changed, checked flipped
```

- **System UI elements** use package `com.android.systemui`. Quick settings, notifications, and status bar are not part of regular app windows — they overlay the existing content.

## WhatsApp specifics

- Package name: `com.whatsapp`
- Prefix with `+` to force-stop before launch: `+com.whatsapp`
- **Bottom tab bar** has 4 tabs (`android.widget.FrameLayout` elements): chats, updates, communities, calls. Active tab has `selected="true"`. Tab labels are locale-dependent — discover via `ui_dump`.
- **Chat list** is a RecyclerView at `android:id/list` with `com.whatsapp:id/contact_row_container` rows. Contact names are in `com.whatsapp:id/conversations_row_contact_name` (`text` field).
- **Chat screen**: contact name at `com.whatsapp:id/conversation_contact_name`, last-seen at `com.whatsapp:id/conversation_contact_status`.
- **Input field**: `com.whatsapp:id/entry` (`android.widget.EditText`) — tap to focus, then use `scrcpy_clipboard_set` with `paste: true` (requires active scrcpy session) for any text with non-ASCII characters. See **Non-ASCII text input** above.
- **Send**: use `scrcpy_key_event` with `ENTER` instead of tapping the send button.
- **Photo**: contact photo has contentDesc like "Photo of <name>" (locale-dependent pattern).
