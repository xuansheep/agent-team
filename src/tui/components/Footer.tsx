import React from "react";
import { Text } from "../ink.js";

export function Footer({ mode }: { mode: string }) {
  return <Text dimColor>mode {mode} | Ctrl+C stop</Text>;
}
