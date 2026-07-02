import { useRef } from "react";
import { Box, Text } from "../../ink.js";
import { useAnimationFrame } from "../../../ink/hooks/use-animation-frame.js";
import type { TuiToolLogMessage } from "../../logTypes.js";

export function ToolUseLoader({ status }: { status: TuiToolLogMessage["status"] }) {
  const color = status === "failed" ? "red" : status === "completed" ? "green" : "yellow";
  const [animationRef, animationTime] = useAnimationFrame(status === "running" ? 250 : null);
  const firstFrameRef = useRef<number>();
  if (firstFrameRef.current === undefined || status !== "running") firstFrameRef.current = animationTime;
  const dimRunningDot = status === "running" && Math.floor((animationTime - firstFrameRef.current) / 250) % 2 === 1;
  return (
    <Box ref={animationRef} minWidth={2}>
      <Text color={color} dimColor={dimRunningDot}>●</Text>
    </Box>
  );
}
