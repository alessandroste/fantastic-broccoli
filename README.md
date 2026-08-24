# Hermes Desktop Windows wrapper

This repository builds the official Hermes Electron Desktop application from a
pinned `NousResearch/hermes-agent` Git submodule plus a wrapper-owned patch
series under `patches\`. The upstream checkout remains clean and sparse: only
`apps/desktop`, `apps/shared`, and the root npm manifests are present.

## Requirements

- Windows x64 or ARM64
- Git with partial-clone and sparse-checkout support
- Node 22.22 or newer and a supported npm version

The tested host uses Node 26.7.0 ARM64 and npm 11.19.0. No Python installation
is needed to build or launch the remote-connected Desktop client.

## Commands

```powershell
npm run setup          # initialize/repair the sparse submodule and dependencies
npm run build          # build the current host architecture
npm run build:x64      # build one no-install x64 portable executable
npm run build:arm64    # build one no-install ARM64 portable executable
npm run build:all      # build x64, then ARM64
npm start              # build if stale, then launch the native artifact
npm run update         # build and pin the newest stable vYYYY.M.D tag
npm run validate       # validate both published artifacts and hashes
```

Every build applies `patches\*.patch` in lexical order, records each relative
path and SHA-256 in the artifact manifest, and reverses the series in a
`finally` block. A failed build therefore leaves the pinned submodule clean.
Validation rejects an artifact built with a different patch set.

An ARM64 Windows host can cross-build x64. The wrapper reinstalls the selected
workspace dependencies for x64, verifies that Electron and every packaged
native `.node` module use PE/COFF machine `0x8664`, then packages with
electron-builder's x64 target. ARM64 uses machine `0xAA64`. A mismatch is a
hard failure.

electron-builder 26.15.3's portable NSIS template does not handle a sole
`APP_DIR_ARM64` input in direct-file mode. The wrapper applies an idempotent
patch to the installed `app-builder-lib` template and uses that mode to embed
and extract the ARM64 app directory without its failing architecture/archive
probe. This changes only generated `node_modules`, never the pinned Hermes
submodule.

## Portable executables

Outputs are under `artifacts\<tag>\<arch>\`:

```text
Hermes-<version>-win-<arch>.exe
Hermes-<version>-win-<arch>.exe.sha256
manifest.json
```

Each `.exe` is a self-extracting electron-builder `portable` target. It does
not install Hermes, add an uninstaller, or require administrator rights. At
launch through `npm start` it extracts the Electron application to a unique
wrapper-owned `.wrapper\runtime` directory, runs it, and removes that exact
directory with retries after exit. Directly double-clicking the executable uses
the normal `%TEMP%` location instead. This makes startup slower than an unpacked
app. Locally built unsigned files may trigger Windows SmartScreen.

`npm start` sets `HERMES_HOME` to `%USERPROFILE%\.hermes` and
`HERMES_DESKTOP_USER_DATA_DIR` to
`%USERPROFILE%\.hermes\desktop-user-data`, preserving the existing Hermes,
OAuth, and remote gateway state. The command stays open while Hermes runs.
It snapshots any existing `hermes://` registration before launch and restores
it after exit; when no handler existed, it removes the temporary extracted-app
registration after exit.

## Updating upstream

`npm run update` considers only stable `vYYYY.M.D` tags and resolves annotated
tags to their peeled commits. It builds and validates both architectures before
writing `upstream.json` or activating artifacts. On success, review and commit
both the `upstream.json` change and the `upstream/hermes-agent` gitlink change.
CI always builds that committed gitlink; it never selects "latest" at build
time.

Sparse patterns are local Git worktree settings and cannot be fully stored in
`.gitmodules`. `npm run setup` is therefore the authoritative initializer and
repair command.

Wrapper-specific Hermes changes belong in the patch series, not as a dirty
submodule. To refresh a patch after editing the sparse checkout, capture the
diff before running any wrapper command (setup forcibly restores the pinned
commit):

```powershell
New-Item -ItemType Directory -Force patches | Out-Null
cmd /c "git -C upstream\hermes-agent diff --binary > patches\001-desktop-remote-client.patch"
$changed = git -C upstream\hermes-agent diff --name-only
git -C upstream\hermes-agent restore --worktree -- $changed
git -C upstream\hermes-agent status --short  # must be empty
```

When `npm run update` advances the pinned tag, the candidate build applies the
same series to the new commit. A patch that no longer applies aborts the update
transaction so it can be rebased deliberately instead of silently omitted.

## Releases and versioning

The GitHub Actions workflow starts when a matching release tag is pushed or
through a manual `workflow_dispatch`. Ordinary branch pushes and pull requests
never start builds. Release versions use the pinned upstream tag plus a wrapper
revision:

```text
upstream v2026.8.19 + revision 1 -> v2026.8.19-r1
upstream v2026.8.19 + revision 2 -> v2026.8.19-r2
upstream v2026.9.2  + revision 1 -> v2026.9.2-r1
```

Increment the revision when wrapper code or patches change without moving
upstream. Reset it to `1` after `npm run update` advances the upstream tag.
The tag must match the current `upstream.json` value exactly:

```powershell
git tag -a v2026.8.19-r1 -m "Hermes Desktop v2026.8.19-r1"
git push origin v2026.8.19-r1
```

Pushing the tag publishes the release automatically. Alternatively, run
**Release Windows portable apps** from the Actions tab and enter the revision;
the manual workflow creates the tag and can create the release as a draft
(the default). Existing release tags are rejected rather than overwritten.

The workflow builds x64 on `windows-2025` and ARM64 on
`windows-11-vs2026-arm`, validates both packages, then creates a GitHub Release.
It can create the release as a draft (the default) or publish immediately.
Release assets contain only the two versioned portable executables, their
individual checksum files, and `SHA256SUMS.txt`:

```text
Hermes-2026.8.19-r1-win-x64.exe
Hermes-2026.8.19-r1-win-x64.exe.sha256
Hermes-2026.8.19-r1-win-arm64.exe
Hermes-2026.8.19-r1-win-arm64.exe.sha256
SHA256SUMS.txt
```

Provenance manifests remain internal 14-day workflow artifacts used for
validation; they are not attached to GitHub Releases. Node is pinned to 26.7.0
and third-party actions are pinned to full commit SHAs. Builds are pinned and
repeatable, but upstream build timestamps mean the portable executable is not
promised to be byte-for-byte reproducible.

## Reset and rollback

Generated dependencies, caches, and artifacts can be reset without touching
Hermes user data:

```powershell
Remove-Item -Recurse -Force .wrapper, artifacts
Remove-Item -Recurse -Force upstream\hermes-agent\node_modules
npm run setup
```

Do not delete `%USERPROFILE%\.hermes`. During the initial migration, the prior
direct checkout is retained as `D:\hermes-dektop-upstream-backup`; restoring it
only requires closing Hermes and swapping the two sibling directory names.
