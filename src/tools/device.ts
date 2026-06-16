import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  getDevices,
  execAdbShell,
  resolveSerial,
  getScreenSize,
  getDeviceProperty,
  execAdb,
} from "../utils/adb.js"
import {
  hasActiveSession,
  sendControlMessage,
  serializeSetDisplayPower,
  serializeRotateDevice,
  serializeExpandNotificationPanel,
  serializeExpandSettingsPanel,
  serializeCollapsePanels,
} from "../utils/scrcpy.js"

const requireActiveSession = (
  serial: string,
  toolName: string
): { error: true; message: string } | null => {
  if (!hasActiveSession(serial)) {
    return {
      error: true,
      message: `${toolName} requires an active scrcpy session for device ${serial}. ` +
        `Start a session first with start_session.`,
    }
  }
  return null
}

// Shared output schema for device action tools: a simple success + message result.
const actionOutputSchema = {
  success: z.boolean().describe("Whether the action succeeded"),
  message: z.string().describe("Human-readable description of the result"),
}

function actionOk(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { success: true, message, ...extra },
  }
}

function toolError(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: true, message, ...extra }),
    }],
    isError: true as const,
  }
}

export function registerDeviceTools(server: McpServer) {
  server.registerTool(
    "device_list",
    {
      description: "List all connected Android devices with their serial numbers, state, and model",
      inputSchema: {},
      outputSchema: {
        count: z.number().int().describe("Number of connected devices"),
        devices: z.array(
          z.object({
            serial: z.string().describe("Device serial number"),
            state: z.string().describe("Connection state (device, unauthorized, offline, ...)"),
            model: z.string().optional().describe("Device model"),
            product: z.string().optional().describe("Product name"),
            transportId: z.string().optional().describe("ADB transport id"),
          })
        ).describe("Connected devices"),
      },
      annotations: {
        title: "List Devices",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const devices = await getDevices();
      const structured = { count: devices.length, devices };
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  server.registerTool(
    "device_info",
    {
      description: "Get detailed info about a device: model, Android version, screen size, SDK level, battery level",
      inputSchema: {
        serial: z
          .string()
          .optional()
          .describe("Device serial number. If omitted, uses the only connected device."),
      },
      outputSchema: {
        serial: z.string().describe("Resolved device serial"),
        model: z.string().nullable().describe("Device model"),
        brand: z.string().nullable().describe("Device brand"),
        manufacturer: z.string().nullable().describe("Device manufacturer"),
        androidVersion: z.string().nullable().describe("Android release version"),
        sdkLevel: z.number().int().nullable().describe("Android SDK API level"),
        screenWidth: z.number().int().describe("Screen width in pixels"),
        screenHeight: z.number().int().describe("Screen height in pixels"),
        batteryLevel: z.number().int().nullable().describe("Battery level percentage"),
      },
      annotations: {
        title: "Device Info",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial);
        const [model, brand, manufacturer, version, sdk, screenSize, battery] =
          await Promise.all([
            getDeviceProperty(s, "ro.product.model"),
            getDeviceProperty(s, "ro.product.brand"),
            getDeviceProperty(s, "ro.product.manufacturer"),
            getDeviceProperty(s, "ro.build.version.release"),
            getDeviceProperty(s, "ro.build.version.sdk"),
            getScreenSize(s),
            execAdbShell(s, "dumpsys battery"),
          ]);

        const batteryMatch = battery.match(/level:\s*(\d+)/);
        const batteryLevel = batteryMatch ? parseInt(batteryMatch[1], 10) : null;

        const info = {
          serial: s,
          model: model || null,
          brand: brand || null,
          manufacturer: manufacturer || null,
          androidVersion: version || null,
          sdkLevel: sdk ? parseInt(sdk, 10) : null,
          screenWidth: screenSize.width,
          screenHeight: screenSize.height,
          batteryLevel,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
          structuredContent: info,
        };
      } catch (error) {
        const err = error as Error;
        return toolError(`Failed to get device info: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "screen_on",
    {
      description: "Wake the device screen (turn screen on)",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: actionOutputSchema,
      annotations: {
        title: "Turn Screen On",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial);

        if (hasActiveSession(s)) {
          sendControlMessage(s, serializeSetDisplayPower(true));
          return actionOk(`Screen turned on for device ${s} (via scrcpy)`);
        }

        await execAdbShell(s, "input keyevent KEYCODE_WAKEUP");
        return actionOk(`Screen turned on for device ${s}`);
      } catch (error) {
        const err = error as Error;
        return toolError(`Failed to turn screen on: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "screen_off",
    {
      description: "Turn the device screen off",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: actionOutputSchema,
      annotations: {
        title: "Turn Screen Off",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial);

        if (hasActiveSession(s)) {
          sendControlMessage(s, serializeSetDisplayPower(false));
          return actionOk(`Screen turned off for device ${s} (via scrcpy)`);
        }

        await execAdbShell(s, "input keyevent KEYCODE_SLEEP");
        return actionOk(`Screen turned off for device ${s}`);
      } catch (error) {
        const err = error as Error;
        return toolError(`Failed to turn screen off: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "connect_wifi",
    {
      description: "Enable WiFi ADB and connect to the device wirelessly. Returns the connection address.",
      inputSchema: {
        port: z
          .number()
          .int()
          .optional()
          .default(5555)
          .describe("TCP port for ADB connection (default: 5555)"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the wireless connection was established"),
        address: z.string().optional().describe("The host:port the device was connected on"),
        message: z.string().describe("Human-readable description of the result"),
      },
      annotations: {
        title: "Connect over Wi-Fi",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ port, serial }) => {
      try {
        const s = await resolveSerial(serial);

        await execAdb(["-s", s, "tcpip", String(port)], 10000);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const ipOutput = await execAdbShell(s, "ip route");
        const ipMatch = ipOutput.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
        if (!ipMatch) {
          return toolError("Could not determine device IP address. Ensure the device is connected to WiFi.");
        }
        const ip = ipMatch[1];
        const address = `${ip}:${port}`;

        await execAdb(["connect", address], 10000);

        return actionOk(`Connected to ${address}`, { address });
      } catch (error) {
        const err = error as Error;
        return toolError(`Failed to connect via WiFi: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "disconnect_wifi",
    {
      description: "Disconnect from a wireless ADB device",
      inputSchema: {
        address: z.string().describe("Device address (e.g., 192.168.1.100:5555)"),
      },
      outputSchema: actionOutputSchema,
      annotations: {
        title: "Disconnect Wi-Fi",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ address }) => {
      try {
        await execAdb(["disconnect", address]);
        return actionOk(`Disconnected from ${address}`);
      } catch (error) {
        const err = error as Error;
        return toolError(`Failed to disconnect from ${address}: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "rotate_device",
    {
      description: "Rotate the device screen (requires active scrcpy session)",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: actionOutputSchema,
      annotations: {
        title: "Rotate Device",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "rotate_device")
        if (sessionError) {
          return toolError(sessionError.message)
        }

        sendControlMessage(s, serializeRotateDevice())
        return actionOk(`Device rotated for ${s}`)
      } catch (error) {
        const err = error as Error
        return toolError(`Failed to rotate device: ${err.message}`, { serial: s || "unknown" })
      }
    }
  )

  server.registerTool(
    "expand_notifications",
    {
      description: "Expand the notification panel (requires active scrcpy session)",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: actionOutputSchema,
      annotations: {
        title: "Expand Notifications",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "expand_notifications")
        if (sessionError) {
          return toolError(sessionError.message)
        }

        sendControlMessage(s, serializeExpandNotificationPanel())
        return actionOk(`Notification panel expanded for ${s}`)
      } catch (error) {
        const err = error as Error
        return toolError(`Failed to expand notifications: ${err.message}`, { serial: s })
      }
    }
  )

  server.registerTool(
    "expand_settings",
    {
      description: "Expand the quick settings panel (requires active scrcpy session)",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: actionOutputSchema,
      annotations: {
        title: "Expand Quick Settings",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "expand_settings")
        if (sessionError) {
          return toolError(sessionError.message)
        }

        sendControlMessage(s, serializeExpandSettingsPanel())
        return actionOk(`Quick settings panel expanded for ${s}`)
      } catch (error) {
        const err = error as Error
        return toolError(`Failed to expand settings: ${err.message}`, { serial: s })
      }
    }
  )

  server.registerTool(
    "collapse_panels",
    {
      description: "Collapse all open panels (notification, settings) (requires active scrcpy session)",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: actionOutputSchema,
      annotations: {
        title: "Collapse Panels",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "collapse_panels")
        if (sessionError) {
          return toolError(sessionError.message)
        }

        sendControlMessage(s, serializeCollapsePanels())
        return actionOk(`Panels collapsed for ${s}`)
      } catch (error) {
        const err = error as Error
        return toolError(`Failed to collapse panels: ${err.message}`, { serial: s })
      }
    }
  )
}
