import { useEffect, useRef, useState } from 'react'
import type { useSelection } from './use-selection.js'

type Selection = ReturnType<typeof useSelection>

/** Copy a settled text selection while preserving its highlight. */
export function useCopyOnSelect(
  selection: Selection,
  enabled: boolean,
): number | undefined {
  const copiedRef = useRef(false)
  const [copiedCharacterCount, setCopiedCharacterCount] = useState<number>()

  useEffect(() => {
    copiedRef.current = false
    if (!enabled) setCopiedCharacterCount(undefined)

    const unsubscribe = selection.subscribe(() => {
      const state = selection.getState()
      const hasSelection = selection.hasSelection()

      if (state?.isDragging || !hasSelection) {
        copiedRef.current = false
        setCopiedCharacterCount(undefined)
        return
      }
      if (!enabled || copiedRef.current) return

      copiedRef.current = true
      const copiedText = selection.copySelectionNoClear()
      setCopiedCharacterCount(copiedText.trim() ? Array.from(copiedText).length : undefined)
    })

    return unsubscribe
  }, [enabled, selection])

  return copiedCharacterCount
}
