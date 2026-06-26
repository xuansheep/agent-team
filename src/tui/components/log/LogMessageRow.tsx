import React from "react";
import { Box, Text } from "../../ink.js";
import type { TuiLogMessage, TuiPermissionLogMessage } from "../../logTypes.js";
import { truncate, truncateToolDetail } from "../../toolDisplay.js";
import { MessageResponse } from "./MessageResponse.js";
import { ToolUseLoader } from "./ToolUseLoader.js";
export function LogMessageRow({ item, detailMode }: { item: TuiLogMessage; detailMode: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserLogMessage item={item} />;
    case "tool":
      return <ToolLogMessage item={item} detailMode={detailMode} />;
    case "permission":
      return <PermissionLogMessage item={item} detailMode={detailMode} />;
    case "assistant":
      return <DotLogMessage color="green" text={item.text} detailText={item.detailText} detailVisible={item.detailVisible} detailMode={detailMode} />;
    case "status":
      return <DotLogMessage color="yellow" text={item.text} detailText={item.detailText} detailVisible={item.detailVisible} detailMode={detailMode} />;
  }
}
function UserLogMessage({ item }: { item: TuiLogMessage & { kind: "user" } }) {
  return (
    <Box flexDirection="column" marginTop={1} backgroundColor="ansi256(236)" paddingX={1}>
      <Text wrap="wrap">{truncate(item.text, 1200)}</Text>
    </Box>
  );
}
function ToolLogMessage({ item, detailMode }: { item: TuiLogMessage & { kind: "tool" }; detailMode: boolean }) {
  const title = toolLogTitle(item);
  const showDetail = Boolean(item.detailText && (detailMode || item.status === "completed" || item.status === "failed"));
  const content = (
    <Box flexDirection="column" marginTop={item.parentLogId ? 0 : 1}>
      <Box flexDirection="row" flexWrap="nowrap">
        {item.parentLogId ? null : <ToolUseLoader status={item.status} />}
        <Text bold>{title.text}</Text>
        {title.summary ? <Text wrap="truncate-end"> ({truncate(title.summary, 240)})</Text> : null}
      </Box>
      {showDetail ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{truncateToolDetail(item.detailText ?? "", detailMode ? 1200 : 400)}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
  return item.parentLogId ? <MessageResponse>{content}</MessageResponse> : content;
}
function toolLogTitle(item: TuiLogMessage & { kind: "tool" }): { text: string; summary?: string } {
  const verb = item.status === "running" ? "Running" : "Ran";
  if ((item.tool === "Bash" || item.tool === "PowerShell") && item.summary) return { text: `${verb} ${truncate(item.summary, 240)}` };
  const detail = item.summary ? ` ${truncate(item.summary, 240)}` : "";
  return { text: `${verb} ${item.text}${detail}` };
}
function PermissionLogMessage({ item, detailMode }: { item: TuiPermissionLogMessage; detailMode: boolean }) {
  const color = item.status === "allowed" ? "green" : item.status === "denied" ? "red" : "yellow";
  return <DotLogMessage color={color} text={item.text} detailText={item.detailText} detailVisible={item.detailVisible} detailMode={detailMode} />;
}
function DotLogMessage({
  color,
  text,
  detailText,
  detailVisible,
  detailMode
}: {
  color: "green" | "red" | "yellow";
  text: string;
  detailText?: string;
  detailVisible?: boolean;
  detailMode: boolean;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Box minWidth={2}>
          <Text color={color}>●</Text>
        </Box>
        <Text wrap="wrap">{truncate(text, 1200)}</Text>
      </Box>
      {(detailMode || detailVisible) && detailText ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{truncate(detailText, 1200)}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
}
