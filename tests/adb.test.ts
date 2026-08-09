import { describe, it, expect } from "vitest"
import { parseDeviceList } from "../src/utils/adb.js"

describe("parseDeviceList", () => {
  it("parses Unix LF output", () => {
    const stdout =
      "List of devices attached\n" +
      "emulator-5554          device " +
      "product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 " +
      "device:emu64xa transport_id:1\n\n"

    expect(parseDeviceList(stdout)).toEqual([
      {
        serial: "emulator-5554",
        state: "device",
        model: "sdk_gphone64_x86_64",
        product: "sdk_gphone64_x86_64",
        transportId: "1",
      },
    ])
  })

  // Regression: Windows adb emits CRLF and can place a stray CR inside the
  // device line. JavaScript's `.` does not match `\r`, so the anchored
  // `(.*)$` in the line regex failed and every device was dropped — the
  // server reported "No Android devices connected" with a device attached.
  it("parses Windows CRLF output, including a mid-line carriage return", () => {
    const stdout =
      "List of devices attached\r\n" +
      "ABCD1234EFGH5678        device " +
      "product:generic_device\r model:Test_Model device:generic " +
      "transport_id:1\r\n\r\n"

    expect(parseDeviceList(stdout)).toEqual([
      {
        serial: "ABCD1234EFGH5678",
        state: "device",
        model: "Test_Model",
        product: "generic_device",
        transportId: "1",
      },
    ])
  })

  it("returns an empty list when no devices are attached", () => {
    expect(parseDeviceList("List of devices attached\r\n\r\n")).toEqual([])
    expect(parseDeviceList("List of devices attached\n\n")).toEqual([])
  })

  it("preserves non-device states so callers can report them", () => {
    const stdout =
      "List of devices attached\r\n" +
      "ABC123                 unauthorized transport_id:2\r\n" +
      "DEF456                 offline product:x model:y device:z " +
      "transport_id:3\r\n"

    const devices = parseDeviceList(stdout)
    expect(devices.map((d) => [d.serial, d.state])).toEqual([
      ["ABC123", "unauthorized"],
      ["DEF456", "offline"],
    ])
  })

  // Regression: "no permissions" is a multi-word adb device state.  The old
  // regex captured only "no" as the state and left "permissions ..." in the
  // info blob, so callers saw state "no" instead of "no permissions".
  it("preserves the multi-word 'no permissions' state", () => {
    const stdout =
      "List of devices attached\r\n" +
      "1234567890abcdef       no permissions usb:1 " +
      "product:sample_product model:sample_model device:sample " +
      "transport_id:1\r\n"

    expect(parseDeviceList(stdout)).toEqual([
      {
        serial: "1234567890abcdef",
        state: "no permissions",
        model: "sample_model",
        product: "sample_product",
        transportId: "1",
      },
    ])
  })

  it("parses multiple attached devices", () => {
    const stdout =
      "List of devices attached\r\n" +
      "SERIAL1                device product:p1 model:m1 device:d1 " +
      "transport_id:1\r\n" +
      "SERIAL2                device product:p2 model:m2 device:d2 " +
      "transport_id:2\r\n\r\n"

    expect(parseDeviceList(stdout).map((d) => d.serial)).toEqual(["SERIAL1", "SERIAL2"])
  })

  it("parses a line with only serial and state, no trailing metadata", () => {
    const stdout =
      "List of devices attached\r\n" +
      "ABC123                 unauthorized\r\n\r\n"

    const devices = parseDeviceList(stdout)
    expect(devices).toEqual([
      {
        serial: "ABC123",
        state: "unauthorized",
      },
    ])
  })
})
