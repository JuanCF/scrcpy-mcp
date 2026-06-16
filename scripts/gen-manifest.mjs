// Rebuilds manifest.json's `tools` array from the live server's tools/list so the
// bundled manifest faithfully mirrors the server (name, description, inputSchema,
// outputSchema, annotations). Also ensures homepage + icon fields are present.
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const REPO = "https://github.com/JuanCF/scrcpy-mcp"

function listTools() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.on("error", reject)
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n")
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gen", version: "0" } } })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    setTimeout(() => {
      child.kill()
      const line = out.trim().split("\n").map((l) => { try { return JSON.parse(l) } catch { return null } })
        .find((m) => m && m.id === 2)
      if (!line) return reject(new Error("no tools/list response"))
      resolve(line.result.tools)
    }, 1500)
  })
}

const tools = await listTools()
tools.sort((a, b) => a.name.localeCompare(b.name))

// The .mcpb manifest tools[] schema only permits name + description; full
// inputSchema/outputSchema/annotations are advertised by the live server's
// tools/list. Keep the manifest a valid, complete name+description mirror.
const manifestTools = tools.map((t) => ({
  name: t.name,
  description: t.description,
}))

const m = JSON.parse(readFileSync("manifest.json", "utf8"))

// Rebuild with a sensible key order, inserting homepage + icon after description.
const out = {
  manifest_version: m.manifest_version,
  name: m.name,
  version: m.version,
  description: m.description,
  homepage: REPO,
  icon: "icon.png",
  author: m.author,
  server: m.server,
  tools: manifestTools,
  compatibility: m.compatibility,
  user_config: m.user_config,
  keywords: m.keywords,
  license: m.license,
  repository: m.repository,
}

writeFileSync("manifest.json", JSON.stringify(out, null, 2) + "\n")
console.log(`manifest.json rebuilt: ${manifestTools.length} tools, homepage + icon added`)
