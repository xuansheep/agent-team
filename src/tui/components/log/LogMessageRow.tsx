import React from "react";
import { Box, Text } from "../../ink.js";
import type { TuiLogMessage, TuiPermissionLogMessage } from "../../logTypes.js";
import { truncate } from "../../toolDisplay.js";
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
      return <DotLogMessage color="green" text={item.text} detailText={item.detailText} detailMode={detailMode} />;
    case "status":
      return <DotLogMessage color="yellow" text={item.text} detailText={item.detailText} detailMode={detailMode} />;
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
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" flexWrap="nowrap">
        <ToolUseLoader status={item.status} />
        <Text bold>{item.text}</Text>
        {item.summary ? <Text wrap="truncate-end"> ({truncate(item.summary, 240)})</Text> : null}
      </Box>
      {detailMode && item.detailText ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{truncate(item.detailText, 1200)}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
}

function PermissionLogMessage({ item, detailMode }: { item: TuiPermissionLogMessage; detailMode: boolean }) {
  const color = item.status === "allowed" ? "green" : item.status === "denied" ? "red" : "yellow";
  return <DotLogMessage color={color} text={item.text} detailText={item.detailText} detailMode={detailMode} />;
}

function DotLogMessage({
  color,
  text,
  detailText,
  detailMode
}: {
  color: "green" | "red" | "yellow";
  text: string;
  detailText?: string;
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
      {detailMode && detailText ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">{truncate(detailText, 1200)}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
}
