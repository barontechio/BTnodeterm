import { useEffect, useState, type RefObject } from 'react'

type TextModel = { getValue(): string }

/** Install before the missing-file disposal effect. These are local unsaved/display buffers,
 * never a write to the missing path and never a promise of persistence across app restarts. */
export function useRetainedFileText(missing: boolean, first: RefObject<TextModel | null>, second?: RefObject<TextModel | null>): string[] {
  const [text, setText] = useState<string[]>([])
  useEffect(() => {
    if (!missing) return
    const models = [first.current, second?.current].filter((model): model is TextModel => !!model)
    if (models.length) setText(models.map((model) => model.getValue()))
  }, [missing, first, second])
  return text
}

export function RetainedFileText({ text }: { text: string[] }) {
  if (!text.length) return null
  return <div className="nodrag nowheel nokey" style={{ width: '100%', overflow: 'auto' }}>
    <p>Text retained in this open node. Copy it before closing or reloading.</p>
    {text.map((value, index) => <textarea key={index} readOnly value={value}
      aria-label={text.length > 1 ? (index === 0 ? 'Retained original text' : 'Retained modified text') : 'Retained editor text'}
      style={{ width: '100%', minHeight: 160, resize: 'vertical' }} />)}
  </div>
}
