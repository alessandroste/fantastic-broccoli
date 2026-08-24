import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  manifestMatchesPatchSet,
  PE_MACHINES,
  parseStableRefs,
  readPeMachine,
  requireTarget
} from './wrapper.mjs'

test('parseStableRefs selects numeric date tags and peels annotated tags', () => {
  const refs = parseStableRefs(
    [
      'a'.repeat(40) + '\trefs/tags/v2026.9.1',
      'b'.repeat(40) + '\trefs/tags/v2026.9.1^{}',
      'c'.repeat(40) + '\trefs/tags/v2026.10.2',
      'd'.repeat(40) + '\trefs/tags/v2026.10.2^{}',
      'e'.repeat(40) + '\trefs/tags/v2026.10.2-rc.1',
      'f'.repeat(40) + '\trefs/tags/not-a-date'
    ].join('\n')
  )

  assert.deepEqual(
    refs.map(item => [item.tag, item.commit]),
    [
      ['v2026.10.2', 'd'.repeat(40)],
      ['v2026.9.1', 'b'.repeat(40)]
    ]
  )
})

test('readPeMachine reads the COFF machine rather than only the MZ marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-wrapper-pe-'))
  const file = path.join(dir, 'fixture.exe')
  const buffer = Buffer.alloc(256)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(128, 0x3c)
  buffer.write('PE\u0000\u0000', 128, 'ascii')
  buffer.writeUInt16LE(PE_MACHINES.arm64, 132)
  fs.writeFileSync(file, buffer)

  try {
    assert.equal(readPeMachine(file), PE_MACHINES.arm64)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('requireTarget accepts only supported Windows architectures', () => {
  assert.equal(requireTarget('x64'), 'x64')
  assert.equal(requireTarget('arm64'), 'arm64')
  assert.throws(() => requireTarget('ia32'), /Unsupported Windows architecture/)
})

test('manifestMatchesPatchSet requires exact ordered patch provenance', () => {
  const patches = [
    { file: 'patches/001-a.patch', sha256: 'a'.repeat(64) },
    { file: 'patches/002-b.patch', sha256: 'b'.repeat(64) }
  ]
  const manifest = { source: { patches } }

  assert.equal(manifestMatchesPatchSet(manifest, patches), true)
  assert.equal(manifestMatchesPatchSet({ source: { patches: patches.slice(0, 1) } }, patches), false)
  assert.equal(manifestMatchesPatchSet({ source: { patches: [...patches].reverse() } }, patches), false)
  assert.equal(manifestMatchesPatchSet({ schemaVersion: 1 }, patches), false)
})
