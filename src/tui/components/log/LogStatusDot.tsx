import { useRef } from "react";
import { Box, Text } from "../../ink.js";
import { useAnimationFrame } from "../../../ink/hooks/use-animation-frame.js";

export type LogStatusDotTone = "deepGray" | "white" | "yellow" | "green" | "red";

const BLINK_INTERVAL_MS = 250;
const DOT_CHARACTER = "\u25cf";
const DOT_COLORS = {
  deepGray: "ansi256(240)",
  white: "white",
  yellow: "yellow",
  green: "green",
  red: "red"
} as const;

export function LogStatusDot({
  tone,
  blinking = false
}: {
  tone: LogStatusDotTone;
  blinking?: boolean;
}) {
  const [animationRef, animationTime] = useAnimationFrame(blinking ? BLINK_INTERVAL_MS : null);
  const firstFrameRef = useRef<number>();
  if (firstFrameRef.current === undefined || !blinking) firstFrameRef.current = animationTime;
  const firstFrame = firstFrameRef.current ?? animationTime;
  const visible = !blinking || Math.floor((animationTime - firstFrame) / BLINK_INTERVAL_MS) % 2 === 0;

  return (
    <Box ref={animationRef} minWidth={2}>
      <Text color={DOT_COLORS[tone]}>{visible ? DOT_CHARACTER : " "}</Text>
    </Box>
  );
}
