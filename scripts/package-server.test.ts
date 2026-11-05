import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { testTmpDir } from '../src/core/test-tmp'
// @ts-expect-error -- .mjs tooling outside the TypeScript projects
import { archivePackage, copyInput, externalOutput, fileInventory, hashFile, installRuntime, nativeEnvironment, packageServer, parseArgs, RUNTIME_INPUTS, writeManifest } from './package-server.mjs'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

afterEach(() => { vi.mocked(execFileSync).mockReset(); vi.mocked(execFileSync).mockImplementation(realExec) })
const realExec = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).execFileSync
const put = (root: string, relative: string, value = relative): void => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function fixture(): string {
  const root = testTmpDir('server-package-source-')
  for (const relative of RUNTIME_INPUTS) {
    put(root, relative === 'out/renderer' ? `${relative}/index.html` : relative === 'resources/licenses' ? `${relative}/COPYING.txt` : relative)
  }
  put(root, 'out/renderer/web-push-sw.js')
  put(root, 'out/renderer/assets/main.js')
  put(root, 'out/renderer/excalidraw-assets/font.woff2')
  put(root, 'scripts/patch-node-pty.mjs')
  put(root, 'scripts/patch-smart-whisper.mjs')
  put(root, 'package.json', JSON.stringify({ name: 'node-terminal', version: '0.5.0-bt.1', license: 'BUSL-1.1', nodeTermUpdates: 'disabled', build: { publish: { url: 'upstream' } } }))
  put(root, 'package-lock.json', JSON.stringify({ version: '0.5.0-bt.1', lockfileVersion: 3, packages: {
    '': { version: '0.5.0-bt.1' },
    'node_modules/node-pty': { version: '1.1.0', integrity: 'sha512-fixture', license: 'MIT' },
    'node_modules/smart-whisper': { version: '0.8.1', integrity: 'sha512-whisper-fixture', license: 'MIT' }
  } }))
  return root
}

function mockRecipe(dirty = false): void {
  vi.mocked(execFileSync).mockImplementation(((command: string, args: string[], options: { cwd: string }) => {
    if (command === 'git') {
      if (args[0] === 'status') return dirty ? ' M source.ts\n' : ''
      if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`
      if (args[0] === 'show') return '1700000000\n'
    }
    if (command === 'npm') {
      if (args[0] === '--version') return '10.9.7\n'
      if (args[0] === 'ci') {
        put(options.cwd, 'node_modules/node-pty/package.json', JSON.stringify({ name: 'node-pty', version: '1.1.0', license: 'MIT' }))
        put(options.cwd, 'node_modules/node-pty/LICENSE', 'dependency license unchanged')
        put(options.cwd, 'node_modules/smart-whisper/package.json', JSON.stringify({ name: 'smart-whisper', version: '0.8.1', license: 'MIT' }))
        put(options.cwd, 'node_modules/.package-lock.json')
      }
      if (args[0] === 'rebuild') {
        put(options.cwd, 'node_modules/node-pty/build/Release/pty.node', 'native-fixture')
        put(options.cwd, 'node_modules/smart-whisper/build/Release/smart-whisper.node', 'whisper-native-fixture')
        put(options.cwd, 'node_modules/smart-whisper/build/Release/obj.target/intermediate.o')
        put(options.cwd, 'node_modules/node-pty/build/Release/obj.target/intermediate.o')
        put(options.cwd, 'node_modules/node-pty/build/config.gypi', options.cwd)
      }
      return ''
    }
    if (command === process.execPath) return '' // Patch/load probes are recipe assertions here.
    return realExec(command, args, options)
  }) as typeof execFileSync)
}

describe('Server packaging boundaries', () => {
  it('requires an explicit external output, including through symlinked ancestors', () => {
    const root = testTmpDir('server-package-root-')
    const outer = testTmpDir('server-package-output-')
    expect(() => parseArgs([])).toThrow('Usage')
    expect(() => parseArgs(['--output', outer, '--skip-clean'])).toThrow('Usage')
    expect(() => externalOutput(root, 'relative')).toThrow('absolute')
    expect(() => externalOutput(root, path.join(root, 'new/subdir'))).toThrow('outside')
    fs.symlinkSync(root, path.join(outer, 'alias'))
    expect(() => externalOutput(root, path.join(outer, 'alias/new'))).toThrow('outside')
    expect(externalOutput(root, outer)).toBe(fs.realpathSync(outer))
  })

  it('copies only allowlisted inputs and refuses private files or source symlinks', () => {
    const root = fixture()
    const target = testTmpDir('server-package-copy-')
    put(root, '.env', 'private')
    put(root, 'auth.json', 'private')
    for (const relative of RUNTIME_INPUTS) copyInput(root, target, relative)
    expect(fs.existsSync(path.join(target, '.env'))).toBe(false)
    expect(fs.existsSync(path.join(target, 'auth.json'))).toBe(false)
    expect(fs.existsSync(path.join(target, 'out/renderer/excalidraw-assets/font.woff2'))).toBe(true)
    put(root, 'out/renderer/.env.secret', 'private')
    expect(() => copyInput(root, testTmpDir('server-package-private-'), 'out/renderer')).toThrow('Private file')
    fs.symlinkSync(path.join(root, 'LICENSE'), path.join(root, 'out/server/alias'))
    expect(() => copyInput(root, target, 'out/server/alias')).toThrow('Symlink')
    const intermediate = testTmpDir('server-package-link-')
    fs.symlinkSync(path.join(root, 'out'), path.join(intermediate, 'out'))
    expect(() => copyInput(intermediate, target, 'out/server/main.cjs')).toThrow('Symlink')
  })

  it('checks dependency symlink containment, preserves internal links and file hashes', () => {
    const root = testTmpDir('server-package-hashes-')
    put(root, 'node_modules/tool/LICENSE', 'license')
    fs.mkdirSync(path.join(root, 'node_modules/.bin'))
    fs.symlinkSync('../tool/LICENSE', path.join(root, 'node_modules/.bin/tool'))
    writeManifest(root, { version: 'fixture' })
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'))
    expect(manifest.files).toContainEqual({ path: 'node_modules/.bin/tool', type: 'symlink', target: '../tool/LICENSE' })
    expect(manifest.files.find((f: { path: string }) => f.path === 'node_modules/tool/LICENSE').sha256).toBe(hashFile(path.join(root, 'node_modules/tool/LICENSE')))
    expect(fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8')).toContain(`${hashFile(path.join(root, 'MANIFEST.json'))}  MANIFEST.json`)
    const outside = testTmpDir('server-package-escape-')
    put(outside, 'private')
    fs.symlinkSync(path.join(outside, 'private'), path.join(root, 'escape'))
    expect(() => fileInventory(root)).toThrow('Escaping')
  })

  it('installs and rebuilds only in staging, applies both patches and discards native intermediates', () => {
    mockRecipe()
    const root = fixture()
    installRuntime(root)
    const calls = vi.mocked(execFileSync).mock.calls
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ['npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']],
      [process.execPath, [path.join(root, 'scripts/patch-node-pty.mjs')]],
      [process.execPath, [path.join(root, 'scripts/patch-smart-whisper.mjs')]],
      ['npm', ['rebuild', 'node-pty', 'smart-whisper', '--ignore-scripts=false', '--build-from-source']],
      [process.execPath, ['-e', expect.stringContaining('build/Release/pty.node')]]
    ])
    for (const call of calls) expect(call[2]).toMatchObject({ cwd: root, env: { npm_config_runtime: 'node', npm_config_target: process.versions.node, npm_config_build_from_source: 'true' } })
    expect(fs.readdirSync(path.join(root, 'node_modules/node-pty/build'))).toEqual(['Release'])
    expect(fs.readdirSync(path.join(root, 'node_modules/node-pty/build/Release'))).toEqual(['pty.node'])
    expect(fs.readdirSync(path.join(root, 'node_modules/smart-whisper/build/Release'))).toEqual(['smart-whisper.node'])
    expect(nativeEnvironment(root).PATH.startsWith(path.dirname(process.execPath))).toBe(true)
  })

  it('produces identical archives despite input mtimes, creation order and staging paths', () => {
    const first = testTmpDir('server-package-tar-a-')
    const second = testTmpDir('server-package-tar-b-')
    put(first, 'payload/z', 'z'); put(first, 'payload/a', 'a')
    put(second, 'payload/a', 'a'); put(second, 'payload/z', 'z')
    fs.utimesSync(path.join(first, 'payload/a'), 1, 1)
    fs.utimesSync(path.join(second, 'payload/a'), 99999999, 99999999)
    archivePackage(first, 'payload', path.join(first, 'a.tar.gz'), '1700000000')
    archivePackage(second, 'payload', path.join(second, 'b.tar.gz'), '1700000000')
    expect(hashFile(path.join(first, 'a.tar.gz'))).toBe(hashFile(path.join(second, 'b.tar.gz')))
  })

  it('refuses dirty sources before npm or output writes', () => {
    mockRecipe(true)
    const root = fixture()
    const output = path.join(testTmpDir('server-package-dirty-'), 'new')
    expect(() => packageServer({ root, output })).toThrow('clean committed')
    expect(fs.existsSync(output)).toBe(false)
    expect(vi.mocked(execFileSync).mock.calls.some((call) => call[0] === 'npm')).toBe(false)
  })

  it('packages the recipe with an honest platform/ABI, verifies checksums, launches from another cwd and refuses overwrite', () => {
    mockRecipe()
    const root = fixture()
    put(root, '.env', 'do not package')
    put(root, 'node_modules/shared-do-not-touch', 'untouched')
    put(root, 'out/server/main.cjs', 'console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}))')
    const output = testTmpDir('server-package-release-')
    const result = packageServer({ root, output })
    expect(result.archive).toContain(`linux-${process.arch}-node${process.versions.node}-abi${process.versions.modules}`)
    expect(fs.readFileSync(result.checksum, 'utf8')).toBe(`${hashFile(result.archive)}  ${path.basename(result.archive)}\n`)
    const extracted = testTmpDir('server-package-extract-')
    realExec('tar', ['-xzf', result.archive, '-C', extracted])
    const payload = path.join(extracted, fs.readdirSync(extracted)[0])
    realExec('sha256sum', ['-c', 'SHA256SUMS'], { cwd: payload })
    const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'MANIFEST.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: '0.5.0-bt.1', commit: 'a'.repeat(40), runtime: { node: process.version, abi: process.versions.modules }, recipe: { nodeTermUpdates: 'disabled', speechNative: 'built-load-tested' } })
    expect(manifest.dependencies).toEqual([expect.objectContaining({ name: 'node-pty', version: '1.1.0', integrity: 'sha512-fixture' }), expect.objectContaining({ name: 'smart-whisper', version: '0.8.1', integrity: 'sha512-whisper-fixture' })])
    const packaged = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8'))
    expect(packaged.nodeTermUpdates).toBe('disabled')
    expect(realExec(process.execPath, ['-p', 'require.resolve(process.argv[1])', payload], { encoding: 'utf8' }).trim()).toBe(path.join(payload, 'out/server/main.cjs'))
    expect(fs.existsSync(path.join(payload, 'docs/web-push.md'))).toBe(true)
    expect(packaged.build).toBeUndefined()
    expect(fs.readFileSync(path.join(payload, 'LICENSE'), 'utf8')).toBe('LICENSE')
    expect(fs.readFileSync(path.join(payload, 'node_modules/node-pty/LICENSE'), 'utf8')).toBe('dependency license unchanged')
    expect(fs.existsSync(path.join(payload, '.env'))).toBe(false)
    expect(fs.existsSync(path.join(payload, 'node_modules/shared-do-not-touch'))).toBe(false)
    const launch = realExec(path.join(payload, 'start-server.sh'), ['argument with spaces'], { cwd: extracted, encoding: 'utf8' })
    expect(JSON.parse(launch)).toEqual({ cwd: payload, argv: ['argument with spaces'] })
    expect(() => packageServer({ root, output })).toThrow('Refusing to overwrite')
    expect(hashFile(result.archive)).toBe(result.sha256)
    expect(fs.readFileSync(path.join(root, 'node_modules/shared-do-not-touch'), 'utf8')).toBe('untouched')
    expect(fs.readdirSync(output).sort()).toEqual([path.basename(result.archive), path.basename(result.checksum)].sort())
    const repeat = packageServer({ root, output: testTmpDir('server-package-repeat-') })
    expect(repeat.sha256).toBe(result.sha256)
  })

  it('fails closed on missing assets or updater policy without leaving artifacts', () => {
    mockRecipe()
    const root = fixture()
    const output = testTmpDir('server-package-fail-')
    fs.unlinkSync(path.join(root, 'out/renderer/web-push-sw.js'))
    expect(() => packageServer({ root, output })).toThrow('ENOENT')
    expect(fs.readdirSync(output)).toEqual([])
    put(root, 'out/renderer/web-push-sw.js')
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    put(root, 'package.json', JSON.stringify({ ...pkg, nodeTermUpdates: 'manual' }))
    expect(() => packageServer({ root, output })).toThrow('nodeTermUpdates=disabled')
  })

  it('cleans its own staging on install failure and preserves unrelated output data', () => {
    mockRecipe()
    const recipe = vi.mocked(execFileSync).getMockImplementation()!
    vi.mocked(execFileSync).mockImplementation(((...args: Parameters<typeof execFileSync>) => {
      if (args[0] === 'npm' && Array.isArray(args[1]) && args[1][0] === 'ci') throw new Error('fixture install failure')
      return recipe(...args)
    }) as typeof execFileSync)
    const root = fixture()
    const output = testTmpDir('server-package-install-failure-')
    put(output, 'unrelated', 'keep me')
    expect(() => packageServer({ root, output })).toThrow('fixture install failure')
    expect(fs.readdirSync(output)).toEqual(['unrelated'])
    expect(fs.readFileSync(path.join(output, 'unrelated'), 'utf8')).toBe('keep me')
  })
})
