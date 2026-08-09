import React, {
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { pointerShapeSequence } from '../../ink/termio/osc.js'
import { TerminalWriteContext } from '../../ink/useTerminalNotification.js'
import type { ScrollBoxHandle } from '../ink.js'
import { Box, Text } from '../ink.js'

export type MainScrollBarGeometry = {
  visible: boolean
  thumbStart: number
  thumbSize: number
  maxScroll: number
}

export type MainScrollBarGeometryInput = {
  trackHeight: number
  scrollHeight: number
  viewportHeight: number
  scrollTop: number
  pendingDelta: number
  sticky: boolean
}

type MainScrollBarProps = {
  scrollRef: RefObject<ScrollBoxHandle>
  height: number
  contentRevision: unknown
  layoutRevision?: unknown
  enabled?: boolean
}

type LayoutMetrics = {
  contentHeight: number
  viewportHeight: number
}

const TRACK_CHARACTER = '\u2502'
const THUMB_CHARACTER = '\u2588'
const NOOP_UNSUBSCRIBE = () => {}

function isThumbRow(
  row: number,
  thumbStart: number,
  thumbSize: number,
): boolean {
  return row >= thumbStart && row < thumbStart + thumbSize
}

export function calculateMainScrollBarGeometry(
  input: MainScrollBarGeometryInput,
): MainScrollBarGeometry {
  const trackHeight = Math.max(0, Math.floor(input.trackHeight))
  const scrollHeight = Math.max(0, Math.ceil(input.scrollHeight))
  const viewportHeight = Math.max(0, Math.floor(input.viewportHeight))
  const maxScroll = Math.max(0, scrollHeight - viewportHeight)

  if (trackHeight === 0 || viewportHeight === 0 || maxScroll === 0) {
    return { visible: false, thumbStart: 0, thumbSize: 0, maxScroll }
  }

  const thumbSize = Math.min(
    trackHeight,
    Math.max(1, Math.floor((trackHeight * viewportHeight) / scrollHeight)),
  )
  const maxThumbStart = trackHeight - thumbSize
  const effectiveTop = input.sticky
    ? maxScroll
    : Math.min(
        maxScroll,
        Math.max(0, Math.floor(input.scrollTop + input.pendingDelta)),
      )
  const thumbStart =
    maxThumbStart === 0
      ? 0
      : Math.round((effectiveTop / maxScroll) * maxThumbStart)

  return { visible: true, thumbStart, thumbSize, maxScroll }
}

export function scrollMainToThumbStart(
  scroll: Pick<ScrollBoxHandle, 'scrollTo' | 'scrollToBottom'>,
  thumbStart: number,
  trackHeight: number,
  thumbSize: number,
  maxScroll: number,
): boolean {
  const normalizedHeight = Math.max(0, Math.floor(trackHeight))
  const normalizedThumbSize = Math.max(0, Math.floor(thumbSize))
  const normalizedMax = Math.max(0, Math.floor(maxScroll))
  const maxThumbStart = Math.max(0, normalizedHeight - normalizedThumbSize)
  if (maxThumbStart === 0 || normalizedMax === 0) return false

  const targetStart = Math.min(
    maxThumbStart,
    Math.max(0, Math.floor(thumbStart)),
  )
  const target = Math.round((targetStart / maxThumbStart) * normalizedMax)
  scroll.scrollTo(target)
  if (target < normalizedMax) return false

  scroll.scrollToBottom()
  return true
}

export function MainScrollBar({
  scrollRef,
  height,
  contentRevision,
  layoutRevision,
  enabled = true,
}: MainScrollBarProps): React.ReactNode {
  const trackHeight = Math.max(0, Math.floor(height))
  const [layoutMetrics, setLayoutMetrics] = useState<LayoutMetrics>()
  const dragRef = useRef<{ grabOffset: number }>()
  const hoveredRowRef = useRef<number>()
  const pointerActiveRef = useRef(false)
  const writeRaw = useContext(TerminalWriteContext)

  const setPointerActive = useCallback(
    (active: boolean) => {
      if (pointerActiveRef.current === active) return
      pointerActiveRef.current = active
      writeRaw?.(pointerShapeSequence(active ? 'pointer' : undefined))
    },
    [writeRaw],
  )

  useEffect(() => {
    // Local Ink paints updated Yoga viewport bounds on its throttled frame.
    // Measure after that frame so a closed menu cannot leave stale scrollbar geometry.
    let active = true
    const measurementTimer = setTimeout(() => {
      if (!active) return
      const scroll = scrollRef.current
      if (!scroll) {
        setLayoutMetrics(undefined)
        return
      }

      const next = {
        contentHeight: scroll.getFreshScrollHeight(),
        viewportHeight: scroll.getViewportHeight() || trackHeight,
      }
      setLayoutMetrics(current =>
        current?.contentHeight === next.contentHeight &&
        current.viewportHeight === next.viewportHeight
          ? current
          : next,
      )
    }, 20)
    return () => {
      active = false
      clearTimeout(measurementTimer)
    }
  }, [
    scrollRef,
    trackHeight,
    contentRevision,
    layoutRevision,
    enabled,
  ])

  const subscribe = useCallback(
    (listener: () => void) =>
      scrollRef.current?.subscribe(listener) ?? NOOP_UNSUBSCRIBE,
    [scrollRef],
  )
  const getSnapshot = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || !enabled) return '0:0:0:0'

    const geometry = calculateMainScrollBarGeometry({
      trackHeight,
      scrollHeight:
        layoutMetrics?.contentHeight ?? scroll.getScrollHeight(),
      viewportHeight:
        layoutMetrics?.viewportHeight ??
        (scroll.getViewportHeight() || trackHeight),
      scrollTop: scroll.getScrollTop(),
      pendingDelta: scroll.getPendingDelta(),
      sticky: scroll.isSticky(),
    })
    return [
      geometry.visible ? 1 : 0,
      geometry.thumbStart,
      geometry.thumbSize,
      geometry.maxScroll,
    ].join(':')
  }, [enabled, layoutMetrics, scrollRef, trackHeight])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [visibleFlag, thumbStart, thumbSize, maxScroll] = snapshot
    .split(':')
    .map(Number)
  const visible = visibleFlag === 1

  useEffect(() => {
    if (!visible) {
      dragRef.current = undefined
      hoveredRowRef.current = undefined
      setPointerActive(false)
      return
    }

    const hoveredRow = hoveredRowRef.current
    setPointerActive(
      Boolean(dragRef.current) ||
        (hoveredRow !== undefined &&
          isThumbRow(hoveredRow, thumbStart, thumbSize)),
    )
  }, [setPointerActive, thumbSize, thumbStart, visible])

  useEffect(
    () => () => {
      setPointerActive(false)
    },
    [setPointerActive],
  )

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={trackHeight}
      width={1}
      onMouseDown={
        visible
          ? event => {
              event.stopImmediatePropagation()
              const row = Math.floor(event.localRow)
              hoveredRowRef.current = row
              const overThumb = isThumbRow(row, thumbStart, thumbSize)
              setPointerActive(overThumb)
              if (!overThumb) return
              dragRef.current = { grabOffset: row - thumbStart }
              event.capturePointer()
            }
          : undefined
      }
      onMouseMove={
        visible
          ? event => {
              const row = Math.floor(event.localRow)
              hoveredRowRef.current = row
              const drag = dragRef.current
              setPointerActive(
                Boolean(drag) || isThumbRow(row, thumbStart, thumbSize),
              )
              const scroll = scrollRef.current
              if (!drag || !scroll) return
              event.stopImmediatePropagation()
              scrollMainToThumbStart(
                scroll,
                event.localRow - drag.grabOffset,
                trackHeight,
                thumbSize,
                maxScroll,
              )
            }
          : undefined
      }
      onMouseUp={
        visible
          ? event => {
              const wasDragging = Boolean(dragRef.current)
              dragRef.current = undefined
              if (event.action === 'cancel') {
                hoveredRowRef.current = undefined
                setPointerActive(false)
              } else {
                const row = Math.floor(event.localRow)
                hoveredRowRef.current = row
                setPointerActive(isThumbRow(row, thumbStart, thumbSize))
              }
              if (wasDragging) event.stopImmediatePropagation()
            }
          : undefined
      }
      onMouseLeave={() => {
        hoveredRowRef.current = undefined
        if (!dragRef.current) setPointerActive(false)
      }}
    >
      {visible
        ? Array.from({ length: trackHeight }, (_, row) => {
            const thumb = isThumbRow(row, thumbStart, thumbSize)
            return (
              <Text
                key={row}
                color={thumb ? 'ansi:blackBright' : undefined}
                dimColor={!thumb}
              >
                {thumb ? THUMB_CHARACTER : TRACK_CHARACTER}
              </Text>
            )
          })
        : null}
    </Box>
  )
}
