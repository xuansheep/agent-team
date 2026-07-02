import { Box } from "../../ink.js";
import type { TuiLogMessage } from "../../logTypes.js";
import { LogMessageRow } from "./LogMessageRow.js";

export function LogMessageList({
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
  const maxOffset = visibleRows === undefined ? 0 : Math.max(0, items.length - visibleRows);
  const start = visibleRows === undefined ? 0 : Math.min(offset, maxOffset);
  const visible = visibleRows === undefined ? items : items.slice(start, start + visibleRows);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {visible.map((item) => (
        <LogMessageRow key={item.id} item={item} detailMode={detailMode} />
      ))}
    </Box>
  );
}
