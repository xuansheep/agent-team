import React from "react";
import { Text } from "ink";

export function PromptInputHistory({ count }: { count: number }) {
  if (count === 0) return null;
  return <Text dimColor>history {count}</Text>;
}
