import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import App, { handleMouseEvent } from '../../src/ink/components/App.js'
import { appendChildNode, createNode } from '../../src/ink/dom.js'
import type { MouseEvent } from '../../src/ink/events/mouse-event.js'
import { dispatchMouseEvent } from '../../src/ink/hit-test.js'
import { nodeCache } from '../../src/ink/node-cache.js'
import { createSelectionState } from '../../src/ink/selection.js'

describe('mouse event dispatch', () => {
  it('still dispatches hover when a no-button move is handled by a control', () => {
    const calls: string[] = []
    const app = {
      props: {
        onMouseEvent: () => {
          calls.push('mousemove')
          return true
        },
        selection: createSelectionState(),
        onSelectionChange: () => calls.push('selection'),
        onHoverAt: (col: number, row: number) =>
          calls.push(`hover:${col}:${row}`),
      },
      lastHoverCol: -1,
      lastHoverRow: -1,
    } as unknown as App

    handleMouseEvent(app, {
      kind: 'mouse',
      action: 'press',
      button: 35,
      col: 4,
      row: 7,
      sequence: '',
    })

    assert.deepEqual(calls, ['mousemove', 'hover:3:6'])
  })

  it('keeps delivering motion outside the target until release', () => {
    const root = createNode('ink-root')
    const scrollbar = createNode('ink-box')
    appendChildNode(root, scrollbar)
    nodeCache.set(root, { x: 0, y: 0, width: 80, height: 24 })
    nodeCache.set(scrollbar, { x: 79, y: 2, width: 1, height: 10 })

    const events: Array<{
      type: string
      action: string
      localCol: number
      localRow: number
    }> = []
    const record = (event: MouseEvent) => {
      events.push({
        type: event.type,
        action: event.action,
        localCol: event.localCol,
        localRow: event.localRow,
      })
    }
    scrollbar._eventHandlers = {
      onMouseDown: (event: MouseEvent) => {
        record(event)
        event.capturePointer()
      },
      onMouseMove: record,
      onMouseUp: record,
    }

    const pressed = dispatchMouseEvent(root, {
      col: 79,
      row: 5,
      button: 0,
      action: 'press',
    })
    assert.equal(pressed.captureTarget, scrollbar)

    const moved = dispatchMouseEvent(
      root,
      { col: 20, row: 15, button: 32, action: 'move' },
      pressed.captureTarget,
    )
    assert.equal(moved.captureTarget, scrollbar)

    const released = dispatchMouseEvent(
      root,
      { col: 20, row: 15, button: 0, action: 'release' },
      moved.captureTarget,
    )
    assert.equal(released.captureTarget, undefined)
    assert.deepEqual(events, [
      { type: 'mousedown', action: 'press', localCol: 0, localRow: 3 },
      { type: 'mousemove', action: 'move', localCol: -59, localRow: 13 },
      { type: 'mouseup', action: 'release', localCol: -59, localRow: 13 },
    ])
  })

  it('delivers cancellation as mouseup and clears capture', () => {
    const root = createNode('ink-root')
    const scrollbar = createNode('ink-box')
    appendChildNode(root, scrollbar)
    nodeCache.set(root, { x: 0, y: 0, width: 10, height: 10 })
    nodeCache.set(scrollbar, { x: 9, y: 0, width: 1, height: 10 })

    let cancelled: MouseEvent | undefined
    scrollbar._eventHandlers = {
      onMouseUp: (event: MouseEvent) => {
        cancelled = event
      },
    }

    const result = dispatchMouseEvent(
      root,
      { col: 0, row: 0, button: 0, action: 'cancel' },
      scrollbar,
    )
    assert.equal(result.captureTarget, undefined)
    assert.equal(cancelled?.type, 'mouseup')
    assert.equal(cancelled?.action, 'cancel')
  })
})
