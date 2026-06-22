import React from "react";
import { Text } from "ink";

export function PromptInputStashNotice({ hasStash }: { hasStash: boolean }) {
  if (!hasStash) return null;
  return <Text color="yellow">unsent input stashed</Text>;
}
