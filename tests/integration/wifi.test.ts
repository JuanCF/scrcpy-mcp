import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execAdb } from "../../src/utils/adb.js"
import { connectClient, disconnectClient, callTool, parseResult } from "./mcp-client.js"

const runWifiTests = process.env.TEST_WIFI === "1"

describe.skipIf(!runWifiTests)("Wi-Fi ADB Tools Integration", () => {
  let deviceSerial: string | null = null
  let wifiAddress: string | null = null

  beforeAll(async () => {
    await connectClient()
    const result = await callTool("device_list")
    const parsed = parseResult(result) as {
      devices: Array<{ serial: string }>
    }
    deviceSerial = parsed.devices[0]?.serial ?? null
  }, 30000)

  afterAll(async () => {
    if (wifiAddress) {
      try {
        await callTool("disconnect_wifi", { address: wifiAddress })
      } catch {
        // ignore
      }
    }
    // disconnect_wifi only drops the host-side TCP connection; connect_wifi ran
    // `adb tcpip`, which leaves adbd on the device listening indefinitely, so
    // put it back on USB-only transport. Gated on connect_wifi having actually
    // succeeded: `adb usb` restarts adbd, and on some devices it returns
    // unauthorized until someone accepts the USB-debugging dialog on the phone.
    // That is an acceptable cost to undo a transport switch we caused, but not
    // one to pay on every run of the suite.
    if (wifiAddress && deviceSerial) {
      try {
        await execAdb(["-s", deviceSerial, "usb"])
      } catch {
        // ignore
      }
    }
    await disconnectClient()
  }, 30000)

  it("should connect to and disconnect from the device over Wi-Fi", async () => {
    expect(deviceSerial).toBeTruthy()

    const connectResult = await callTool("connect_wifi", {
      serial: deviceSerial!,
      port: 5555,
    })
    const connectMessage = String(parseResult(connectResult))
    expect(connectResult.isError || connectMessage.toLowerCase().includes("failed")).toBe(false)
    expect(connectMessage).toContain("Connected to")

    const addressMatch = connectMessage.match(/Connected to\s+([\d.:]+)/)
    expect(addressMatch).toBeTruthy()
    wifiAddress = addressMatch![1]

    const disconnectResult = await callTool("disconnect_wifi", { address: wifiAddress })
    const disconnectMessage = String(parseResult(disconnectResult))
    expect(disconnectResult.isError || disconnectMessage.toLowerCase().includes("failed")).toBe(false)
    expect(disconnectMessage).toContain("Disconnected")
  }, 60000)
})
