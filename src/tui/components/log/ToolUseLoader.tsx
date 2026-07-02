import { Box, Text } from "../../ink.js";
import type { TuiToolLogMessage } from "../../logTypes.js";

export function ToolUseLoader({ status }: { status: TuiToolLogMessage["status"] }) {
  const color = status === "failed" ? "red" : status === "completed" ? "green" : "yellow";
  return (
    <Box minWidth={2}>
      <Text color={color} dimColor={status === "running"}>●</Text>
    </Box>
  );
}
