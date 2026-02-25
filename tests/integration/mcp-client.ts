import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

let client: Client | null = null
let transport: StdioClientTransport | null = null

export async function connectClient(): Promise<Client> {
  if (client) return client

  transport = new StdioClientTransport({
    command: "node",
    args: [process.cwd() + "/dist/index.js"],
  })

  client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  )

  await client.connect(transport)
  return client
}

export async function disconnectClient(): Promise<void> {
  try {
    if (client) await client.close()
  } finally {
    if (transport) {
      transport.close()
      transport = null
    }
    client = null
  }
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const c = await connectClient()
  return c.callTool({ name, arguments: args }) as Promise<CallToolResult>
}

export async function listTools() {
  const c = await connectClient()
  return c.listTools()
}

export function parseResult(result: CallToolResult): unknown {
  const textContent = result.content.find((c) => c.type === "text")
  if (!textContent || !("text" in textContent)) {
    throw new Error("No text content in result")
  }
  try {
    return JSON.parse(textContent.text)
  } catch {
    return textContent.text
  }
}
