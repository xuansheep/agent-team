import { useMemo, type RefObject } from "react";
import { Box, type ScrollBoxHandle } from "../../ink.js";
import type { TuiLogMessage, TuiToolExplorationEntry, TuiToolLogMessage } from "../../logTypes.js";
import { isReadOnlyPowerShellCommand, isReadOnlyShellCommand } from "../../../security/shellSafety.js";
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
  const displayItems = useMemo(
    () => detailMode ? items : groupExplorationTools(items),
    [detailMode, items]
  );
  const assistantDividerIds = useMemo(() => {
    const ids = new Set<string>();
    const seenChains = new Set<string>();
    for (const item of displayItems) {
      if (item.kind === "user") {
        seenChains.clear();
        continue;
      }
      if (item.kind !== "assistant") continue;
      const chain = JSON.stringify([item.nodeId ?? "", item.attempt ?? 1, item.activation ?? 1]);
      if (seenChains.has(chain)) ids.add(item.id);
      seenChains.add(chain);
    }
    return ids;
  }, [displayItems]);
  const safeColumns = Math.max(1, columns);

  if (!scrollRef) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        {displayItems.map((item) => (
          <Box key={item.id} flexDirection="column" flexShrink={0} marginTop={1}>
            <LogMessageRow
              item={item}
              detailMode={detailMode}
              showAssistantDivider={assistantDividerIds.has(item.id)}
              columns={safeColumns}
            />
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <VirtualLogMessageList
      items={displayItems}
      detailMode={detailMode}
      scrollRef={scrollRef}
      columns={safeColumns}
      assistantDividerIds={assistantDividerIds}
    />
  );
}

function VirtualLogMessageList({
  items,
  detailMode,
  scrollRef,
  columns,
  assistantDividerIds
}: Required<LogMessageListProps> & { assistantDividerIds: ReadonlySet<string> }) {
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
          marginTop={1}
        >
          <LogMessageRow
            item={item}
            detailMode={detailMode}
            showAssistantDivider={assistantDividerIds.has(item.id)}
            columns={columns}
          />
        </Box>
      ))}
      {bottomSpacer > 0 ? <Box height={bottomSpacer} flexShrink={0} /> : null}
    </>
  );
}

function groupExplorationTools(items: TuiLogMessage[]): TuiLogMessage[] {
  const grouped: TuiLogMessage[] = [];
  for (let index = 0; index < items.length;) {
    const first = items[index];
    const firstEntry = explorationEntry(first);
    if (!firstEntry || first.kind !== "tool") {
      grouped.push(first);
      index += 1;
      continue;
    }

    const tools: TuiToolLogMessage[] = [first];
    const entries: TuiToolExplorationEntry[] = [firstEntry];
    const context = executionContext(first);
    let nextIndex = index + 1;
    while (nextIndex < items.length) {
      const candidate = items[nextIndex];
      const entry = explorationEntry(candidate);
      if (!entry || candidate.kind !== "tool" || executionContext(candidate) !== context) break;
      tools.push(candidate);
      entries.push(entry);
      nextIndex += 1;
    }

    const status = tools.some((tool) => tool.status === "running")
      ? "running"
      : tools.some((tool) => tool.status === "failed")
        ? "failed"
        : "completed";
    grouped.push({
      ...first,
      parentLogId: undefined,
      tool: "Exploration",
      status,
      text: status === "running" ? "Exploring" : "Explored",
      summary: "",
      detailText: "",
      compactDetailText: undefined,
      exploration: entries
    });
    index = nextIndex;
  }
  return grouped;
}

function explorationEntry(item: TuiLogMessage): TuiToolExplorationEntry | undefined {
  if (item.kind !== "tool") return undefined;
  const summary = item.summary;
  if (item.tool === "LS" || item.tool === "Glob") return { action: "List", summary };
  if (item.tool === "Read" || item.tool === "ArtifactRead") return { action: "Read", summary };
  if (item.tool === "Grep") return { action: "Search", summary };
  if (item.tool === "Bash" && isReadOnlyShellCommand({ command: summary })) return { action: "Run", summary };
  if (item.tool === "PowerShell" && isReadOnlyPowerShellCommand({ command: summary })) return { action: "Run", summary };
  return undefined;
}

function executionContext(item: TuiToolLogMessage): string {
  return JSON.stringify([item.nodeId, item.attempt, item.activation ?? 1]);
}
