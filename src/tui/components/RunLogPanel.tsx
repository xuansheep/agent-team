import React from "react";
import type { TuiLogMessage } from "../logTypes.js";
import { LogMessageList } from "./log/LogMessageList.js";

export function RunLogPanel({
  items,
  currentNodeId,
  currentAttempt,
  detailMode,
  offset = 0,
  visibleRows
}: {
  items: TuiLogMessage[];
  currentNodeId?: string;
  currentAttempt?: number;
  detailMode: boolean;
  offset?: number;
  visibleRows?: number;
}) {
  return <LogMessageList items={items} currentNodeId={currentNodeId} currentAttempt={currentAttempt} detailMode={detailMode} offset={offset} visibleRows={visibleRows} />;
}
