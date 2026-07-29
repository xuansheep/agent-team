import { useMemo, type RefObject } from "react";
import { Box, type ScrollBoxHandle } from "../../ink.js";
import type { TuiLogMessage } from "../../logTypes.js";
import { useVirtualScroll } from "../../useVirtualScroll.js";
import { LogMessageRow } from "./LogMessageRow.js";

type LogMessageListProps = {
  items: TuiLogMessage[];
  detailMode: boolean;
  scrollRef?: RefObject<ScrollBoxHandle | null>;
  columns?: number;
};

export function LogMessageList({
  items,
  detailMode,
  scrollRef,
  columns = 80
}: LogMessageListProps) {
  if (!scrollRef) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        {items.map((item) => (
          <LogMessageRow key={item.id} item={item} detailMode={detailMode} />
        ))}
      </Box>
    );
  }

  return (
    <VirtualLogMessageList
      items={items}
      detailMode={detailMode}
      scrollRef={scrollRef}
      columns={Math.max(1, columns)}
    />
  );
}

function VirtualLogMessageList({
  items,
  detailMode,
  scrollRef,
  columns
}: Required<LogMessageListProps>) {
  const itemKeys = useMemo(() => items.map((item) => item.id), [items]);
  const { range, topSpacer, bottomSpacer, measureRef, spacerRef } =
    useVirtualScroll(scrollRef, itemKeys, columns);
  const [start, end] = range;

  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {items.slice(start, end).map((item) => (
        <Box
          key={item.id}
          ref={measureRef(item.id)}
          flexDirection="column"
          flexShrink={0}
        >
          <LogMessageRow item={item} detailMode={detailMode} />
        </Box>
      ))}
      {bottomSpacer > 0 ? <Box height={bottomSpacer} flexShrink={0} /> : null}
    </>
  );
}
