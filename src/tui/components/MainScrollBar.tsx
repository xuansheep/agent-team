import React, {
  type RefObject,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
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

export function scrollMainToTrackRow(
  scroll: Pick<ScrollBoxHandle, 'scrollTo' | 'scrollToBottom'>,
  row: number,
  trackHeight: number,
  maxScroll: number,
): boolean {
  const normalizedHeight = Math.max(0, Math.floor(trackHeight))
  const normalizedMax = Math.max(0, Math.floor(maxScroll))
  if (normalizedHeight === 0 || normalizedMax === 0) return false

  const lastRow = normalizedHeight - 1
  const target =
    lastRow === 0
      ? normalizedMax
      : Math.round(
          (Math.min(lastRow, Math.max(0, Math.floor(row))) / lastRow) *
            normalizedMax,
        )

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

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={trackHeight}
      width={1}
      onClick={
        visible
          ? event => {
              event.stopImmediatePropagation()
              const scroll = scrollRef.current
              if (scroll) {
                scrollMainToTrackRow(
                  scroll,
                  event.localRow,
                  trackHeight,
                  maxScroll,
                )
              }
            }
          : undefined
      }
    >
      {visible
        ? Array.from({ length: trackHeight }, (_, row) => {
            const thumb =
              row >= thumbStart && row < thumbStart + thumbSize
            return (
              <Text
                key={row}
                color={thumb ? 'cyan' : undefined}
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
