#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerSessionTools } from "./tools/session.js"
import { registerDeviceTools } from "./tools/device.js"
import { registerVisionTools } from "./tools/vision.js"
import { registerInputTools } from "./tools/input.js"
import { registerAppTools } from "./tools/apps.js"
import { registerClipboardTools } from "./tools/clipboard.js"
import { registerUiTools } from "./tools/ui.js"
import { registerShellTools } from "./tools/shell.js"
import { registerFileTools } from "./tools/files.js"

function createServer() {
  const server = new McpServer({
    name: "scrcpy-mcp",
    version: process.env.npm_package_version ?? "0.0.0",
  })

  registerSessionTools(server)
  registerDeviceTools(server)
  registerVisionTools(server)
  registerInputTools(server)
  registerAppTools(server)
  registerClipboardTools(server)
  registerUiTools(server)
  registerShellTools(server)
  registerFileTools(server)

  return server
}

export function createSandboxServer() {
  return createServer()
}

async function main() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[scrcpy-mcp] Server running on stdio")
}

main().catch((err) => {
  console.error("[scrcpy-mcp] Fatal error:", err)
  process.exit(1)
})
