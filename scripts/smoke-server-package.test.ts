import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { testTmpDir } from '../src/core/test-tmp'

it('refuses an ancestor dependency before executing it or starting the package', () => {
  const outer = testTmpDir('server-smoke-ancestor-')
  const root = path.join(outer, 'package')
  const dependency = path.join(outer, 'node_modules/ws')
  fs.mkdirSync(root)
  fs.mkdirSync(dependency, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.5.0-bt.1', nodeTermUpdates: 'disabled' }))
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'ws', main: 'index.js' }))
  const marker = path.join(outer, 'foreign-code-executed')
  fs.writeFileSync(path.join(dependency, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
  const child = spawnSync(process.execPath, [path.resolve(__dirname, 'smoke-server-package.mjs'), root, path.join(outer, 'evidence')], {
    env: { PATH: path.dirname(process.execPath), HOME: outer, TMPDIR: outer }, encoding: 'utf8', timeout: 5000
  })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(1)
  expect(child.stderr).toContain('Dependency must resolve within extracted package: ws')
  expect(fs.existsSync(marker)).toBe(false)
})
