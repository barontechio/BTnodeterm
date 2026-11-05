import { it, expect } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

function fixture(windows: Array<{ url: string; focus(): Promise<void>; postMessage(value: unknown): void }> = []) {
  const handlers: Record<string, Function> = {}
  const opened: string[] = [], shown: unknown[] = []
  const self = { location: { origin: 'https://term.example.com' }, addEventListener: (name: string, fn: Function) => { handlers[name] = fn },
    registration: { showNotification: async (...args: unknown[]) => { shown.push(args) } },
    clients: { matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url) } } }
  vm.runInNewContext(fs.readFileSync(path.resolve('src/renderer/public/web-push-sw.js'), 'utf8'), { self, URL, encodeURIComponent })
  return { handlers, opened, shown }
}
const noticeId = '12345678-1234-1234-1234-123456789abc'
it('only installs push/click; payloads are strict and display generic copy without metadata', async () => {
  const f = fixture(); expect(Object.keys(f.handlers)).toEqual(['push', 'notificationclick'])
  let task: Promise<void> | undefined
  const waitUntil = (p: Promise<void>) => { task = p }
  f.handlers.push({ data: { json: () => ({ v: 1, noticeId, kind: 'approval', transcript: 'secret' }) }, waitUntil }); await task
  expect(f.shown).toEqual([['nodeterm', { body: 'An agent needs your response.', tag: noticeId, data: { noticeId } }]])
  f.handlers.push({ data: { json: () => ({ v: 1, noticeId: 'https://evil.test', kind: 'done' }) }, waitUntil })
  expect(f.shown).toHaveLength(1)
})
it('focuses only same-origin app pages and passes an untrusted receipt to the page router', async () => {
  const messages: unknown[] = []; let focused = 0
  const f = fixture([{ url: 'https://term.example.com/', focus: async () => { focused++ }, postMessage: x => messages.push(x) }])
  let task: Promise<void> | undefined
  f.handlers.notificationclick({ notification: { data: { noticeId }, close() {} }, waitUntil: (p: Promise<void>) => { task = p } }); await task
  expect(focused).toBe(1); expect(messages).toEqual([{ type: 'nodeterm:web-push-click', noticeId }]); expect(f.opened).toEqual([])
})
it('opens a fresh same-origin page when none exists; rejects malformed and cross-origin targets', async () => {
  const f = fixture([{ url: 'https://evil.test/', focus: async () => { throw new Error('must not focus') }, postMessage() {} }])
  let task: Promise<void> | undefined
  const click = (id: string) => f.handlers.notificationclick({ notification: { data: { noticeId: id }, close() {} }, waitUntil: (p: Promise<void>) => { task = p } })
  click(noticeId); await task; expect(f.opened).toEqual(['/#web-push=' + noticeId])
  click('https://evil.test/token'); expect(f.opened).toHaveLength(1)
})
