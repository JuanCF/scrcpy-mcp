import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execAdbShell, resolveSerial, getDeviceProperty } from "../utils/adb.js";

const KEYCODE_MAP: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  END_CALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  ENTER: 66,
  DELETE: 67,
  TAB: 61,
  MENU: 82,
  APP_SWITCH: 187,
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

function escapeTextForShell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/ /g, "%s")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\|/g, "\\|")
    .replace(/;/g, "\\;")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/&/g, "\\&")
    .replace(/\*/g, "\\*")
    .replace(/\?/g, "\\?")
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/!/g, "\\!");
}

function resolveKeycode(keycode: string | number): number {
  if (typeof keycode === "number") {
    return keycode;
  }
  const upperKey = keycode.toUpperCase();
  if (KEYCODE_MAP[upperKey] !== undefined) {
    return KEYCODE_MAP[upperKey];
  }
  const parsed = parseInt(keycode, 10);
  if (isNaN(parsed)) {
    throw new Error(`Unknown keycode: ${keycode}`);
  }
  return parsed;
}

export function registerInputTools(server: McpServer) {
  server.tool(
    "tap",
    "Tap at the specified screen coordinates",
    {
      x: z.number().int().nonnegative().describe("X coordinate"),
      y: z.number().int().nonnegative().describe("Y coordinate"),
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ x, y, serial }) => {
      const s = await resolveSerial(serial);
      await execAdbShell(s, `input tap ${x} ${y}`);
      return {
        content: [{ type: "text", text: `Tapped at (${x}, ${y})` }],
      };
    }
  );

  server.tool(
    "swipe",
    "Perform a swipe gesture from one point to another",
    {
      x1: z.number().int().nonnegative().describe("Start X coordinate"),
      y1: z.number().int().nonnegative().describe("Start Y coordinate"),
      x2: z.number().int().nonnegative().describe("End X coordinate"),
      y2: z.number().int().nonnegative().describe("End Y coordinate"),
      duration: z.number().int().positive().optional().default(300).describe("Duration in milliseconds"),
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ x1, y1, x2, y2, duration, serial }) => {
      const s = await resolveSerial(serial);
      await execAdbShell(s, `input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`);
      return {
        content: [{ type: "text", text: `Swiped from (${x1}, ${y1}) to (${x2}, ${y2}) in ${duration}ms` }],
      };
    }
  );

  server.tool(
    "long_press",
    "Perform a long press at the specified coordinates",
    {
      x: z.number().int().nonnegative().describe("X coordinate"),
      y: z.number().int().nonnegative().describe("Y coordinate"),
      duration: z.number().int().positive().optional().default(500).describe("Duration in milliseconds"),
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ x, y, duration, serial }) => {
      const s = await resolveSerial(serial);
      await execAdbShell(s, `input swipe ${x} ${y} ${x} ${y} ${duration}`);
      return {
        content: [{ type: "text", text: `Long pressed at (${x}, ${y}) for ${duration}ms` }],
      };
    }
  );

  server.tool(
    "drag_drop",
    "Perform a drag and drop gesture from one point to another. Uses input draganddrop on Android 8.0+ (API 26), falls back to swipe on older versions.",
    {
      startX: z.number().int().nonnegative().describe("Start X coordinate"),
      startY: z.number().int().nonnegative().describe("Start Y coordinate"),
      endX: z.number().int().nonnegative().describe("End X coordinate"),
      endY: z.number().int().nonnegative().describe("End Y coordinate"),
      duration: z.number().int().positive().optional().default(300).describe("Duration in milliseconds"),
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ startX, startY, endX, endY, duration, serial }) => {
      const s = await resolveSerial(serial);
      
      const sdkStr = await getDeviceProperty(s, "ro.build.version.sdk");
      const sdkLevel = parseInt(sdkStr, 10);
      
      if (!isNaN(sdkLevel) && sdkLevel >= 26) {
        await execAdbShell(s, `input draganddrop ${startX} ${startY} ${endX} ${endY} ${duration}`);
        return {
          content: [{ type: "text", text: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY}) in ${duration}ms` }],
        };
      }
      
      console.error(`[drag_drop] SDK ${sdkLevel} < 26, using swipe fallback`);
      await execAdbShell(s, `input swipe ${startX} ${startY} ${endX} ${endY} ${duration}`);
      return {
        content: [{ type: "text", text: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY}) in ${duration}ms (swipe fallback)` }],
      };
    }
  );

  server.tool(
    "input_text",
    "Type text into the currently focused input field",
    {
      text: z.string().describe("Text to type"),
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ text, serial }) => {
      const s = await resolveSerial(serial);
      const escaped = escapeTextForShell(text);
      await execAdbShell(s, `input text "${escaped}"`);
      return {
        content: [{ type: "text", text: `Typed: "${text}"` }],
      };
    }
  );

  server.tool(
    "key_event",
    "Send a key event to the device. Supports keycodes like HOME, BACK, ENTER, VOLUME_UP, etc.",
    {
      keycode: z.union([z.string(), z.number()]).describe("Keycode name (e.g., 'HOME', 'BACK') or numeric value"),
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ keycode, serial }) => {
      const s = await resolveSerial(serial);
      const code = resolveKeycode(keycode);
      await execAdbShell(s, `input keyevent ${code}`);
      return {
        content: [{ type: "text", text: `Sent key event: ${keycode} (${code})` }],
      };
    }
  );

  server.tool(
    "scroll",
    "Scroll at the specified position. dx and dy are scroll amounts (-1 to 1 range approximated for ADB).",
    {
      x: z.number().int().nonnegative().describe("X coordinate to scroll at"),
      y: z.number().int().nonnegative().describe("Y coordinate to scroll at"),
      dx: z.number().describe("Horizontal scroll amount (negative=left, positive=right)"),
      dy: z.number().describe("Vertical scroll amount (negative=up, positive=down)"),
      serial: z.string().optional().describe("Device serial number"),
    },
    async ({ x, y, dx, dy, serial }) => {
      const s = await resolveSerial(serial);
      const duration = 300;
      const distance = 100;
      
      const endX = Math.max(0, Math.round(x + dx * distance));
      const endY = Math.max(0, Math.round(y + dy * distance));
      
      await execAdbShell(s, `input swipe ${x} ${y} ${endX} ${endY} ${duration}`);
      return {
        content: [{ type: "text", text: `Scrolled at (${x}, ${y}) with delta (${dx}, ${dy})` }],
      };
    }
  );
}
