import { memo } from "react";
import { Box, Text } from "../../ink.js";
import type { TuiLogMessage, TuiPermissionLogMessage, TuiPlanLogMessage } from "../../logTypes.js";
import { sanitizeToolLogText, truncate, truncateToolDetail } from "../../toolDisplay.js";
import { LogStatusDot, type LogStatusDotTone } from "./LogStatusDot.js";
import { MessageResponse } from "./MessageResponse.js";
import { ToolUseLoader } from "./ToolUseLoader.js";

function LogMessageRowComponent({
  item,
  detailMode,
  showAssistantDivider = false,
  columns = 80
}: {
  item: TuiLogMessage;
  detailMode: boolean;
  showAssistantDivider?: boolean;
  columns?: number;
}) {
  switch (item.kind) {
    case "user":
      return <UserLogMessage item={item} />;
    case "tool":
      return <ToolLogMessage item={item} detailMode={detailMode} columns={columns} />;
    case "permission":
      return <PermissionLogMessage item={item} detailMode={detailMode} />;
    case "plan":
      return <PlanLogMessage item={item} detailMode={detailMode} />;
    case "assistant":
      return (
        <DotLogMessage
          tone="white"
          text={item.text}
          detailText={item.detailText}
          detailVisible={item.detailVisible}
          detailMode={detailMode}
          showDivider={showAssistantDivider}
          columns={columns}
        />
      );
    case "status":
      return <StatusLogMessage item={item} detailMode={detailMode} />;
  }
}

export const LogMessageRow = memo(
  LogMessageRowComponent,
  (previous, next) => (
    previous.item === next.item
    && previous.detailMode === next.detailMode
    && previous.showAssistantDivider === next.showAssistantDivider
    && previous.columns === next.columns
  )
);

function UserLogMessage({ item }: { item: TuiLogMessage & { kind: "user" } }) {
  return (
    <Box flexDirection="column" backgroundColor="ansi256(236)" paddingX={1}>
      <Text wrap="wrap">{truncate(item.text, 1200)}</Text>
    </Box>
  );
}

function ToolLogMessage({
  item,
  detailMode,
  columns
}: {
  item: TuiLogMessage & { kind: "tool" };
  detailMode: boolean;
  columns: number;
}) {
  if (item.exploration) return <ExplorationLogMessage item={item} columns={columns} />;

  const title = toolLogTitle(item);
  const fullTitle = title.summary ? `${title.text} (${truncate(title.summary, 240)})` : title.text;
  const titleLines = wrapDisplayText(fullTitle, Math.max(1, columns - 4));
  const detailText = detailMode
    ? item.detailText ? sanitizeToolLogText(item.detailText) : undefined
    : compactToolDetail(item);
  const showDetail = Boolean(detailText);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap">
        <ToolUseLoader status={item.status} />
        <Box flexDirection="column" flexShrink={1}>
          <Text bold>{titleLines[0] ?? ""}</Text>
          {titleLines.slice(1).map((line, index) => (
            <Text key={index} wrap="truncate-end">
              <Text dimColor>{"\u2502 "}</Text>
              <Text bold>{line}</Text>
            </Text>
          ))}
        </Box>
      </Box>
      {showDetail ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{detailMode ? detailText : truncateToolDetail(detailText ?? "", 400)}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
}

function ExplorationLogMessage({
  item,
  columns
}: {
  item: TuiLogMessage & { kind: "tool" };
  columns: number;
}) {
  const tone = item.status === "running" ? "deepGray" : item.status === "failed" ? "red" : "green";
  const lines = (item.exploration ?? []).flatMap((entry) => {
    const summary = sanitizeToolLogText(entry.summary);
    const text = summary ? `${entry.action} ${summary}` : entry.action;
    return wrapDisplayText(text, Math.max(1, columns - 4));
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap">
        <LogStatusDot tone={tone} blinking={item.status === "running"} />
        <Text bold>{item.status === "running" ? "Exploring" : "Explored"}</Text>
      </Box>
      {lines.map((line, index) => (
        <Text key={index} dimColor wrap="truncate-end">
          {index === 0 ? "  \u2514 " : "    "}{line}
        </Text>
      ))}
    </Box>
  );
}

function compactToolDetail(item: TuiLogMessage & { kind: "tool" }): string | undefined {
  if (item.compactDetailText) return sanitizeToolLogText(item.compactDetailText);
  if (!item.detailText) return undefined;
  const lines = sanitizeToolLogText(item.detailText).split(/\r?\n/).filter(Boolean);
  const hint = lines.find((line) => line.includes("ctrl + o to view transcript"));
  const error = item.status === "failed" ? lines.find((line) => line.startsWith("Error:")) : undefined;
  return [error, hint].filter(Boolean).join("\n") || undefined;
}

function toolLogTitle(item: TuiLogMessage & { kind: "tool" }): { text: string; summary?: string } {
  const verb = item.status === "running" ? "Running" : "Ran";
  const summary = sanitizeToolLogText(item.summary);
  const displayName = sanitizeToolLogText(item.text);
  if ((item.tool === "Bash" || item.tool === "PowerShell") && summary) return { text: `${verb} ${truncate(summary, 240)}` };
  const detail = summary ? ` ${truncate(summary, 240)}` : "";
  return { text: `${verb} ${displayName}${detail}` };
}

function wrapDisplayText(text: string, width: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  for (const sourceLine of text.split(/\r?\n/)) {
    let remaining = sourceLine;
    while (remaining.length > width) {
      let splitAt = remaining.lastIndexOf(" ", width);
      if (splitAt <= 0) splitAt = width;
      lines.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

function PermissionLogMessage({ item, detailMode }: { item: TuiPermissionLogMessage; detailMode: boolean }) {
  const tone = item.status === "allowed" ? "green" : item.status === "denied" ? "red" : "yellow";
  return <DotLogMessage tone={tone} text={item.text} detailText={item.detailText} detailVisible={item.detailVisible} detailMode={detailMode} />;
}

function PlanLogMessage({ item }: { item: TuiPlanLogMessage; detailMode: boolean }) {
  const tone = item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "deepGray";
  const statusText = item.status === "approved" ? "approved" : item.status === "rejected" ? "needs revision" : "pending approval";
  const isExitOnly = item.text === "Exit Plan Mode";
  const showPlanApprovalLabel = item.status === "pending" && !isExitOnly;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap">
        <LogStatusDot tone={tone} blinking={item.status === "pending"} />
        <Text bold>Plan Review</Text>
        <Text dimColor> ({statusText})</Text>
      </Box>
      {item.status === "rejected" && item.detailText ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">{item.detailText}</Text>
        </Box>
      ) : null}
      {item.requestedPermissions?.length ? (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text bold>Requested permissions:</Text>
          {item.requestedPermissions.map((permission, index) => (
            <Text key={index} dimColor wrap="wrap">  · {permission.tool}(prompt: {permission.prompt})</Text>
          ))}
        </Box>
      ) : null}
      {showPlanApprovalLabel ? (
        <Box paddingLeft={2} marginTop={1}>
          <Text>Here is Einstein's plan:</Text>
        </Box>
      ) : null}
      <PlanDocumentBlock text={item.document} path={showPlanApprovalLabel ? item.path : undefined} />
    </Box>
  );
}

function PlanDocumentBlock({ text, path }: { text: string; path?: string }) {
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {path ? <Text dimColor wrap="truncate-end">Plan saved to: {path} · /plan to edit</Text> : null}
        <SimpleMarkdown text={text} />
      </Box>
    </MessageResponse>
  );
}

function StatusLogMessage({ item, detailMode }: { item: TuiLogMessage & { kind: "status" }; detailMode: boolean }) {
  return (
    <DotLogMessage
      tone="deepGray"
      text={item.text}
      textDim
      detailText={item.detailText}
      detailVisible={item.detailVisible}
      detailMode={detailMode}
    />
  );
}

function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  let inCode = false;
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        if (/^```/.test(line.trim())) {
          inCode = !inCode;
          return <Text key={index} dimColor>{line}</Text>;
        }
        if (inCode) return <Text key={index} color="ansi256(250)" wrap="wrap">{line || " "}</Text>;
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) return <Text key={index} bold wrap="wrap">{heading[0]}</Text>;
        const listItem = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
        if (listItem) return <Text key={index} wrap="wrap">{line}</Text>;
        return <Text key={index} wrap="wrap">{line || " "}</Text>;
      })}
    </Box>
  );
}

function DotLogMessage({
  tone,
  blinking = false,
  text,
  textDim = false,
  detailText,
  detailVisible,
  detailMode,
  showDivider = false,
  columns = 80
}: {
  tone: LogStatusDotTone;
  blinking?: boolean;
  text: string;
  textDim?: boolean;
  detailText?: string;
  detailVisible?: boolean;
  detailMode: boolean;
  showDivider?: boolean;
  columns?: number;
}) {
  return (
    <Box flexDirection="column">
      {showDivider ? (
        <Box marginBottom={1}>
          <Text color="ansi256(240)" wrap="truncate-end">{"\u2500".repeat(Math.max(1, columns))}</Text>
        </Box>
      ) : null}
      <Box flexDirection="row" flexWrap="nowrap">
        <LogStatusDot tone={tone} blinking={blinking} />
        <Text dimColor={textDim} wrap="wrap">{text}</Text>
      </Box>
      {(detailMode || detailVisible) && detailText ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{detailText}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
}
