import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getDevices,
  execAdbShell,
  resolveSerial,
  getScreenSize,
  getDeviceProperty,
  execAdb,
} from "../utils/adb.js";

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
      const s = await resolveSerial(serial);
      await execAdbShell(s, "input keyevent KEYCODE_WAKEUP");
      return {
        content: [{ type: "text", text: `Screen turned on for device ${s}` }],
      };
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
      const s = await resolveSerial(serial);
      await execAdbShell(s, "input keyevent KEYCODE_SLEEP");
      return {
        content: [{ type: "text", text: `Screen turned off for device ${s}` }],
      };
    }
  );

  server.registerTool(
    "connect_wifi",
    {
      description: "Enable WiFi ADB and connect to the device wirelessly. Returns the connection address.",
      inputSchema: {
        port: z
          .number()
          .optional()
          .default(5555)
          .describe("TCP port for ADB connection (default: 5555)"),
        serial: z.string().optional().describe("Device serial number"),
      },
    },
    async ({ port, serial }) => {
      const s = await resolveSerial(serial);

      await execAdb(["-s", s, "tcpip", String(port)], 10000);

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const ipOutput = await execAdbShell(s, "ip route");
      const ipMatch = ipOutput.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
      if (!ipMatch) {
        throw new Error("Could not determine device IP address");
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
      await execAdb(["disconnect", address]);
      return {
        content: [{ type: "text", text: `Disconnected from ${address}` }],
      };
    }
  );
}
