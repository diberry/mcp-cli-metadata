# mcp-cli-metadata

Version snapshots for Azure MCP CLI tool metadata.

## Contents

- **Per-version directories** (for example, `3.0.0-beta.44+.../`) - read-only historical snapshots.
- **`config/brand-to-server-mapping.json`** - namespace display names and file mappings used to create each snapshot.
- **`tracked-version.txt`** - the currently tracked `@azure/mcp` release version.

## CLI Metadata Extraction

`create-version-snapshot.js` invokes the `azmcp` binary provided by the local
`@azure/mcp` dependency. It captures the CLI version, full tool list, namespace
list, and a namespace-to-tool mapping.

## Create a version snapshot

Install dependencies and run:

```bash
npm ci
npm run snapshot
```

The command creates a directory named with the full CLI version. The directory
contains `cli-version.json`, `cli-output.json`, `cli-namespace.json`, and
`namespace-mapping.json`. It also updates `tracked-version.txt` with the release
version without the build SHA suffix. The command fails instead of replacing an
existing version snapshot.

## Nightly updates

The `Update dependencies and snapshot` workflow runs nightly and can also be
started manually. It resolves every production dependency in `package.json` to
the npm `latest` distribution tag. When a dependency changes, the workflow:

1. Updates `package.json` and `package-lock.json`.
2. Runs the snapshot generator.
3. Creates a pull request containing all generated changes.
4. Squash-merges the pull request and deletes its branch.
