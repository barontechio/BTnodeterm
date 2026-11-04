// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { EditorNode } from './EditorNode'
import { DiffNode } from './DiffNode'

const state = vi.hoisted(() => ({
  models: [] as Array<{ value: string; disposed: boolean; getValue(): string; setValue(value: string): void; dispose(): void }>,
  events: [] as string[], commands: [] as Array<() => void>,
  read: vi.fn(async () => 'loaded working text'), write: vi.fn(async () => true), showFile: vi.fn(async () => 'loaded original text')
}))
vi.mock('../editor/monaco-setup', () => ({ monaco: {
  Uri: { file: (name: string) => ({ with: (extra: object) => ({ name, ...extra }) }) }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
  editor: {
    setTheme() {}, getModel: () => null,
    createModel: (value: string) => {
      const index = state.models.length
      const model = { value, disposed: false,
        getValue() { if (this.disposed) throw new Error('read after disposal'); state.events.push(`read:${index}`); return this.value },
        setValue(next: string) { this.value = next },
        dispose() { state.events.push(`dispose:${index}`); this.disposed = true }
      }
      state.models.push(model); return model
    },
    create: (_element: unknown, options: { model: { getValue(): string } }) => ({ getValue: () => options.model.getValue(),
      onDidChangeModelContent() {}, addCommand: (_key: number, fn: () => void) => state.commands.push(fn), dispose() {} }),
    createDiffEditor: () => ({ setModel() {}, dispose() {} })
  }
} }))
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ deleteElements: vi.fn() }), Handle: () => null, NodeResizer: () => null, Position: { Top: 'top' } }))
vi.mock('../components/Tooltip', () => ({ Tooltip: ({ children }: { children: unknown }) => children }))
vi.mock('./MaximizeButton', () => ({ MaximizeButton: () => null }))
vi.mock('../state/useAppTheme', () => ({ useAppTheme: () => 'dark' }))
vi.mock('../lib/appTheme', () => ({ monacoTheme: () => 'dark' }))
vi.mock('../lib/keybindingOverrides', () => ({ chipFor: () => '', commandTooltip: (value: string) => value }))
vi.mock('../state/settings', () => ({ useSettings: { getState: () => ({ settings: { fontSize: 12, fontFamily: 'monospace', openMarkdownPreview: false } }) } }))
vi.mock('../state/projects', () => {
  const value = { activeProjectId: 'project', getProject: () => ({}) }
  return { useProjects: Object.assign((selector: (arg: typeof value) => unknown) => selector(value), { getState: () => value }) }
})
vi.mock('../state/viewMode', () => ({ isGlobalKanbanOpen: () => false, isKanbanOpen: () => false }))
vi.mock('../terminal/ssh-fs', () => ({ sshFs: () => { throw new Error('unexpected remote route') } }))
vi.mock('../session/session', () => ({ useSession: () => ({ api: { fs: { read: state.read, write: state.write }, git: { showFile: state.showFile } } }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  state.models.length = 0; state.events.length = 0; state.commands.length = 0; vi.clearAllMocks()
  window.nodeTerminal = { onMarkdownToggle: () => () => {} } as unknown as typeof window.nodeTerminal
})

for (const kind of ['editor', 'diff'] as const) it(`retains complete mounted ${kind} models before actual missing-file disposal and disables writes`, async () => {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  const data = { color: '#fff', cwd: '/checkout', filePath: kind === 'editor' ? '/checkout/original.txt' : 'original.txt' }
  const render = (missing: boolean, replacement = false) => {
    const props = { id: `node-${kind}`, selected: false, data: { ...data, fileMissing: missing, ...(replacement ? { filePath: '/replacement/other.txt' } : {}) } } as ComponentProps<typeof EditorNode>
    return kind === 'editor' ? <EditorNode {...props} /> : <DiffNode {...props} />
  }
  try {
    await act(async () => root.render(render(false)))
    expect(state.models).toHaveLength(kind === 'editor' ? 1 : 2)
    const complete = state.models.map((_model, index) => `side${index}:` + 'unsaved α\n'.repeat(20000) + 'END')
    act(() => state.models.forEach((model, index) => model.setValue(complete[index])))
    await act(async () => root.render(render(true)))
    const text = [...host.querySelectorAll('textarea')]
    expect(text.map(item => item.value)).toEqual(complete)
    expect(text.every(item => item.readOnly)).toBe(true)
    expect(host.textContent).toContain('Original file: /checkout/original.txt')
    for (let index = 0; index < state.models.length; index++) {
      expect(state.events.indexOf(`read:${index}`)).toBeLessThan(state.events.indexOf(`dispose:${index}`))
      expect(state.models[index].disposed).toBe(true)
    }
    act(() => state.commands.forEach(command => command()))
    expect(state.write).not.toHaveBeenCalled()
    await act(async () => root.render(render(true, true)))
    expect([...host.querySelectorAll('textarea')].map(item => item.value)).toEqual(complete)
    expect(host.textContent).toContain('Original file: /checkout/original.txt')
    expect(state.read).toHaveBeenCalledOnce()
    expect(state.write).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); host.remove() }
})
