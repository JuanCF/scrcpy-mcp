import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const ADB_PATH = process.env.ADB_PATH || "adb";
const DEFAULT_TIMEOUT = 30000;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface DeviceInfo {
  serial: string;
  state: "device" | "unauthorized" | "offline" | string;
  model?: string;
  product?: string;
  transportId?: string;
}

export async function execAdb(
  args: string[],
  timeout: number = DEFAULT_TIMEOUT
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(ADB_PATH, args, {
      timeout,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error: unknown) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(
      `ADB command failed: ${ADB_PATH} ${args.join(" ")}\n${err.stderr || err.message || String(error)}`,
      { cause: error }
    );
  }
}

export async function execAdbRaw(
  args: string[],
  timeout: number = DEFAULT_TIMEOUT
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = execFile(ADB_PATH, args, {
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "buffer",
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ADB command exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

export async function execAdbShell(
  serial: string,
  command: string,
  timeout?: number
): Promise<string> {
  const { stdout } = await execAdb(["-s", serial, "shell", command], timeout);
  return stdout.trim();
}

export async function getDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await execAdb(["devices", "-l"]);
  const lines = stdout.trim().split("\n").slice(1);

  const devices: DeviceInfo[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const match = line.match(
      /^(\S+)\s+(\S+)\s+(.*)$/
    );

    if (match) {
      const serial = match[1];
      const state = match[2];
      const info = match[3] || "";

      const modelMatch = info.match(/model:(\S+)/);
      const productMatch = info.match(/product:(\S+)/);
      const transportIdMatch = info.match(/transport_id:(\d+)/);

      devices.push({
        serial,
        state,
        model: modelMatch?.[1],
        product: productMatch?.[1],
        transportId: transportIdMatch?.[1],
      });
    }
  }

  return devices;
}

export async function resolveSerial(serial?: string): Promise<string> {
  if (serial) {
    return serial;
  }

  const envSerial = process.env.ANDROID_SERIAL;
  if (envSerial) {
    return envSerial;
  }

  const devices = await getDevices();

  if (devices.length === 0) {
    throw new Error("No Android devices connected");
  }

  const authorizedDevices = devices.filter((d) => d.state === "device");

  if (authorizedDevices.length === 0) {
    const unauthorized = devices.find((d) => d.state === "unauthorized");
    if (unauthorized) {
      throw new Error(
        `Device ${unauthorized.serial} is unauthorized. Please authorize USB debugging on the device.`
      );
    }
    throw new Error("No authorized Android devices connected");
  }

  if (authorizedDevices.length > 1) {
    const serials = authorizedDevices.map((d) => d.serial).join(", ");
    throw new Error(
      `Multiple devices connected. Specify serial parameter. Available: [${serials}]`
    );
  }

  return authorizedDevices[0].serial;
}

export async function getScreenSize(
  serial: string
): Promise<{ width: number; height: number }> {
  const output = await execAdbShell(serial, "wm size");

  const match = output.match(/Physical size:\s*(\d+)x(\d+)/);
  if (match) {
    return {
      width: parseInt(match[1], 10),
      height: parseInt(match[2], 10),
    };
  }

  const overrideMatch = output.match(/Override size:\s*(\d+)x(\d+)/);
  if (overrideMatch) {
    return {
      width: parseInt(overrideMatch[1], 10),
      height: parseInt(overrideMatch[2], 10),
    };
  }

  throw new Error(`Could not parse screen size from output: ${output}`);
}

export async function getDeviceProperty(
  serial: string,
  property: string
): Promise<string> {
  return execAdbShell(serial, `getprop ${property}`);
}
