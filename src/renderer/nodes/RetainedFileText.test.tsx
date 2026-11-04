// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RetainedFileText, useRetainedFileText } from './RetainedFileText'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('retains both buffers before missing-file model disposal and exposes read-only copyable text', async () => {
  let disposed = false
  const first = { current: { getValue: vi.fn(() => { if (disposed) throw new Error('disposed'); return 'unsaved original' }) } }
  const second = { current: { getValue: vi.fn(() => { if (disposed) throw new Error('disposed'); return 'modified text' }) } }
  function Fixture({ missing }: { missing: boolean }) {
    const text = useRetainedFileText(missing, first, second)
    useEffect(() => { if (missing) disposed = true }, [missing])
    return <RetainedFileText text={text} />
  }
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  try {
    await act(async () => root.render(<Fixture missing={false} />))
    expect(first.current.getValue).not.toHaveBeenCalled()
    await act(async () => root.render(<Fixture missing />))
    expect(disposed).toBe(true)
    const text = [...host.querySelectorAll('textarea')]
    expect(text.map(t => t.value)).toEqual(['unsaved original', 'modified text'])
    expect(text.every(t => t.readOnly)).toBe(true)
    await act(async () => root.render(<Fixture missing />))
    expect(first.current.getValue).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); host.remove() }
})
