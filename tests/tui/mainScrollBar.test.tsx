import { type RefObject } from 'react';
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render } from 'ink-testing-library'
import type { ScrollBoxHandle } from '../../src/tui/ink.js'
import {
  calculateMainScrollBarGeometry,
  MainScrollBar,
  scrollMainToThumbStart,
} from '../../src/tui/components/MainScrollBar.js'

describe('main log scroll bar geometry', () => {
  it('stays hidden when content fits the viewport', () => {
    assert.deepEqual(
      calculateMainScrollBarGeometry({
        trackHeight: 6,
        scrollHeight: 6,
        viewportHeight: 6,
        scrollTop: 0,
        pendingDelta: 0,
        sticky: true,
      }),
      { visible: false, thumbStart: 0, thumbSize: 0, maxScroll: 0 },
    )
  })

  it('uses pending movement and sticky state for the thumb position', () => {
    const moving = calculateMainScrollBarGeometry({
      trackHeight: 10,
      scrollHeight: 100,
      viewportHeight: 20,
      scrollTop: 20,
      pendingDelta: 20,
      sticky: false,
    })
    assert.deepEqual(moving, {
      visible: true,
      thumbStart: 4,
      thumbSize: 2,
      maxScroll: 80,
    })

    const sticky = calculateMainScrollBarGeometry({
      trackHeight: 10,
      scrollHeight: 100,
      viewportHeight: 20,
      scrollTop: 0,
      pendingDelta: 0,
      sticky: true,
    })
    assert.equal(sticky.thumbStart, 8)
  })

  it('keeps a one-row thumb for very long output', () => {
    const geometry = calculateMainScrollBarGeometry({
      trackHeight: 4,
      scrollHeight: 1000,
      viewportHeight: 2,
      scrollTop: 500,
      pendingDelta: 0,
      sticky: false,
    })
    assert.equal(geometry.visible, true)
    assert.equal(geometry.thumbSize, 1)
  })
})

describe('main log scroll bar dragging', () => {
  it('maps thumb positions to scroll positions', () => {
    const calls: Array<['scrollTo', number] | ['scrollToBottom']> = []
    const scroll = {
      scrollTo: (position: number) => calls.push(['scrollTo', position]),
      scrollToBottom: () => calls.push(['scrollToBottom']),
    }

    assert.equal(scrollMainToThumbStart(scroll, 0, 10, 2, 80), false)
    assert.equal(scrollMainToThumbStart(scroll, 4, 10, 2, 80), false)
    assert.equal(scrollMainToThumbStart(scroll, 8, 10, 2, 80), true)
    assert.deepEqual(calls, [
      ['scrollTo', 0],
      ['scrollTo', 40],
      ['scrollTo', 80],
      ['scrollToBottom'],
    ])
  })

  it('clamps dragging above and below the track', () => {
    const calls: Array<['scrollTo', number] | ['scrollToBottom']> = []
    const scroll = {
      scrollTo: (position: number) => calls.push(['scrollTo', position]),
      scrollToBottom: () => calls.push(['scrollToBottom']),
    }

    assert.equal(scrollMainToThumbStart(scroll, -20, 6, 2, 100), false)
    assert.equal(scrollMainToThumbStart(scroll, 20, 6, 2, 100), true)
    assert.deepEqual(calls, [
      ['scrollTo', 0],
      ['scrollTo', 100],
      ['scrollToBottom'],
    ])
  })

  it('does nothing when the thumb cannot move', () => {
    const calls: string[] = []
    const scroll = {
      scrollTo: (position: number) => calls.push(`scrollTo:${position}`),
      scrollToBottom: () => calls.push('scrollToBottom'),
    }

    assert.equal(scrollMainToThumbStart(scroll, 0, 4, 4, 12), false)
    assert.equal(scrollMainToThumbStart(scroll, 0, 4, 1, 0), false)
    assert.deepEqual(calls, [])
  })
})

describe('MainScrollBar rendering', () => {
  it('updates the thumb through the ScrollBox subscription', async () => {
    let top = 0
    const listeners = new Set<() => void>()
    const handle: ScrollBoxHandle = {
      scrollTo: position => {
        top = position
      },
      scrollBy: () => {},
      scrollToElement: () => {},
      scrollToBottom: () => {},
      getScrollTop: () => top,
      getPendingDelta: () => 0,
      getScrollHeight: () => 16,
      getFreshScrollHeight: () => 16,
      getViewportHeight: () => 4,
      getViewportTop: () => 0,
      isSticky: () => false,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      setClampBounds: () => {},
    }
    const scrollRef = { current: handle } as RefObject<ScrollBoxHandle>
    const output = render(
      <MainScrollBar
        scrollRef={scrollRef}
        height={4}
        contentRevision={0}
      />,
    )

    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(visibleRows(output.lastFrame()), [
      '\u2588',
      '\u2502',
      '\u2502',
      '\u2502',
    ])

    top = 12
    for (const listener of listeners) listener()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(visibleRows(output.lastFrame()), [
      '\u2502',
      '\u2502',
      '\u2502',
      '\u2588',
    ])
    output.unmount()
  })

  it('does not draw a track when scrolling is disabled', () => {
    const handle: ScrollBoxHandle = {
      scrollTo: () => {},
      scrollBy: () => {},
      scrollToElement: () => {},
      scrollToBottom: () => {},
      getScrollTop: () => 0,
      getPendingDelta: () => 0,
      getScrollHeight: () => 16,
      getFreshScrollHeight: () => 16,
      getViewportHeight: () => 4,
      getViewportTop: () => 0,
      isSticky: () => false,
      subscribe: () => () => {},
      setClampBounds: () => {},
    }
    const scrollRef = { current: handle } as RefObject<ScrollBoxHandle>
    const output = render(
      <MainScrollBar
        scrollRef={scrollRef}
        height={4}
        contentRevision={0}
        enabled={false}
      />,
    )

    assert.deepEqual(visibleRows(output.lastFrame()), [])
    output.unmount()
  })
})

function visibleRows(frame: string | undefined): string[] {
  return (frame ?? '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}
