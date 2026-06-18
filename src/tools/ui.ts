import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdbShell, resolveSerial } from "../utils/adb.js"

interface UiElement {
  text: string
  resourceId: string
  className: string
  contentDesc: string
  bounds: string
  tapX: number
  tapY: number
  clickable: boolean
}

export function parseUiNodes(xml: string): UiElement[] {
  const elements: UiElement[] = []
  const nodeRegex = /<node\s([^>]+?)(?:\/>|>)/gs
  let match: RegExpExecArray | null

  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1]
    const attr = (name: string): string => {
      const m = attrs.match(new RegExp(`${name}="([^"]*)"`) )
      return m ? m[1] : ""
    }

    const bounds = attr("bounds")
    const boundsMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!boundsMatch) continue

    const x1 = parseInt(boundsMatch[1], 10)
    const y1 = parseInt(boundsMatch[2], 10)
    const x2 = parseInt(boundsMatch[3], 10)
    const y2 = parseInt(boundsMatch[4], 10)

    elements.push({
      text: attr("text"),
      resourceId: attr("resource-id"),
      className: attr("class"),
      contentDesc: attr("content-desc"),
      bounds,
      tapX: Math.round((x1 + x2) / 2),
      tapY: Math.round((y1 + y2) / 2),
      clickable: attr("clickable") === "true",
    })
  }

  return elements
}

async function dumpUiXml(serial: string): Promise<string> {
  const tmpPath = `/sdcard/.ui_dump_${Date.now()}_${Math.random().toString(36).slice(2)}.xml`
  const raw = await execAdbShell(
    serial,
    `uiautomator dump --compressed ${tmpPath} 2>/dev/null; cat ${tmpPath}; rm -f ${tmpPath}`
  )
  // Strip the trailing status line uiautomator appends (e.g. "UI hierchary dumped to: ...")
  return raw.replace(/UI hier[^\n]*dumped to:[^\n]*/gi, "").trim()
}

export function registerUiTools(server: McpServer): void {
  server.registerTool(
    "ui_dump",
    {
      description: "Dump the full UI hierarchy of the current screen as XML. Useful for understanding screen structure before using ui_find_element.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        xml: z.string().describe("The UI hierarchy as a uiautomator XML document"),
      },
      annotations: {
        title: "Dump UI Hierarchy",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        const xml = await dumpUiXml(s)
        return {
          content: [{ type: "text", text: xml }],
          structuredContent: { xml },
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "ui_find_element",
    {
      description: "Find UI elements on screen by text, resource ID, class name, or content description. Returns matching elements with their tap coordinates. At least one search criterion must be provided.",
      inputSchema: {
        text: z.string().optional().describe("Text content to search for (partial match, case-insensitive)"),
        resourceId: z.string().optional().describe("Resource ID to match exactly (e.g., 'com.app:id/button')"),
        className: z.string().optional().describe("Class name to match exactly (e.g., 'android.widget.Button')"),
        contentDesc: z.string().optional().describe("Content description to search for (partial match, case-insensitive)"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        count: z.number().int().describe("Number of matching elements"),
        elements: z.array(
          z.object({
            text: z.string().describe("Visible text of the element"),
            resourceId: z.string().describe("Resource ID of the element"),
            className: z.string().describe("Widget class name"),
            contentDesc: z.string().describe("Content description (accessibility label)"),
            bounds: z.string().describe("Raw bounds string [x1,y1][x2,y2]"),
            tapX: z.number().int().describe("X coordinate of the element center"),
            tapY: z.number().int().describe("Y coordinate of the element center"),
            clickable: z.boolean().describe("Whether the element is clickable"),
          })
        ).describe("Matching UI elements with tap coordinates"),
      },
      annotations: {
        title: "Find UI Element",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ text, resourceId, className, contentDesc, serial }) => {
      try {
        if (!text && !resourceId && !className && !contentDesc) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: true, message: "At least one search criterion must be provided" }),
            }],
            isError: true as const,
          }
        }

        const s = await resolveSerial(serial)
        const xml = await dumpUiXml(s)
        let results = parseUiNodes(xml)

        if (text) {
          const lower = text.toLowerCase()
          results = results.filter((el) => el.text.toLowerCase().includes(lower))
        }
        if (resourceId) {
          results = results.filter((el) => el.resourceId === resourceId)
        }
        if (className) {
          results = results.filter((el) => el.className === className)
        }
        if (contentDesc) {
          const lower = contentDesc.toLowerCase()
          results = results.filter((el) => el.contentDesc.toLowerCase().includes(lower))
        }

        const structured = { count: results.length, elements: results }
        return {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
          isError: true as const,
        }
      }
    }
  )
}
