import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type FixtureOperation =
  | 'parseControlFrame'
  | 'selectProtocolVersion'
  | 'selectCapabilities'
  | 'acceptNegotiatedCapabilities'

export interface ProtocolFixtureCase {
  name: string
  operation: FixtureOperation
  input: unknown
  expect: Record<string, unknown> & { accepted: boolean }
}

export interface ProtocolFixtureSuite {
  name: string
  cases: ProtocolFixtureCase[]
}

interface FixtureManifest {
  fixtureFormat: 'dsh-remote.protocol-conformance'
  fixtureFormatVersion: 1
  protocolVersion: 1
  suites: Array<{ name: string; path: string }>
}

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/protocol/v1/manifest.json')
const fixtureRootDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/protocol/v1')
const operations = new Set<FixtureOperation>([
  'parseControlFrame',
  'selectProtocolVersion',
  'selectCapabilities',
  'acceptNegotiatedCapabilities',
])

export async function loadProtocolFixtures(): Promise<ProtocolFixtureSuite[]> {
  const manifest = parseManifest(await readJson(manifestPath))
  const suites = await Promise.all(manifest.suites.map(async entry => {
    if (!isRelativeFixturePath(entry.path)) throw new Error(`Fixture path is invalid: ${entry.path}`)
    const suite = parseSuite(await readJson(join(fixtureRootDir, entry.path)))
    if (suite.name !== entry.name) throw new Error(`Fixture suite name does not match: ${entry.name}`)
    return suite
  }))
  const names = suites.flatMap(suite => suite.cases.map(testCase => testCase.name))
  if (new Set(names).size !== names.length) throw new Error('Fixture case names must be unique.')
  return suites
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function parseManifest(value: unknown): FixtureManifest {
  const manifest = record(value, 'Fixture manifest')
  if (manifest.fixtureFormat !== 'dsh-remote.protocol-conformance'
    || manifest.fixtureFormatVersion !== 1
    || manifest.protocolVersion !== 1
    || !Array.isArray(manifest.suites)) {
    throw new Error('Fixture manifest is invalid.')
  }
  const suites = manifest.suites.map((value, index) => {
    const entry = record(value, `Fixture manifest suite ${index}`)
    if (typeof entry.name !== 'string' || entry.name.length === 0
      || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error(`Fixture manifest suite ${index} is invalid.`)
    }
    return { name: entry.name, path: entry.path }
  })
  return { ...manifest, suites } as FixtureManifest
}

function parseSuite(value: unknown): ProtocolFixtureSuite {
  const suite = record(value, 'Fixture suite')
  if (typeof suite.name !== 'string' || suite.name.length === 0 || !Array.isArray(suite.cases)) {
    throw new Error('Fixture suite is invalid.')
  }
  const cases = suite.cases.map((value, index) => {
    const testCase = record(value, `Fixture case ${index}`)
    const expect = record(testCase.expect, `Fixture case ${index} result`)
    if (typeof testCase.name !== 'string' || testCase.name.length === 0
      || typeof testCase.operation !== 'string' || !operations.has(testCase.operation as FixtureOperation)
      || typeof expect.accepted !== 'boolean' || !('input' in testCase)) {
      throw new Error(`Fixture case ${index} is invalid.`)
    }
    return {
      name: testCase.name,
      operation: testCase.operation as FixtureOperation,
      input: testCase.input,
      expect: expect as ProtocolFixtureCase['expect'],
    }
  })
  return { name: suite.name, cases }
}

function isRelativeFixturePath(path: string): boolean {
  return !path.startsWith('/') && !path.split('/').includes('..') && path.endsWith('.json')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}
