import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { InputEvent, Key } from '../events/input-event.js'
import { InputEvent as InkInputEvent } from '../events/input-event.js'
import {
  INITIAL_STATE,
  type KeyParseState,
  parseMultipleKeypresses,
} from '../parse-keypress.js'
import useStdin from './use-stdin.js'

type Handler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  /**
   * Enable or disable capturing of user input.
   * Useful when there are multiple useInput hooks used at once to avoid handling the same input several times.
   *
   * @default true
   */
  isActive?: boolean
}

type RawInputPropagation = {
  chunk: unknown
  stoppedIndexes: Set<number>
}

const rawInputPropagation = new WeakMap<object, RawInputPropagation>()

/**
 * This hook is used for handling user input.
 * It's a more convenient alternative to using `StdinContext` and listening to `data` events.
 * The callback you pass to `useInput` is called for each character when user enters any input.
 * However, if user pastes text and it's more than one character, the callback will be called only once and the whole string will be passed as `input`.
 *
 * ```
 * import {useInput} from 'ink';
 *
 * const UserInput = () => {
 *   useInput((input, key) => {
 *     if (input === 'q') {
 *       // Exit program
 *     }
 *
 *     if (key.leftArrow) {
 *       // Left arrow key pressed
 *     }
 *   });
 *
 *   return …
 * };
 * ```
 */
const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()
  const stdinState = useStdin()
  const parserRef = useRef<KeyParseState>(INITIAL_STATE)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // useLayoutEffect (not useEffect) so that raw mode is enabled synchronously
  // during React's commit phase, before render() returns. With useEffect, raw
  // mode setup is deferred to the next event loop tick via React's scheduler,
  // leaving the terminal in cooked mode — keystrokes echo and the cursor is
  // visible until the effect fires.
  useLayoutEffect(() => {
    if (options.isActive === false) {
      return
    }

    setRawMode(true)

    return () => {
      setRawMode(false)
    }
  }, [options.isActive, setRawMode])

  // Register the listener once on mount so its slot in the EventEmitter's
  // listener array is stable. If isActive were in the effect's deps, the
  // listener would re-append on false→true, moving it behind listeners
  // that registered while it was inactive — breaking
  // stopImmediatePropagation() ordering. useEventCallback keeps the
  // reference stable while reading latest isActive/inputHandler from
  // closure (it syncs via useLayoutEffect, so it's compiler-safe).
  const handleData = useEventCallback((event: InputEvent) => {
    if (options.isActive === false) {
      return
    }
    const { input, key } = event

    // If app is not supposed to exit on Ctrl+C, then let input listener handle it
    // Note: discreteUpdates is called at the App level when emitting events,
    // so all listeners are already within a high-priority update context.
    if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event)
    }
  })

  useEffect(() => {
    if (stdinState.internal_querier === null) return
    internal_eventEmitter?.on('input', handleData)

    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData, stdinState.internal_querier])

  useLayoutEffect(() => {
    if (stdinState.internal_querier !== null || options.isActive === false) {
      return
    }

    const handleRawData = (value: unknown) => {
      if (typeof value !== 'string' && !Buffer.isBuffer(value)) return
      const propagation = rawInputPropagationState(stdinState.stdin, value)
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      const [items, nextState] = parseMultipleKeypresses(
        parserRef.current,
        Buffer.isBuffer(value) ? value.toString('utf8') : value,
      )
      parserRef.current = nextState
      for (const [index, item] of items.entries()) {
        if (propagation.stoppedIndexes.has(index)) continue
        if (item.kind !== 'key') continue
        const event = new InkInputEvent(item)
        handleData(event)
        if (event.didStopImmediatePropagation()) propagation.stoppedIndexes.add(index)
      }
      if (nextState.incomplete) {
        flushTimerRef.current = setTimeout(() => {
          const [flushedItems, flushedState] = parseMultipleKeypresses(
            parserRef.current,
            null,
          )
          parserRef.current = flushedState
          flushTimerRef.current = null
          for (const item of flushedItems) {
            if (item.kind !== 'key') continue
            const event = new InkInputEvent(item)
            handleData(event)
            if (event.didStopImmediatePropagation()) break
          }
        }, 25)
      }
    }

    stdinState.stdin.on?.('data', handleRawData)
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      stdinState.stdin.off?.('data', handleRawData)
    }
  }, [handleData, options.isActive, stdinState])
}

export default useInput

function rawInputPropagationState(stdin: NodeJS.ReadStream, chunk: unknown): RawInputPropagation {
  const current = rawInputPropagation.get(stdin)
  if (current && current.chunk === chunk) return current
  const next = { chunk, stoppedIndexes: new Set<number>() }
  rawInputPropagation.set(stdin, next)
  queueMicrotask(() => {
    if (rawInputPropagation.get(stdin) === next) rawInputPropagation.delete(stdin)
  })
  return next
}

function useEventCallback<T extends (...args: never[]) => void>(callback: T): T {
  const callbackRef = useRef(callback)
  useLayoutEffect(() => {
    callbackRef.current = callback
  })
  return useCallback(
    ((...args: Parameters<T>) => callbackRef.current(...args)) as T,
    [],
  )
}
