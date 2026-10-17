# Hermes Desktop Windows wrapper

This repository builds the official Hermes Electron Desktop application from a
pinned `NousResearch/hermes-agent` Git submodule. The upstream checkout remains
clean and sparse.

## Requirements

- Windows x64 or ARM64
- Git with partial-clone and sparse-checkout support
- Node 22.22 or newer and a supported npm version

## Commands

```powershell
npm run setup          # initialize/repair the sparse submodule and dependencies
npm run build          # build the current host architecture
npm run build:x64      # build one no-install x64 ZIP
npm run build:arm64    # build one no-install ARM64 ZIP
npm run build:all      # build x64, then ARM64
npm start              # build if stale, then launch the native artifact
npm run update         # build and pin the newest stable tag
npm run validate       # validate both published artifacts and hashes
```

An ARM64 Windows host can cross-build x64. The wrapper reinstalls
dependencies for x64, verifies that Electron and every packaged
native `.node` module use PE/COFF machine `0x8664`, then packages with
electron-builder's x64 target. ARM64 uses machine `0xAA64`. A mismatch is a
hard failure.

## Portable archives

Outputs are under `artifacts\<tag>\<arch>\`:

```text
Hermes-<version>-win-<arch>.zip
Hermes-<version>-win-<arch>.zip.sha256
manifest.json
unpacked\Hermes.exe
```

Run `unpacked\Hermes.exe`, or extract the ZIP; no installer or administrator rights
are needed. `npm start` extracts it with Windows `tar.exe` into `.wrapper\runtime`
and removes that directory after exit. Unsigned files may trigger SmartScreen.

`npm start` sets `HERMES_HOME` to `%USERPROFILE%\.hermes` and
`HERMES_DESKTOP_USER_DATA_DIR` to
`%USERPROFILE%\.hermes\desktop-user-data`, preserving the existing Hermes,
OAuth, and remote gateway state. The command stays open while Hermes runs.
It snapshots any existing `hermes://` registration before launch and restores
it after exit; when no handler existed, it removes the temporary extracted-app
registration after exit.

## Updating upstream

`npm run update` considers stable version tags and resolves annotated
tags to their peeled commits. It builds and validates both architectures before
writing `upstream.json` or activating artifacts. On success, review and commit
both the `upstream.json` change and the `upstream/hermes-agent` gitlink change.
CI always builds that committed gitlink; it never selects "latest" at build
time.

Sparse patterns are local Git worktree settings and cannot be fully stored in
`.gitmodules`. `npm run setup` is therefore the authoritative initializer and
repair command. Build commands also initialize the submodule and install the
target dependencies as needed.

Hermes source changes should be contributed upstream rather than stored as
submodule modifications. Wrapper-specific build and packaging behavior belongs
in `scripts\wrapper.mjs`.

## Releases and versioning

The GitHub Actions workflow starts when a matching release tag is pushed or
through a manual `workflow_dispatch`. Ordinary branch pushes and pull requests
never start builds. Release versions use the pinned upstream tag plus a wrapper
revision.

Increment the revision when wrapper code changes without moving upstream. Reset
it to `1` after `npm run update` advances the upstream tag. The tag must match
the current `upstream.json` value exactly.

Pushing the tag publishes the release automatically. Alternatively, run
**Release Windows portable apps** from the Actions tab and enter the revision;
the manual workflow creates the tag and can create the release as a draft
(the default). Existing release tags are rejected rather than overwritten.

The workflow builds x64 on `windows-2025` and ARM64 on
`windows-11-vs2026-arm`, validates both packages, then creates a GitHub Release.
It can create the release as a draft (the default) or publish immediately.
Release assets contain only the two versioned portable ZIPs, their
individual checksum files, and `SHA256SUMS.txt`.

Provenance manifests remain internal 14-day workflow artifacts used for
validation; they are not attached to GitHub Releases. Node is pinned to 26.7.0
and third-party actions are pinned to full commit SHAs. Builds are pinned and
repeatable, but upstream build timestamps mean the portable archive is not
promised to be byte-for-byte reproducible.

## Reset and rollback

Generated dependencies, caches, and artifacts can be reset without touching
Hermes user data:

```powershell
Remove-Item -Recurse -Force .wrapper, artifacts
Remove-Item -Recurse -Force upstream\hermes-agent\node_modules
npm run setup
```

Do not delete `%USERPROFILE%\.hermes`.
