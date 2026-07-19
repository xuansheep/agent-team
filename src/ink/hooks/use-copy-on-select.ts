import { useEffect, useRef } from 'react'
import type { useSelection } from './use-selection.js'

type Selection = ReturnType<typeof useSelection>

/** Copy a settled text selection while preserving its highlight. */
export function useCopyOnSelect(
  selection: Selection,
  enabled: boolean,
): void {
  const copiedRef = useRef(false)

  useEffect(() => {
    const unsubscribe = selection.subscribe(() => {
      const state = selection.getState()
      const hasSelection = selection.hasSelection()

      if (state?.isDragging || !hasSelection) {
        copiedRef.current = false
        return
      }
      if (!enabled || copiedRef.current) return

      copiedRef.current = true
      selection.copySelectionNoClear()
    })

    return unsubscribe
  }, [enabled, selection])
}
