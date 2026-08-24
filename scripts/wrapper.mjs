#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = path.join(ROOT, 'upstream', 'hermes-agent')
const DESKTOP = path.join(UPSTREAM, 'apps', 'desktop')
const STATE = path.join(ROOT, '.wrapper')
const STATE_FILES = path.join(STATE, 'state')
const BUILD_ROOT = path.join(STATE, 'build')
const NPM_CACHE = path.join(STATE, 'npm-cache')
const ARTIFACTS = path.join(ROOT, 'artifacts')
const PATCHES = path.join(ROOT, 'patches')
const UPSTREAM_METADATA = path.join(ROOT, 'upstream.json')
const SUBMODULE_PATH = 'upstream/hermes-agent'
const UPSTREAM_URL = 'https://github.com/NousResearch/hermes-agent.git'
const SPARSE_PATTERNS = [
  '/apps/desktop/',
  '/apps/shared/',
  '/package.json',
  '/package-lock.json',
  '/.npmrc'
]
const TARGETS = new Set(['x64', 'arm64'])
const PE_MACHINES = {
  x64: 0x8664,
  arm64: 0xaa64
}

function fail(message) {
  throw new Error(message)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function removeRuntimeDir(dir) {
  let lastError = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      removeDir(dir)
      return
    } catch (error) {
      lastError = error
      await sleep(500)
    }
  }
  throw lastError
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    timeout: options.timeout
  })

  if (result.error) {
    if (!options.allowFailure) {
      fail(`${command} could not start: ${result.error.message}`)
    }
    return result
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : ''
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`)
  }

  return result
}

function output(command, args, options = {}) {
  return run(command, args, { ...options, capture: true }).stdout.trim()
}

function git(args, options = {}) {
  return run('git', args, options)
}

function gitOutput(args, options = {}) {
  return output('git', args, options)
}

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean)
  const cli = candidates.find(candidate => fs.existsSync(candidate))
  if (!cli) {
    fail('Could not resolve npm-cli.js from the active Node installation.')
  }
  return cli
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli(), ...args], options)
}

function npmOutput(args, options = {}) {
  return output(process.execPath, [npmCli(), ...args], options)
}

function requireWindows() {
  if (process.platform !== 'win32') {
    fail(`Windows builds require win32; current platform is ${process.platform}.`)
  }
}

function requireTarget(raw = process.arch) {
  const target = String(raw || '')
  if (!TARGETS.has(target)) {
    fail(`Unsupported Windows architecture "${target}". Expected x64 or arm64.`)
  }
  return target
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

function sourcePatchManifest() {
  if (!fs.existsSync(PATCHES)) {
    return []
  }

  return fs
    .readdirSync(PATCHES, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.patch'))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map(name => {
      const file = path.join(PATCHES, name)
      if (fs.statSync(file).size === 0) {
        fail(`Source patch is empty: ${file}`)
      }
      return {
        file: path.relative(ROOT, file).replaceAll(path.sep, '/'),
        sha256: sha256File(file)
      }
    })
}

function patchFile(record) {
  return path.join(ROOT, ...record.file.split('/'))
}

function restoreSourcePatches(records) {
  for (const record of [...records].reverse()) {
    const file = patchFile(record)
    git(['-C', UPSTREAM, 'apply', '--reverse', '--index', '--check', '--whitespace=nowarn', '--', file])
    git(['-C', UPSTREAM, 'apply', '--reverse', '--index', '--whitespace=nowarn', '--', file])
  }
}

function applySourcePatches() {
  const records = sourcePatchManifest()
  const applied = []

  try {
    for (const record of records) {
      const file = patchFile(record)
      git(['-C', UPSTREAM, 'apply', '--index', '--check', '--whitespace=error-all', '--', file])
      git(['-C', UPSTREAM, 'apply', '--index', '--whitespace=error-all', '--', file])
      applied.push(record)
      console.log(`[wrapper] Applied ${record.file} (${record.sha256.slice(0, 12)}).`)
    }
  } catch (error) {
    restoreSourcePatches(applied)
    throw error
  }

  return {
    records,
    restore() {
      restoreSourcePatches(applied)
      if (applied.length > 0) {
        console.log('[wrapper] Restored clean pinned submodule after patched build.')
      }
    }
  }
}

function manifestMatchesPatchSet(manifest, patches = sourcePatchManifest()) {
  return sameJson(manifest?.source?.patches ?? [], patches)
}

function submoduleGitlink() {
  const line = gitOutput(['-C', ROOT, 'ls-files', '--stage', '--', SUBMODULE_PATH])
  const match = /^160000 ([0-9a-f]{40}) 0\t/.exec(line)
  if (!match) {
    fail(`The wrapper index does not contain the ${SUBMODULE_PATH} submodule gitlink.`)
  }
  return match[1]
}

function currentUpstreamCommit() {
  return gitOutput(['-C', UPSTREAM, 'rev-parse', 'HEAD'])
}

function ensureSparseCheckout(options = {}) {
  git(['-C', UPSTREAM, 'sparse-checkout', 'init', '--no-cone'])
  git(['-C', UPSTREAM, 'sparse-checkout', 'set', '--no-cone', ...SPARSE_PATTERNS])

  if (options.verify === false) {
    return
  }

  const required = [
    path.join(UPSTREAM, 'package.json'),
    path.join(UPSTREAM, 'package-lock.json'),
    path.join(UPSTREAM, '.npmrc'),
    path.join(DESKTOP, 'package.json'),
    path.join(UPSTREAM, 'apps', 'shared', 'package.json')
  ]
  for (const file of required) {
    if (!fs.existsSync(file)) {
      fail(`Sparse checkout is missing required file: ${file}`)
    }
  }

  for (const omitted of ['web', 'ui-tui', 'tests-js']) {
    if (fs.existsSync(path.join(UPSTREAM, omitted))) {
      fail(`Sparse checkout unexpectedly contains omitted workspace: ${omitted}`)
    }
  }
}

function ensureSubmodule() {
  const expectedCommit = submoduleGitlink()
  const gitMarker = path.join(UPSTREAM, '.git')

  git(['-C', ROOT, 'submodule', 'init', '--', SUBMODULE_PATH])

  if (!fs.existsSync(gitMarker)) {
    if (fs.existsSync(UPSTREAM)) {
      const entries = fs.readdirSync(UPSTREAM)
      if (entries.length > 0) {
        fail(`Cannot initialize submodule into non-empty directory: ${UPSTREAM}`)
      }
      fs.rmdirSync(UPSTREAM)
    }

    ensureDir(path.dirname(UPSTREAM))
    git([
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--no-tags',
      '--depth=1',
      UPSTREAM_URL,
      UPSTREAM
    ])
  }

  ensureSparseCheckout({ verify: false })

  const hasCommit = run(
    'git',
    ['-C', UPSTREAM, 'cat-file', '-e', `${expectedCommit}^{commit}`],
    { allowFailure: true, capture: true }
  ).status === 0
  if (!hasCommit) {
    git(['-C', UPSTREAM, 'fetch', '--depth=1', 'origin', expectedCommit])
  }

  git(['-C', UPSTREAM, 'checkout', '--detach', '--force', expectedCommit])
  ensureSparseCheckout()
  git(['-C', ROOT, 'submodule', 'absorbgitdirs', '--', SUBMODULE_PATH])

  const actualCommit = currentUpstreamCommit()
  if (actualCommit !== expectedCommit) {
    fail(`Submodule checkout mismatch: expected ${expectedCommit}, got ${actualCommit}.`)
  }

  const metadata = readJson(UPSTREAM_METADATA)
  if (metadata.commit !== expectedCommit) {
    fail(
      `upstream.json pins ${metadata.commit}, but the wrapper gitlink pins ${expectedCommit}. ` +
        'Commit both files together.'
    )
  }

  console.log(`[wrapper] Hermes submodule ready at ${expectedCommit.slice(0, 12)} (${metadata.tag}).`)
  return metadata
}

function readPeMachine(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const dos = Buffer.alloc(64)
    if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
      fail(`${file} is not a PE executable (missing MZ header).`)
    }
    const peOffset = dos.readUInt32LE(0x3c)
    const header = Buffer.alloc(6)
    if (fs.readSync(fd, header, 0, header.length, peOffset) !== header.length) {
      fail(`${file} has a truncated PE header.`)
    }
    if (header.toString('ascii', 0, 4) !== 'PE\u0000\u0000') {
      fail(`${file} has an invalid PE signature.`)
    }
    return header.readUInt16LE(4)
  } finally {
    fs.closeSync(fd)
  }
}

function assertPeArch(file, arch) {
  const actual = readPeMachine(file)
  const expected = PE_MACHINES[arch]
  if (actual !== expected) {
    fail(
      `${file} has PE machine 0x${actual.toString(16)}, expected ${arch} ` +
        `(0x${expected.toString(16)}).`
    )
  }
}

function resolvePackageRoot(packageName) {
  const requireFromDesktop = createRequire(path.join(DESKTOP, 'package.json'))
  return path.dirname(requireFromDesktop.resolve(`${packageName}/package.json`))
}

function electronExe() {
  return path.join(resolvePackageRoot('electron'), 'dist', 'electron.exe')
}

function patchPortableNsisTemplate() {
  const appBuilderRoot = resolvePackageRoot('app-builder-lib')
  const template = path.join(appBuilderRoot, 'templates', 'nsis', 'portable.nsi')
  const marker = '# HERMES_WRAPPER_ARM64_DIRECT'
  const source = fs.readFileSync(template, 'utf8')
  if (source.includes(marker)) {
    return
  }

  const startAnchor = '  SetOutPath $INSTDIR'
  const stockBlockAnchor = '  !ifdef APP_DIR_64'
  const endAnchor =
    '  System::Call \'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0\''
  if (
    !source.includes(startAnchor) ||
    !source.includes(stockBlockAnchor) ||
    !source.includes(endAnchor)
  ) {
    fail(
      `electron-builder's portable NSIS template changed at ${template}; ` +
        'review the ARM64-only extraction patch before building.'
    )
  }

  // With portable.useZip enabled electron-builder defines APP_DIR_ARM64 and
  // expects portable.nsi to embed that directory directly. Its stock template
  // only checks APP_DIR_ARM64 inside APP_DIR_64, so an ARM64-only build falls
  // through to an empty archive extraction. Handle the sole available app
  // directory and compile out the stock architecture/archive block.
  const extraction = `${startAnchor}

  ${marker}
  !ifdef APP_DIR_ARM64
    !ifndef APP_DIR_64
      !ifndef APP_DIR_32
        !define HERMES_WRAPPER_ARM64_DIRECT_ACTIVE
        File /r "\${APP_DIR_ARM64}\\*.*"
      !endif
    !endif
  !endif`
  const wrappedStockBlock = `  !ifndef HERMES_WRAPPER_ARM64_DIRECT_ACTIVE
${stockBlockAnchor}`
  const endWrappedStockBlock = `  !endif

${endAnchor}`

  fs.writeFileSync(
    template,
    source
      .replace(startAnchor, extraction)
      .replace(stockBlockAnchor, wrappedStockBlock)
      .replace(endAnchor, endWrappedStockBlock),
    'utf8'
  )
  console.log('[wrapper] Patched electron-builder portable NSIS template for direct ARM64 extraction.')
}

function dependencyFingerprint(arch) {
  return {
    arch,
    commit: currentUpstreamCommit(),
    lockfileSha256: sha256File(path.join(UPSTREAM, 'package-lock.json')),
    node: process.version,
    npm: npmOutput(['--version']),
    platform: process.platform,
    sourcePatches: sourcePatchManifest()
  }
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function targetNpmEnvironment(arch) {
  return {
    ...process.env,
    npm_config_arch: arch,
    npm_config_platform: 'win32',
    npm_config_target_arch: arch,
    npm_config_target_platform: 'win32',
    npm_config_cache: NPM_CACHE
  }
}

function ensureDependencies(arch) {
  requireWindows()
  const target = requireTarget(arch)
  const fingerprint = dependencyFingerprint(target)
  const stateFile = path.join(STATE_FILES, 'dependencies.json')
  let reusable = false

  if (fs.existsSync(stateFile)) {
    try {
      reusable = sameJson(readJson(stateFile), fingerprint)
      if (reusable) {
        assertPeArch(electronExe(), target)
      }
    } catch {
      reusable = false
    }
  }

  if (!reusable) {
    console.log(`[wrapper] Installing locked Hermes Desktop dependencies for win32-${target}...`)
    ensureDir(NPM_CACHE)
    runNpm(
      [
        'ci',
        '--workspace',
        'hermes',
        '--workspace',
        '@hermes/shared',
        '--include-workspace-root',
        '--no-audit',
        '--no-fund'
      ],
      {
        cwd: UPSTREAM,
        env: targetNpmEnvironment(target)
      }
    )
    assertPeArch(electronExe(), target)
    writeJsonAtomic(stateFile, fingerprint)
  } else {
    console.log(`[wrapper] Reusing locked win32-${target} dependencies.`)
  }

  return fingerprint
}

function assertCleanUpstream() {
  const status = gitOutput(['-C', UPSTREAM, 'status', '--porcelain=v1', '--untracked-files=no'])
  if (status) {
    fail(`The Hermes submodule has tracked modifications:\n${status}`)
  }
}

function walkFiles(root, predicate) {
  const matches = []
  if (!fs.existsSync(root)) {
    return matches
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      matches.push(...walkFiles(full, predicate))
    } else if (predicate(full, entry.name)) {
      matches.push(full)
    }
  }
  return matches
}

function findUnpackedDir(outputDir) {
  const match = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^win.*-unpacked$/.test(entry.name))
    .map(entry => path.join(outputDir, entry.name))
  if (match.length !== 1) {
    fail(`Expected one unpacked Windows directory in ${outputDir}; found ${match.length}.`)
  }
  return match[0]
}

function findPortableExe(outputDir, unpackedDir) {
  const matches = walkFiles(
    outputDir,
    (full, name) =>
      full.indexOf(unpackedDir + path.sep) !== 0 &&
      /^Hermes-.*-win-(x64|arm64)\.exe$/i.test(name)
  )
  if (matches.length !== 1) {
    fail(`Expected one Hermes portable executable in ${outputDir}; found ${matches.length}.`)
  }
  return matches[0]
}

function validateBuildOutput({ arch, outputDir, release }) {
  const unpackedDir = findUnpackedDir(outputDir)
  const appExe = path.join(unpackedDir, 'Hermes.exe')
  const resources = path.join(unpackedDir, 'resources')
  const appAsar = path.join(resources, 'app.asar')
  const installStamp = path.join(resources, 'install-stamp.json')

  for (const required of [appExe, appAsar, installStamp]) {
    if (!fs.existsSync(required) || fs.statSync(required).size === 0) {
      fail(`Packaged build is missing required non-empty file: ${required}`)
    }
  }

  assertPeArch(appExe, arch)

  const nativeRoot = path.join(resources, 'app.asar.unpacked')
  const nativeModules = walkFiles(nativeRoot, (_full, name) => name.endsWith('.node'))
  if (nativeModules.length === 0) {
    fail(`No staged native .node modules were found under ${nativeRoot}.`)
  }
  for (const nativeModule of nativeModules) {
    assertPeArch(nativeModule, arch)
  }

  const nodePty = nativeModules.filter(file => /node-pty/i.test(file))
  if (nodePty.length === 0) {
    fail('The packaged application has no node-pty native payload.')
  }

  const portableExe = findPortableExe(outputDir, unpackedDir)
  if (fs.statSync(portableExe).size === 0) {
    fail(`Portable executable is empty: ${portableExe}`)
  }

  const stamp = readJson(installStamp)
  if (stamp.commit !== release.commit) {
    fail(`Install stamp commit ${stamp.commit} does not match ${release.commit}.`)
  }

  return {
    portableExe,
    unpackedDir,
    nativeModules,
    portableSha256: sha256File(portableExe)
  }
}

function publishBuild({ arch, release, desktopVersion, validation, dependencyInfo }, options = {}) {
  const destination = path.join(ARTIFACTS, release.tag, arch)
  ensureDir(destination)
  const artifactName = `Hermes-${desktopVersion}-win-${arch}.exe`
  const artifact = path.join(destination, artifactName)
  fs.copyFileSync(validation.portableExe, artifact)

  const digest = sha256File(artifact)
  if (digest !== validation.portableSha256) {
    fail(`Artifact hash changed while publishing ${artifact}.`)
  }

  const manifest = {
    schemaVersion: 2,
    repository: release.repository,
    tag: release.tag,
    commit: release.commit,
    desktopVersion,
    source: {
      patches: dependencyInfo.sourcePatches
    },
    target: {
      platform: 'win32',
      arch
    },
    builder: {
      hostPlatform: process.platform,
      hostArch: process.arch,
      node: process.version,
      npm: dependencyInfo.npm
    },
    artifact: {
      file: path.relative(ROOT, artifact).replaceAll(path.sep, '/'),
      bytes: fs.statSync(artifact).size,
      sha256: digest
    },
    validation: {
      electronMachine: `0x${PE_MACHINES[arch].toString(16)}`,
      nativeModuleCount: validation.nativeModules.length,
      nativeModuleMachine: `0x${PE_MACHINES[arch].toString(16)}`
    },
    builtAt: new Date().toISOString()
  }

  const manifestFile = path.join(destination, 'manifest.json')
  const checksumFile = path.join(destination, `${artifactName}.sha256`)
  writeJsonAtomic(manifestFile, manifest)
  fs.writeFileSync(checksumFile, `${digest}  ${artifactName}\n`, 'ascii')
  if (options.activate !== false) {
    writeJsonAtomic(path.join(STATE_FILES, `active-${arch}.json`), manifest)
  }

  console.log(`[wrapper] Published ${path.relative(ROOT, artifact)} (${digest}).`)
  return { artifact, manifest, manifestFile, checksumFile }
}

function buildTarget(rawArch, options = {}) {
  requireWindows()
  const arch = requireTarget(rawArch)
  const release = options.release ?? readJson(UPSTREAM_METADATA)
  if (currentUpstreamCommit() !== release.commit) {
    fail(`Checked-out Hermes commit does not match build release ${release.commit}.`)
  }
  assertCleanUpstream()
  const patchTransaction = applySourcePatches()
  let result

  try {
    const dependencyInfo = ensureDependencies(arch)
    const desktopPackage = readJson(path.join(DESKTOP, 'package.json'))
    const desktopVersion = desktopPackage.version
    const outputDir =
      options.outputDir ?? path.join(BUILD_ROOT, `${release.tag}-${release.commit.slice(0, 12)}`, arch)
    removeDir(outputDir)
    ensureDir(outputDir)

    const env = targetNpmEnvironment(arch)
    env.GITHUB_SHA = release.commit
    env.GITHUB_REF_NAME = release.tag

    console.log(`[wrapper] Compiling Hermes Desktop ${release.tag} for win32-${arch}...`)
    runNpm(['run', 'build', '--workspace', 'hermes'], {
      cwd: UPSTREAM,
      env
    })

    assertPeArch(electronExe(), arch)
    if (arch === 'arm64') {
      patchPortableNsisTemplate()
    }
    console.log(`[wrapper] Packaging portable win32-${arch} executable...`)
    const builderArgs = [
      'run',
      'builder',
      '--workspace',
      'hermes',
      '--',
      '--win',
      'portable',
      `--${arch}`,
      '--publish',
      'never',
      `-c.directories.output=${outputDir}`
    ]
    if (arch === 'arm64') {
      builderArgs.push('--config.portable.useZip=true')
    }
    runNpm(builderArgs, {
      cwd: UPSTREAM,
      env
    })

    const validation = validateBuildOutput({ arch, outputDir, release })
    result = {
      arch,
      release,
      desktopVersion,
      outputDir,
      validation,
      dependencyInfo
    }
  } finally {
    patchTransaction.restore()
  }

  assertCleanUpstream()
  return options.publish === false ? result : { ...result, published: publishBuild(result) }
}

function validatePublished(rawArch) {
  const arch = requireTarget(rawArch)
  const activeFile = path.join(STATE_FILES, `active-${arch}.json`)
  if (!fs.existsSync(activeFile)) {
    fail(`No active ${arch} artifact manifest exists. Run npm run build:${arch} first.`)
  }
  const manifest = readJson(activeFile)
  const artifact = path.join(ROOT, ...manifest.artifact.file.split('/'))
  if (!fs.existsSync(artifact)) {
    fail(`Published artifact is missing: ${artifact}`)
  }
  const digest = sha256File(artifact)
  if (digest !== manifest.artifact.sha256) {
    fail(`Published artifact hash mismatch: expected ${manifest.artifact.sha256}, got ${digest}.`)
  }
  if (manifest.commit !== submoduleGitlink()) {
    fail(`Artifact ${arch} was built from ${manifest.commit}, not the staged wrapper gitlink ${submoduleGitlink()}.`)
  }
  if (!manifestMatchesPatchSet(manifest)) {
    fail(`Artifact ${arch} was not built with the wrapper's current source patch set.`)
  }
  console.log(`[wrapper] ${arch} artifact validated: ${manifest.artifact.file} (${digest}).`)
  return manifest
}

function protocolRegistrationSnapshot() {
  const registryKey = 'HKCU\\Software\\Classes\\hermes'
  const exists =
    run('reg.exe', ['query', registryKey], { allowFailure: true, capture: true }).status === 0
  if (!exists) {
    return { existed: false, file: null, registryKey }
  }

  const file = path.join(STATE_FILES, `protocol-registration-${process.pid}.reg`)
  ensureDir(path.dirname(file))
  run('reg.exe', ['export', registryKey, file, '/y'], { capture: true })
  return { existed: true, file, registryKey }
}

function restoreProtocolRegistration(snapshot) {
  try {
    if (snapshot.existed) {
      run('reg.exe', ['delete', snapshot.registryKey, '/f'], {
        allowFailure: true,
        capture: true
      })
      run('reg.exe', ['import', snapshot.file], { capture: true })
    } else {
      run('reg.exe', ['delete', snapshot.registryKey, '/f'], {
        allowFailure: true,
        capture: true
      })
    }
  } finally {
    if (snapshot.file) {
      fs.rmSync(snapshot.file, { force: true })
    }
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function startTarget(rawArch) {
  requireWindows()
  const arch = requireTarget(rawArch)
  const release = ensureSubmodule()
  const activeFile = path.join(STATE_FILES, `active-${arch}.json`)
  let manifest = fs.existsSync(activeFile) ? readJson(activeFile) : null
  if (!manifest || manifest.commit !== release.commit || !manifestMatchesPatchSet(manifest)) {
    console.log(`[wrapper] No current ${arch} artifact; building it first.`)
    buildTarget(arch)
    manifest = readJson(activeFile)
  } else {
    validatePublished(arch)
  }

  const artifact = path.join(ROOT, ...manifest.artifact.file.split('/'))
  const hermesHome = path.join(os.homedir(), '.hermes')
  const userData = path.join(os.homedir(), '.hermes', 'desktop-user-data')
  const runtimeTemp = path.join(STATE, 'runtime', `${arch}-${process.pid}-${Date.now()}`)
  ensureDir(hermesHome)
  ensureDir(userData)
  removeDir(runtimeTemp)
  ensureDir(runtimeTemp)
  const protocolSnapshot = protocolRegistrationSnapshot()

  const child = spawn(artifact, [], {
    cwd: path.dirname(artifact),
    stdio: 'ignore',
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      HERMES_DESKTOP_USER_DATA_DIR: userData,
      TEMP: runtimeTemp,
      TMP: runtimeTemp
    },
    windowsHide: false
  })
  console.log(`[wrapper] Started ${path.basename(artifact)} (PID ${child.pid}) with ${userData}.`)

  let result
  try {
    result = await waitForChild(child)
  } finally {
    try {
      restoreProtocolRegistration(protocolSnapshot)
    } finally {
      await removeRuntimeDir(runtimeTemp)
    }
  }
  if (result.code !== 0) {
    fail(
      `${path.basename(artifact)} exited with ` +
        (result.code == null ? `signal ${result.signal}` : `code ${result.code}`)
    )
  }
}

function parseStableRefs(text) {
  const refs = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(v(\d+)\.(\d+)\.(\d+))(\^\{\})?$/.exec(line.trim())
    if (!match) {
      continue
    }
    const [, sha, tag, year, month, day, peeled] = match
    const value = refs.get(tag) ?? {
      tag,
      year: Number(year),
      month: Number(month),
      day: Number(day),
      tagObject: null,
      commit: null
    }
    if (peeled) {
      value.commit = sha
    } else {
      value.tagObject = sha
      value.commit ??= sha
    }
    refs.set(tag, value)
  }
  return [...refs.values()].sort(
    (a, b) => b.year - a.year || b.month - a.month || b.day - a.day
  )
}

function latestStableRelease() {
  let text = ''
  let lastFailure = null
  for (const delay of [0, 2000, 5000]) {
    if (delay) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
    const result = run('git', ['ls-remote', '--tags', UPSTREAM_URL, 'v*'], {
      allowFailure: true,
      capture: true,
      timeout: 30_000
    })
    if (result.status === 0) {
      text = result.stdout
      lastFailure = null
      break
    }
    lastFailure =
      result.stderr || result.stdout || result.error?.message || `exit ${result.status}`
    if (!/429|rate limit|RPC failed/i.test(lastFailure)) {
      break
    }
  }
  if (lastFailure) {
    fail(`Could not list upstream stable tags after retries:\n${lastFailure}`)
  }
  const releases = parseStableRefs(text)
  if (releases.length === 0) {
    fail('Upstream published no stable vYYYY.M.D tags.')
  }
  const latest = releases[0]
  return {
    repository: UPSTREAM_URL,
    tag: latest.tag,
    commit: latest.commit
  }
}

function checkoutUpstreamCommit(commit) {
  const exists = run(
    'git',
    ['-C', UPSTREAM, 'cat-file', '-e', `${commit}^{commit}`],
    { allowFailure: true, capture: true }
  ).status === 0
  if (!exists) {
    git(['-C', UPSTREAM, 'fetch', '--depth=1', 'origin', commit])
  }
  git(['-C', UPSTREAM, 'checkout', '--detach', '--force', commit])
  ensureSparseCheckout()
}

function publishCandidate(candidate, options = {}) {
  const published = publishBuild(candidate, options)
  return { ...candidate, published }
}

function readOptionalJson(file) {
  return fs.existsSync(file) ? readJson(file) : null
}

function restoreOptionalJson(file, value) {
  if (value) {
    writeJsonAtomic(file, value)
  } else {
    fs.rmSync(file, { force: true })
  }
}

function updateLatestStable() {
  requireWindows()
  const previous = ensureSubmodule()
  const latest = latestStableRelease()
  if (latest.tag === previous.tag && latest.commit === previous.commit) {
    console.log(`[wrapper] ${latest.tag} is already the pinned latest stable release.`)
    return
  }

  console.log(
    `[wrapper] Candidate update: ${previous.tag} (${previous.commit.slice(0, 12)}) -> ` +
      `${latest.tag} (${latest.commit.slice(0, 12)}).`
  )
  const transactionRoot = path.join(STATE, 'transactions', `${latest.tag}-${latest.commit.slice(0, 12)}`)
  const activeX64File = path.join(STATE_FILES, 'active-x64.json')
  const activeArm64File = path.join(STATE_FILES, 'active-arm64.json')
  const previousActiveX64 = readOptionalJson(activeX64File)
  const previousActiveArm64 = readOptionalJson(activeArm64File)
  removeDir(transactionRoot)

  try {
    checkoutUpstreamCommit(latest.commit)
    const x64 = buildTarget('x64', {
      release: latest,
      outputDir: path.join(transactionRoot, 'x64'),
      publish: false
    })
    const arm64 = buildTarget('arm64', {
      release: latest,
      outputDir: path.join(transactionRoot, 'arm64'),
      publish: false
    })
    const publishedX64 = publishCandidate(x64, { activate: false }).published
    const publishedArm64 = publishCandidate(arm64, { activate: false }).published
    writeJsonAtomic(UPSTREAM_METADATA, latest)
    writeJsonAtomic(activeX64File, publishedX64.manifest)
    writeJsonAtomic(activeArm64File, publishedArm64.manifest)
    git(['-C', ROOT, 'add', '--', 'upstream.json', SUBMODULE_PATH])
    console.log(
      `[wrapper] Updated to ${latest.tag}. Review and commit upstream.json plus the submodule gitlink.`
    )
  } catch (error) {
    console.error(`[wrapper] Update failed; restoring ${previous.tag}.`)
    checkoutUpstreamCommit(previous.commit)
    writeJsonAtomic(UPSTREAM_METADATA, previous)
    restoreOptionalJson(activeX64File, previousActiveX64)
    restoreOptionalJson(activeArm64File, previousActiveArm64)
    git(['-C', ROOT, 'add', '--', 'upstream.json', SUBMODULE_PATH])
    try {
      ensureDependencies(requireTarget(process.arch))
    } catch (restoreError) {
      console.error(`[wrapper] Dependency restoration also failed: ${restoreError.message}`)
    }
    throw error
  }
}

async function setup() {
  requireWindows()
  ensureSubmodule()
  const patchTransaction = applySourcePatches()
  try {
    ensureDependencies(requireTarget(process.arch))
  } finally {
    patchTransaction.restore()
  }
  assertCleanUpstream()
  console.log('[wrapper] Setup complete.')
}

async function main(argv = process.argv.slice(2)) {
  const [command = 'start', rawArch] = argv
  switch (command) {
    case 'submodule':
      ensureSubmodule()
      return
    case 'setup':
      await setup()
      return
    case 'build':
      ensureSubmodule()
      buildTarget(requireTarget(rawArch || process.arch))
      return
    case 'build-all':
      ensureSubmodule()
      buildTarget('x64')
      buildTarget('arm64')
      return
    case 'start':
      await startTarget(requireTarget(rawArch || process.arch))
      return
    case 'validate':
      if (rawArch) {
        validatePublished(rawArch)
      } else {
        validatePublished('x64')
        validatePublished('arm64')
      }
      return
    case 'update':
      updateLatestStable()
      return
    default:
      fail(`Unknown command "${command}".`)
  }
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedAsScript) {
  main().catch(error => {
    console.error(`[wrapper] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

export {
  manifestMatchesPatchSet,
  PE_MACHINES,
  parseStableRefs,
  readPeMachine,
  requireTarget
}
