# Contributing

## Development

Node.js 24 or newer is required. [`.nvmrc`](.nvmrc) pins the version, and CI
reads that same file, so `nvm use` in the repo root puts you on exactly what
CI runs. `.npmrc` sets `engine-strict=true`, so `npm install` fails outright
on an older runtime rather than warning.

```bash
npm install
npm run build   # compile TypeScript → dist/
npm run lint    # eslint src (CI gates on this)
npm test        # unit tests
```

`npm run lint:fix` applies the fixes eslint can make on its own. During
development, `npx vitest` (without `run`) keeps the unit tests in watch mode.

### Integration tests

```bash
npm run test:integration
```

These drive a real Android device or emulator. They need `adb` and `scrcpy` on
`PATH`, and exactly one device connected with USB debugging enabled and the
connection authorized — `adb devices` must list it as `device`, not
`unauthorized` or `offline`. `scrcpy` is required for the whole suite, not just
the session tests: the session file starts a real scrcpy session and takes
screenshots through it. Screenshots decode via `ffmpeg`, which `npm install`
supplies through the optional `ffmpeg-static` dependency; if that dependency is
skipped, a system `ffmpeg` on `PATH` is used instead.

The suite changes device settings and restores them in a global teardown, so let
a run finish rather than killing it partway. CI runs the same suite against an
emulator on both scrcpy 3.3.4 and 4.1, the two sides of the wire-format branch
at scrcpy 4.0.

### Conventions

[AGENTS.md](AGENTS.md) documents the code style and project conventions this
repo follows — imports, formatting, error handling, the MCP tool registration
pattern, and the checks to run before committing. Read it before your first PR.

## Pull Requests

Open PRs against `main`. Keep changes focused — one concern per PR.

## Releasing

Releases are triggered automatically when a PR is merged into `main` with one of these labels:

| Label   | When to use |
|---------|-------------|
| `patch` | Bug fixes, small improvements (e.g. `1.2.3` → `1.2.4`) |
| `minor` | New backwards-compatible features (e.g. `1.2.3` → `1.3.0`) |
| `major` | Breaking changes (e.g. `1.2.3` → `2.0.0`) |

**PRs without a release label are not published.** Use this for docs, CI changes, refactors, or anything that shouldn't trigger a release.

Before merging a release PR, bump the version in `package.json` manually (e.g. `npm version patch --no-git-tag-version`). The workflow reads the version from `package.json` and will fail if the tag already exists.

When a labeled PR merges, the workflow will:

1. Read the version from `package.json`
2. Create and push a git tag (e.g. `v1.2.4`)
3. Publish to npm
4. Publish to the MCP Registry

### Emergency / manual release

If you need to trigger a publish outside a PR merge, go to **Actions → Publish → Run workflow**.
