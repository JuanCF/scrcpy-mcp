# AGENTS.md

Guidelines for AI coding agents working on scrcpy-mcp.

## Project Overview

scrcpy-mcp is a Model Context Protocol (MCP) server that provides AI agents with vision and control over Android devices via ADB and scrcpy. It exposes tools for device management, input, screenshots, and more.

## Project Documentation

- **ROADMAP.md** - Implementation roadmap with phases and milestones
- **PLAN.md** - Detailed implementation plan with architecture and tool specifications

## Build/Lint/Test Commands

```bash
# Build the project
npm run build

# Development mode (run directly with tsx)
npm run dev

# Run the built server
npm start

# Run MCP Inspector for testing
npm run inspect

# Lint check
npm run lint

# Lint with auto-fix
npm run lint:fix

# Type check
npx tsc --noEmit

# Run all tests
npm run test

# Run integration tests only
npm run test:integration

# Run a single test file
npx vitest run tests/example.test.ts

# Run tests matching a pattern
npx vitest run --testNamePattern "device"
```

## Project Structure

```text
src/
├── index.ts           # Entry point, server setup, tool registration
├── utils/
│   └── adb.ts         # ADB utility functions (exec, device detection, etc.)
└── tools/
    ├── device.ts      # Device management tools
    ├── input.ts       # Touch/keyboard input tools
    └── vision.ts      # Screenshot and recording tools
```

## Code Style Guidelines

### Imports

- Use ESM imports with `.js` extension for local modules (required by Node16 moduleResolution)
- Group imports: external packages first, then local modules
- Import from specific SDK paths: `@modelcontextprotocol/sdk/server/mcp.js`

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execAdbShell, resolveSerial } from "../utils/adb.js";
```

### Formatting

- No semicolons at end of statements
- 2-space indentation, max line length ~100 characters
- Trailing commas in multiline arrays/objects

### Types

- Use TypeScript strict mode
- Define interfaces for complex objects, `type` for unions/aliases
- Prefer `interface` for object shapes, `const` for constant objects

```typescript
interface DeviceInfo {
  serial: string;
  state: "device" | "unauthorized" | "offline" | string;
  model?: string;
}

type Keycode = string | number;
```

### Naming Conventions

- **Variables/functions:** camelCase (`execAdb`, `resolveSerial`)
- **Interfaces/types:** PascalCase (`DeviceInfo`, `ExecResult`)
- **Constants:** UPPER_SNAKE_CASE (`KEYCODE_MAP`, `DEFAULT_TIMEOUT`)
- **Files:** lowercase (`device.ts`, `adb.ts`)
- **Tool names:** snake_case (`device_list`, `screen_on`)

### Function Style

- Prefer `async/await` over raw promises
- Arrow functions for callbacks, named declarations for exported utilities
- Use early returns to reduce nesting

### Error Handling

- Throw `Error` objects with descriptive messages including context (command, device serial, etc.)
- Use `{ cause }` option to preserve error chain
- Return error info in tool responses rather than throwing for user-facing errors

```typescript
throw new Error(
  `ADB command failed: ${ADB_PATH} ${args.join(" ")}\n${err.stderr || err.message}`,
  { cause: error }
);
```

### MCP Tool Registration Pattern

```typescript
server.registerTool(
  "tool_name",
  {
    description: "Description of what the tool does",
    inputSchema: {
      param: z.string().optional().describe("Parameter description"),
      required: z.number().describe("Required parameter"),
    },
  },
  async ({ param, required }) => {
    const result = await doWork(param, required);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);
```

### Zod Schema Patterns

- Use `.optional()` for optional params, `.describe()` for documentation
- Use `.default()` for defaults, `.int().nonnegative()` for coordinates

```typescript
{
  x: z.number().int().nonnegative().describe("X coordinate"),
  serial: z.string().optional().describe("Device serial number"),
  duration: z.number().int().positive().optional().default(300),
}
```

### Environment Variables

- `ADB_PATH`: Custom ADB binary path (default: "adb")
- `ANDROID_SERIAL`: Default device serial

### Comments

- Avoid comments unless code is genuinely complex
- Use `console.error()` for server-side logging (stderr, not MCP protocol)

## Key Implementation Notes

### ADB Utilities (`src/utils/adb.ts`)

- `execAdb()`: Run adb command, returns `{ stdout, stderr }`
- `execAdbRaw()`: Run adb command, returns `Buffer` (binary data)
- `execAdbShell()`: Run `adb -s <serial> shell <command>`
- `resolveSerial()`: Auto-detect device or validate provided serial
- `getDevices()`: Parse `adb devices -l` output

### Tool Response Format

```typescript
{
  content: [
    { type: "text", text: "..." } |
    { type: "image", data: base64, mimeType: "image/png" }
  ]
}
```

## Before Committing

1. Run `npm run lint` and fix any issues
2. Run `npm run build` to ensure it compiles
3. Run `npm run test` to verify tests pass
4. Test with `npm run inspect` if making tool changes
