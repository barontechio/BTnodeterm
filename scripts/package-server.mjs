#!/usr/bin/env node
// Packages existing builds only. All installation, patching and native compilation happen
// in a private external staging directory, never in the checkout's node_modules.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const RUNTIME_INPUTS = [
  'out/server/main.cjs',
  'out/renderer',
  'out/session-host/host.cjs',
  'out/main/codex-relay.js',
  'LICENSE',
  'resources/licenses',
  'docs/server-release-bt1.md',
  'docs/web-push.md',
  'docs/release-notes/v0.5.0-bt.1.md'
]
const PATCHES = ['scripts/patch-node-pty.mjs', 'scripts/patch-smart-whisper.mjs']
const PRIVATE_NAME = /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\..*)?|\.credentials(?:\..*)?|auth\.json|credentials\.json|userdata|user-data)$/i
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`)

export function hashFile(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let bytes
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes))
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

// Do not follow build-input links (including an intermediate directory). A renderer
// asset must not turn an allowlisted path into a copy of someone's home/config tree.
export function copyInput(root, destination, relative) {
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink in build input: ${relative}`)
  }
  const copy = (source, target) => {
    if (PRIVATE_NAME.test(path.basename(source))) throw new Error(`Private file in package input: ${source}`)
    const stat = fs.lstatSync(source)
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true })
      for (const name of fs.readdirSync(source).sort()) copy(path.join(source, name), path.join(target, name))
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644)
    } else {
      throw new Error(`Non-regular package input: ${source}`)
    }
  }
  copy(path.join(root, relative), path.join(destination, relative))
}

// Resolve existing ancestors too: --output /tmp/link-to-checkout/new must be refused.
export function externalOutput(root, output) {
  if (!output || !path.isAbsolute(output)) throw new Error('--output must be an absolute directory outside the checkout')
  let ancestor = path.resolve(output)
  const tail = []
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error('Cannot resolve output directory')
    ancestor = parent
  }
  const resolved = path.join(fs.realpathSync(ancestor), ...tail)
  if (inside(fs.realpathSync(root), resolved)) throw new Error('Output directory must be outside the checkout')
  return resolved
}

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null
  if (argv.length !== 2 || argv[0] !== '--output') throw new Error('Usage: node scripts/package-server.mjs --output /absolute/external/directory')
  return { output: argv[1] }
}

function run(command, args, cwd, env, capture = false) {
  return execFileSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit']
  })
}

export function nativeEnvironment(staging) {
  // npm run and Electron build shells can leak target/runtime/ignore-scripts flags.
  // Keep registry/auth configuration in the caller's HOME, never copy it into the package.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^npm_/i.test(key) && !/^(?:ELECTRON_|GYP_|NODE_OPTIONS$|NODE_PATH$|CFLAGS$|CXXFLAGS$|LDFLAGS$|CPATH$|LIBRARY_PATH$)/i.test(key)))
  return {
    ...env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    LC_ALL: 'C', TZ: 'UTC',
    npm_config_runtime: 'node', npm_config_target: process.versions.node,
    npm_config_arch: process.arch, npm_config_build_from_source: 'true',
    CFLAGS: `-D_GNU_SOURCE -ffile-prefix-map=${staging}=. -fdebug-prefix-map=${staging}=.`,
    CXXFLAGS: `-ffile-prefix-map=${staging}=. -fdebug-prefix-map=${staging}=.`
  }
}

export function installRuntime(staging, epoch) {
  const env = { ...nativeEnvironment(staging), ...(epoch ? { SOURCE_DATE_EPOCH: String(epoch) } : {}) }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], staging, env)
  for (const script of PATCHES) run(process.execPath, [path.join(staging, script)], staging, env)
  run('npm', ['rebuild', 'node-pty', 'smart-whisper', '--ignore-scripts=false', '--build-from-source'], staging, env)
  // Load the actual compiled module, not an upstream prebuild selected by a fallback.
  run(process.execPath, ['-e', `
    const fs = require('node:fs'), path = require('node:path'), root = process.cwd() + path.sep;
    for (const name of ['node-pty', 'ws', 'ssh2', 'smart-whisper']) {
      if (!fs.realpathSync(require.resolve(name)).startsWith(root)) throw new Error('Dependency outside staging: ' + name);
      require(name);
    }
    require('./node_modules/node-pty/build/Release/pty.node');
    require('./node_modules/smart-whisper/build/Release/smart-whisper.node');
  `], staging, env)
  // node-gyp's makefiles/config contain absolute staging paths; they are build-time
  // artifacts. Retain runtime binaries only so a different temp path does not leak in.
  for (const module of ['node-pty', 'smart-whisper']) {
    const build = path.join(staging, 'node_modules', module, 'build')
    for (const name of fs.readdirSync(build)) {
      if (name !== 'Release') fs.rmSync(path.join(build, name), { recursive: true, force: true })
    }
    for (const name of fs.readdirSync(path.join(build, 'Release'))) {
      if (!/\.(?:node|so(?:\.\d+)*)$/.test(name)) fs.rmSync(path.join(build, 'Release', name), { recursive: true, force: true })
    }
  }
  // npm generates these locally, including install metadata irrelevant at runtime.
  fs.rmSync(path.join(staging, 'node_modules/.package-lock.json'), { force: true })
}

export function dependencyInventory(root, lock) {
  const result = []
  const visit = (modules) => {
    for (const name of fs.readdirSync(modules).sort()) {
      if (name.startsWith('.')) continue
      const entry = path.join(modules, name)
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error(`Linked dependency: ${entry}`)
      if (name.startsWith('@')) { visit(entry); continue }
      const pkg = JSON.parse(fs.readFileSync(path.join(entry, 'package.json'), 'utf8'))
      const relative = path.relative(root, entry).split(path.sep).join('/')
      const locked = lock.packages[relative]
      if (!locked || locked.version !== pkg.version || locked.dev || locked.link) throw new Error(`Dependency is not a locked production package: ${relative}`)
      result.push({ path: relative, name: pkg.name, version: pkg.version, license: pkg.license ?? null, integrity: locked.integrity ?? null })
      const nested = path.join(entry, 'node_modules')
      if (fs.existsSync(nested)) visit(nested)
    }
  }
  visit(path.join(root, 'node_modules'))
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export function fileInventory(root) {
  const files = []
  const walk = (dir) => {
    fs.chmodSync(dir, 0o755)
    for (const name of fs.readdirSync(dir).sort()) {
      if (PRIVATE_NAME.test(name)) throw new Error(`Private file in staged package: ${name}`)
      const file = path.join(dir, name)
      const relative = path.relative(root, file).split(path.sep).join('/')
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file)
        if (path.isAbsolute(target) || !inside(root, fs.realpathSync(file))) throw new Error(`Escaping package symlink: ${relative}`)
        files.push({ path: relative, type: 'symlink', target })
      } else if (stat.isDirectory()) walk(file)
      else if (stat.isFile()) {
        const mode = stat.mode & 0o111 ? 0o755 : 0o644
        fs.chmodSync(file, mode)
        files.push({ path: relative, type: 'file', mode: mode.toString(8), bytes: stat.size, sha256: hashFile(file) })
      } else throw new Error(`Unsupported staged file: ${relative}`)
    }
  }
  walk(root)
  return files
}

export function writeLauncher(root) {
  fs.writeFileSync(path.join(root, 'start-server.sh'), `#!/bin/sh
set -eu
CDPATH= cd -- "$(dirname -- "$0")"
for tool in node tmux git curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required runtime tool missing: $tool" >&2; exit 1; }
done
node -e 'const m=require("./MANIFEST.json"); if(process.version!==m.runtime.node || process.versions.modules!==m.runtime.abi || process.platform!==m.runtime.platform || process.arch!==m.runtime.arch) { console.error("Requires Node "+m.runtime.node+", ABI "+m.runtime.abi+", "+m.runtime.platform+"/"+m.runtime.arch); process.exit(1) }'
exec node out/server/main.cjs "$@"
`, { mode: 0o755, flag: 'wx' })
}

export function writeManifest(root, metadata) {
  const files = fileInventory(root)
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), json({ ...metadata, files }), { flag: 'wx', mode: 0o644 })
  const sums = files.filter((entry) => entry.type === 'file').map((entry) => `${entry.sha256}  ${entry.path}`)
  sums.push(`${hashFile(path.join(root, 'MANIFEST.json'))}  MANIFEST.json`)
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${sums.join('\n')}\n`, { flag: 'wx', mode: 0o644 })
}

export function archivePackage(parent, name, archive, epoch) {
  // GNU format avoids variable PAX atime/ctime; gzip -n removes its header timestamp/name.
  run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner',
    '--format=gnu', '--mode=u+rwX,go+rX,go-w', '-I', 'gzip -n', '-cf', archive, '-C', parent, name], parent,
  { ...process.env, LC_ALL: 'C', TZ: 'UTC', TAR_OPTIONS: '', GZIP: '' })
}

export function packageServer({ output, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }) {
  root = fs.realpathSync(root)
  output = externalOutput(root, output)
  if (process.platform !== 'linux') throw new Error('Server packaging currently supports Linux only; no cross-compilation')
  const glibc = process.report.getReport().header.glibcVersionRuntime
  if (!glibc) throw new Error('Only glibc Linux is supported by this packaging recipe')
  const git = (args) => run('git', args, root, process.env, true).trim()
  if (git(['status', '--porcelain=v1', '--untracked-files=normal'])) throw new Error('Package from a clean committed checkout (including packaging scripts)')
  const commit = git(['rev-parse', 'HEAD'])
  const epoch = git(['show', '-s', '--format=%ct', 'HEAD'])
  if (!/^\d+$/.test(epoch)) throw new Error('Invalid commit timestamp')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid package version')
  if (pkg.nodeTermUpdates !== 'disabled') throw new Error('Fork package requires nodeTermUpdates=disabled')
  if (!lock.packages || lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Package/lock versions disagree')
  for (const relative of [...RUNTIME_INPUTS, ...PATCHES]) fs.accessSync(path.join(root, relative), fs.constants.R_OK)
  for (const relative of ['out/renderer/index.html', 'out/renderer/web-push-sw.js']) fs.accessSync(path.join(root, relative), fs.constants.R_OK)
  const name = `nodeterm-server-${pkg.version}-linux-${process.arch}-node${process.versions.node}-abi${process.versions.modules}-glibc${glibc}`
  fs.mkdirSync(output, { recursive: true })
  const tarFile = path.join(output, `${name}.tar.gz`)
  const shaFile = `${tarFile}.sha256`
  for (const file of [tarFile, shaFile]) if (fs.existsSync(file)) throw new Error(`Refusing to overwrite: ${file}`)
  // Exclusive reservation protects concurrent publishers; only our private directory is removed.
  const reservation = `${tarFile}.lock`
  fs.mkdirSync(reservation, { mode: 0o700 })
  let work
  try {
    work = fs.mkdtempSync(path.join(output, '.nodeterm-package-'))
    const staging = path.join(work, name)
    fs.mkdirSync(staging)
    for (const relative of [...RUNTIME_INPUTS, ...PATCHES, 'package.json', 'package-lock.json']) copyInput(root, staging, relative)
    installRuntime(staging, epoch)
    const dependencies = dependencyInventory(staging, lock)
    // Keep the original lock for the recipe; runtime package.json carries no Desktop updater feed.
    const { build, devDependencies, scripts, ...runtimePkg } = pkg
    fs.writeFileSync(path.join(staging, 'package.json'), json({ ...runtimePkg, main: './out/server/main.cjs', scripts: { start: 'node out/server/main.cjs' } }))
    writeLauncher(staging)
    fs.writeFileSync(path.join(staging, 'RUNTIME.txt'), `Server ${pkg.version}; source commit ${commit}.
Requires exact Node ${process.version}, ABI ${process.versions.modules}, Linux ${process.arch}, glibc compatible with build host ${glibc}.
Install tmux, git, curl and CA certificates separately. Node is not bundled.
Run ./start-server.sh with operator-chosen private HOME and NODETERM_DATA_DIR outside this package.
See docs/server-release-bt1.md and docs/web-push.md for operation, HTTPS and optional push enrollment.
Updates are disabled. Existing license enforcement is unchanged.
Speech native binaries are built and load-tested; models are not provisioned and transcription is not certified.
Recreate from the recorded clean commit/lock with prebuilt outputs. npm ci --omit=dev --ignore-scripts,
the included patches and npm rebuild node-pty smart-whisper --build-from-source run in private staging only.
Archive bytes are deterministic for identical staged inputs; native compiler/toolchain changes may change binaries.
MANIFEST.json hashes all payload files except itself and SHA256SUMS; SHA256SUMS also hashes the manifest.
`, { mode: 0o644 })
    writeManifest(staging, {
      schema: 1, name: pkg.name, version: pkg.version, commit, sourceDateEpoch: Number(epoch),
      lockSha256: hashFile(path.join(root, 'package-lock.json')),
      runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, glibc },
      recipe: { npm: run('npm', ['--version'], staging, nativeEnvironment(staging), true).trim(), nodeTermUpdates: 'disabled',
        install: 'npm ci --omit=dev --ignore-scripts', native: 'npm rebuild node-pty smart-whisper --build-from-source', speechNative: 'built-load-tested',
        patches: PATCHES.map((file) => ({ path: file, sha256: hashFile(path.join(staging, file)) })) },
      prerequisites: ['exact Node version/ABI above', 'compatible glibc/libstdc++', 'tmux', 'git', 'curl', 'CA certificates'],
      dependencies
    })
    if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain=v1', '--untracked-files=normal'])) {
      throw new Error('Source checkout changed during packaging; refusing publication')
    }
    const archive = path.join(work, `${name}.tar.gz`)
    archivePackage(work, name, archive, epoch)
    const sha256 = hashFile(archive)
    const checksum = path.join(work, 'archive.sha256')
    fs.writeFileSync(checksum, `${sha256}  ${path.basename(tarFile)}\n`, { mode: 0o644 })
    // Hard links publish complete files atomically and refuse existing destinations.
    fs.linkSync(archive, tarFile)
    fs.linkSync(checksum, shaFile)
    return { archive: tarFile, checksum: shaFile, sha256, bytes: fs.statSync(tarFile).size, commit }
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true })
    fs.rmdirSync(reservation)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (!args) console.log('Usage: node scripts/package-server.mjs --output /absolute/external/directory\nRequires clean committed Linux/glibc checkout and existing builds; installs only in private staging.')
    else console.log(json(packageServer(args)))
  } catch (error) {
    console.error(`[package-server] ${error.message}`)
    process.exitCode = 1
  }
}
