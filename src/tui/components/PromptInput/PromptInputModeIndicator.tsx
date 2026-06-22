import React from "react";
import { Text } from "ink";
import { PromptInputMode } from "./types.js";

export function PromptInputModeIndicator({ mode }: { mode: PromptInputMode }) {
  return <Text color={mode === "running" ? "yellow" : "cyan"}>{mode.toUpperCase()}</Text>;
}
