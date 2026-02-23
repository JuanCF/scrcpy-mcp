# Contributing

## Development

```bash
npm install
npm run build   # compile TypeScript → dist/
npx vitest      # run tests
```

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

When a labeled PR merges, the workflow will:

1. Bump the version in `package.json` according to the label
2. Commit the version bump to `main`
3. Create and push a git tag (e.g. `v1.2.4`)
4. Publish to npm
5. Publish to the MCP Registry

### Emergency / manual release

If you need to trigger a publish outside a PR merge, go to **Actions → Publish → Run workflow** and select the bump type.

## Publishing to Smithery

After a new version is released to npm, update the Smithery listing:

```bash
npm run publish:smithery
```
