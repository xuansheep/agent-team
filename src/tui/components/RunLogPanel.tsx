import type { TuiLogMessage } from "../logTypes.js";
import { LogMessageList } from "./log/LogMessageList.js";

export function RunLogPanel({
  items,
  detailMode,
  offset = 0,
  visibleRows
}: {
  items: TuiLogMessage[];
  detailMode: boolean;
  offset?: number;
  visibleRows?: number;
}) {
  return <LogMessageList items={items} detailMode={detailMode} offset={offset} visibleRows={visibleRows} />;
}
