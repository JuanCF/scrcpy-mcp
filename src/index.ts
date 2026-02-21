#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerSessionTools } from "./tools/session.js"
import { registerDeviceTools } from "./tools/device.js"
import { registerVisionTools } from "./tools/vision.js"
import { registerInputTools } from "./tools/input.js"

const server = new McpServer({
  name: "scrcpy-mcp",
  version: "0.1.0",
})

registerSessionTools(server)
registerDeviceTools(server)
registerVisionTools(server)
registerInputTools(server)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[scrcpy-mcp] Server running on stdio")
}

main().catch((err) => {
  console.error("[scrcpy-mcp] Fatal error:", err)
  process.exit(1)
})
