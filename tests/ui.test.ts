import { describe, it, expect } from "vitest"
import { parseUiNodes } from "../src/tools/ui.js"

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Login" resource-id="com.example.app:id/btn_login" class="android.widget.Button" package="com.example.app" content-desc="Login button" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[360,1140][720,1260]" />
    <node index="1" text="Username" resource-id="com.example.app:id/input_user" class="android.widget.EditText" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[60,800][1020,900]" />
    <node index="2" text="" resource-id="" class="android.widget.ImageView" package="com.example.app" content-desc="Company logo" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[440,200][640,400]" />
  </node>
</hierarchy>`

describe("parseUiNodes", () => {
  it("parses all nodes from the hierarchy", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    expect(nodes.length).toBe(4) // root + 3 children
  })

  it("extracts text attribute", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    expect(nodes.find((n) => n.text === "Login")).toBeDefined()
    expect(nodes.find((n) => n.text === "Username")).toBeDefined()
  })

  it("extracts resource-id into resourceId field", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    const btn = nodes.find((n) => n.text === "Login")
    expect(btn?.resourceId).toBe("com.example.app:id/btn_login")
  })

  it("extracts class into className field", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    const btn = nodes.find((n) => n.text === "Login")
    expect(btn?.className).toBe("android.widget.Button")
  })

  it("extracts content-desc into contentDesc field", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    const logo = nodes.find((n) => n.contentDesc === "Company logo")
    expect(logo).toBeDefined()
  })

  it("computes tap coordinates as center of bounds", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    // bounds="[360,1140][720,1260]" → tapX=540, tapY=1200
    const btn = nodes.find((n) => n.text === "Login")
    expect(btn?.tapX).toBe(540)
    expect(btn?.tapY).toBe(1200)
  })

  it("computes tap coordinates correctly for a non-square bounds", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    // bounds="[60,800][1020,900]" → tapX=540, tapY=850
    const input = nodes.find((n) => n.text === "Username")
    expect(input?.tapX).toBe(540)
    expect(input?.tapY).toBe(850)
  })

  it("extracts clickable attribute", () => {
    const nodes = parseUiNodes(SAMPLE_XML)
    const btn = nodes.find((n) => n.text === "Login")
    const logo = nodes.find((n) => n.contentDesc === "Company logo")
    expect(btn?.clickable).toBe(true)
    expect(logo?.clickable).toBe(false)
  })

  it("returns empty array for empty or invalid XML", () => {
    expect(parseUiNodes("")).toHaveLength(0)
    expect(parseUiNodes("not xml at all")).toHaveLength(0)
  })

  it("skips nodes without valid bounds", () => {
    const xml = `<hierarchy><node text="bad" bounds="invalid" class="X" resource-id="" content-desc="" clickable="false" /></hierarchy>`
    expect(parseUiNodes(xml)).toHaveLength(0)
  })
})

describe("ui_find_element filtering logic", () => {
  const nodes = parseUiNodes(SAMPLE_XML)

  it("filters by text (partial, case-insensitive)", () => {
    const results = nodes.filter((el) => el.text.toLowerCase().includes("login"))
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe("Login")
  })

  it("filters by resourceId (exact match)", () => {
    const results = nodes.filter((el) => el.resourceId === "com.example.app:id/btn_login")
    expect(results).toHaveLength(1)
  })

  it("filters by className (exact match)", () => {
    const results = nodes.filter((el) => el.className === "android.widget.Button")
    expect(results).toHaveLength(1)
  })

  it("filters by contentDesc (partial, case-insensitive)", () => {
    const results = nodes.filter((el) => el.contentDesc.toLowerCase().includes("logo"))
    expect(results).toHaveLength(1)
    expect(results[0].contentDesc).toBe("Company logo")
  })

  it("returns no results when criteria match nothing", () => {
    const results = nodes.filter((el) => el.text.toLowerCase().includes("nonexistent"))
    expect(results).toHaveLength(0)
  })

  it("applies multiple criteria as AND", () => {
    // Button with text "Login" AND class "android.widget.Button"
    const results = nodes
      .filter((el) => el.text.toLowerCase().includes("login"))
      .filter((el) => el.className === "android.widget.Button")
    expect(results).toHaveLength(1)

    // EditText with text "Login" — no match (Login is a Button, not EditText)
    const noMatch = nodes
      .filter((el) => el.text.toLowerCase().includes("login"))
      .filter((el) => el.className === "android.widget.EditText")
    expect(noMatch).toHaveLength(0)
  })
})
