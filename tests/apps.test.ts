import { describe, it, expect } from "vitest"
import { isValidPackageName, isUninstallSuccess } from "../src/tools/apps.js"

describe("isValidPackageName", () => {
  it("accepts standard dotted package names", () => {
    expect(isValidPackageName("com.example.app")).toBe(true)
    expect(isValidPackageName("org.test.package")).toBe(true)
    expect(isValidPackageName("com.google.android.gms")).toBe(true)
    expect(isValidPackageName("com.example.app2")).toBe(true)
    expect(isValidPackageName("com.example.my_app")).toBe(true)
  })

  it("rejects single-segment names (no dots)", () => {
    expect(isValidPackageName("foo")).toBe(false)
    expect(isValidPackageName("myapp")).toBe(false)
  })

  it("rejects names where a segment starts with a digit", () => {
    expect(isValidPackageName("com.1example.app")).toBe(false)
    expect(isValidPackageName("1abc.def.ghi")).toBe(false)
  })

  it("rejects empty segments (consecutive dots)", () => {
    expect(isValidPackageName("com..example")).toBe(false)
    expect(isValidPackageName(".com.example")).toBe(false)
    expect(isValidPackageName("com.example.")).toBe(false)
  })

  it("rejects empty string", () => {
    expect(isValidPackageName("")).toBe(false)
  })

  it("rejects names with shell-unsafe characters", () => {
    expect(isValidPackageName("com.example;rm -rf /")).toBe(false)
    expect(isValidPackageName("com.example app")).toBe(false)
    expect(isValidPackageName("com.example/app")).toBe(false)
    expect(isValidPackageName("com.example&app")).toBe(false)
  })
})

describe("app_uninstall success detection", () => {
  it("treats 'Success' output as success", () => {
    expect(isUninstallSuccess("Success")).toBe(true)
  })

  it("treats empty output as success (app may already be gone)", () => {
    expect(isUninstallSuccess("")).toBe(true)
  })

  it("treats 'Failure' prefix as failure", () => {
    expect(isUninstallSuccess("Failure")).toBe(false)
    expect(isUninstallSuccess("Failure [DELETE_FAILED_INTERNAL_ERROR]")).toBe(false)
  })

  it("treats DELETE_FAILED anywhere in output as failure", () => {
    expect(isUninstallSuccess("Exception occurred while executing:\nDELETE_FAILED_INTERNAL_ERROR")).toBe(false)
  })
})
