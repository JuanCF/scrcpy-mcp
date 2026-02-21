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

export function registerDeviceTools(server: McpServer) {
  server.registerTool(
    "device_list",
    {
      description: "List all connected Android devices with their serial numbers, state, and model",
      inputSchema: {},
    },
    async () => {
      const devices = await getDevices();
      return {
        content: [{ type: "text", text: JSON.stringify(devices, null, 2) }],
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
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: true, message: `Failed to get device info: ${err.message}` }),
            },
          ],
        };
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
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial);
        
        if (hasActiveSession(s)) {
          sendControlMessage(s, serializeSetDisplayPower(true));
          return {
            content: [{ type: "text", text: `Screen turned on for device ${s} (via scrcpy)` }],
          };
        }
        
        await execAdbShell(s, "input keyevent KEYCODE_WAKEUP");
        return {
          content: [{ type: "text", text: `Screen turned on for device ${s}` }],
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: true, message: `Failed to turn screen on: ${err.message}` }),
            },
          ],
        };
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
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial);
        
        if (hasActiveSession(s)) {
          sendControlMessage(s, serializeSetDisplayPower(false));
          return {
            content: [{ type: "text", text: `Screen turned off for device ${s} (via scrcpy)` }],
          };
        }
        
        await execAdbShell(s, "input keyevent KEYCODE_SLEEP");
        return {
          content: [{ type: "text", text: `Screen turned off for device ${s}` }],
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: true, message: `Failed to turn screen off: ${err.message}` }),
            },
          ],
        };
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
    },
    async ({ port, serial }) => {
      try {
        const s = await resolveSerial(serial);

        await execAdb(["-s", s, "tcpip", String(port)], 10000);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const ipOutput = await execAdbShell(s, "ip route");
        const ipMatch = ipOutput.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
        if (!ipMatch) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: true, message: "Could not determine device IP address. Ensure the device is connected to WiFi." }),
              },
            ],
          };
        }
        const ip = ipMatch[1];
        const address = `${ip}:${port}`;

        await execAdb(["connect", address], 10000);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ address, message: `Connected to ${address}` }),
            },
          ],
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: true, message: `Failed to connect via WiFi: ${err.message}` }),
            },
          ],
        };
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
    },
    async ({ address }) => {
      try {
        await execAdb(["disconnect", address]);
        return {
          content: [{ type: "text", text: `Disconnected from ${address}` }],
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [{ type: "text", text: JSON.stringify({ error: true, message: `Failed to disconnect from ${address}: ${err.message}` }) }],
        };
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
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "rotate_device")
        if (sessionError) {
          return {
            content: [{ type: "text", text: JSON.stringify(sessionError) }],
          }
        }

        sendControlMessage(s, serializeRotateDevice())
        return {
          content: [{ type: "text", text: `Device rotated for ${s}` }],
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                serial: s || "unknown",
                message: `Failed to rotate device: ${err.message}`,
              }),
            },
          ],
        }
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
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "expand_notifications")
        if (sessionError) {
          return {
            content: [{ type: "text", text: JSON.stringify(sessionError) }],
          }
        }

        sendControlMessage(s, serializeExpandNotificationPanel())
        return {
          content: [{ type: "text", text: `Notification panel expanded for ${s}` }],
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                serial: s,
                message: `Failed to expand notifications: ${err.message}`,
              }),
            },
          ],
        }
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
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "expand_settings")
        if (sessionError) {
          return {
            content: [{ type: "text", text: JSON.stringify(sessionError) }],
          }
        }

        sendControlMessage(s, serializeExpandSettingsPanel())
        return {
          content: [{ type: "text", text: `Quick settings panel expanded for ${s}` }],
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                serial: s,
                message: `Failed to expand settings: ${err.message}`,
              }),
            },
          ],
        }
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
    },
    async ({ serial }) => {
      let s = "unknown"
      try {
        s = await resolveSerial(serial)

        const sessionError = requireActiveSession(s, "collapse_panels")
        if (sessionError) {
          return {
            content: [{ type: "text", text: JSON.stringify(sessionError) }],
          }
        }

        sendControlMessage(s, serializeCollapsePanels())
        return {
          content: [{ type: "text", text: `Panels collapsed for ${s}` }],
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                serial: s,
                message: `Failed to collapse panels: ${err.message}`,
              }),
            },
          ],
        }
      }
    }
  )
}
