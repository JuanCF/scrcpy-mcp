import { expect } from "vitest"
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

  const c = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  )

  await c.connect(transport)

  // Not just a warm-up: the SDK only caches output-schema validators in
  // cacheToolMetadata(), which runs off listTools(). Without this call
  // Client.callTool() skips validation entirely, so every tool declaring an
  // outputSchema could return no structuredContent — or content that violates
  // its own schema — and the suite would never notice. With it, every callTool
  // in the suite asserts schema conformance for free.
  await c.listTools()

  // Published only once fully ready, so a caller can never observe a client
  // whose validators have not been cached yet.
  client = c
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

/**
 * Stop any running scrcpy session, failing loudly if the tool reports an error.
 *
 * stop_session is a no-op when nothing is running, so calling it unconditionally
 * is safe. A genuine failure, though, comes back as a *resolved* result carrying
 * `isError` — a bare try/catch never sees it. Worth surfacing: the device permits
 * one encoder session at a time, so a swallowed failure resurfaces much later as
 * some unrelated file's start_session refusing to connect.
 */
export async function stopSessionOrFail(): Promise<void> {
  const result = await callTool("stop_session")
  if (!result.isError) return

  const { message } = parseResult(result) as { message?: string }
  throw new Error(`stop_session failed: ${message ?? JSON.stringify(result.content)}`)
}

/**
 * Assert that an action tool succeeded, and hand back its structured payload.
 *
 * The action tools (rotate_device, screen_off, collapse_panels, …) put a bare
 * human-readable sentence in `content` and report the actual contract — `success`
 * — only in `structuredContent`. So matching a substring of the text says nothing
 * about whether the action reported success; assert the structured payload and
 * match the message from there instead.
 *
 * Schema validation (see connectClient) already rejects a malformed
 * `structuredContent`, but it does not run for `isError` results and never checks
 * that `success` is actually `true` — which is what these callers care about.
 */
export function expectActionOk(result: CallToolResult): { success: boolean; message: string } {
  expect(result.isError, `tool returned an error: ${JSON.stringify(result.content)}`).toBeFalsy()

  const data = result.structuredContent as { success?: boolean; message?: string } | undefined
  expect(data, "action tool returned no structuredContent").toBeDefined()
  expect(data!.success, `action reported failure: ${data!.message}`).toBe(true)
  expect(typeof data!.message).toBe("string")

  return data as { success: boolean; message: string }
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
