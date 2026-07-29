import type { RefObject } from "react";
import type { ScrollBoxHandle } from "../ink.js";
import type { TuiLogMessage } from "../logTypes.js";
import { LogMessageList } from "./log/LogMessageList.js";

export function RunLogPanel({
  items,
  detailMode,
  scrollRef,
  columns
}: {
  items: TuiLogMessage[];
  detailMode: boolean;
  scrollRef?: RefObject<ScrollBoxHandle | null>;
  columns?: number;
}) {
  return (
    <LogMessageList
      items={items}
      detailMode={detailMode}
      scrollRef={scrollRef}
      columns={columns}
    />
  );
}
