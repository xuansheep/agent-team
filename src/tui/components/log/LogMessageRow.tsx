import React from "react";
import { Box, Text } from "../../ink.js";
import type { TuiLogMessage, TuiPermissionLogMessage, TuiPlanLogMessage } from "../../logTypes.js";
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
    case "plan":
      return <PlanLogMessage item={item} detailMode={detailMode} />;
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
  const detailText = detailMode ? item.detailText : compactToolDetail(item);
  const showDetail = Boolean(detailText);
  const content = (
    <Box flexDirection="column" marginTop={item.parentLogId ? 0 : 1}>
      <Box flexDirection="row" flexWrap="nowrap">
        {item.parentLogId ? null : <ToolUseLoader status={item.status} />}
        <Text bold>{title.text}</Text>
        {title.summary ? <Text wrap="truncate-end"> ({truncate(title.summary, 240)})</Text> : null}
      </Box>
      {showDetail ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{truncateToolDetail(detailText ?? "", detailMode ? 6000 : 400)}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
  return item.parentLogId ? <MessageResponse>{content}</MessageResponse> : content;
}
function compactToolDetail(item: TuiLogMessage & { kind: "tool" }): string | undefined {
  if (!item.detailText) return undefined;
  const lines = item.detailText.split(/\r?\n/).filter(Boolean);
  const hint = lines.find((line) => line.includes("ctrl + o to view transcript"));
  const error = item.status === "failed" ? lines.find((line) => line.startsWith("错误：")) : undefined;
  return [error, hint].filter(Boolean).join("\n") || undefined;
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
function PlanLogMessage({ item }: { item: TuiPlanLogMessage; detailMode: boolean }) {
  const color = item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "yellow";
  const statusText = item.status === "approved" ? "approved" : item.status === "rejected" ? "needs revision" : "pending approval";
  const isExitOnly = item.text === "Exit Plan Mode";
  const showPlanApprovalLabel = item.status === "pending" && !isExitOnly;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Box minWidth={2}>
          <Text color={color}>●</Text>
        </Box>
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
          <Text>Here is Claude's plan:</Text>
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
        <Text wrap="wrap">{text}</Text>
      </Box>
      {(detailMode || detailVisible) && detailText ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{detailText}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
}
