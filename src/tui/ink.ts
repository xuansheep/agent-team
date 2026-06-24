export { default as render, renderSync, createRoot } from "../ink/root.js";
export { AlternateScreen } from "../ink/components/AlternateScreen.js";
export { default as Box } from "../ink/components/Box.js";
export { default as ScrollBox } from "../ink/components/ScrollBox.js";
export { default as Text } from "../ink/components/Text.js";
export { default as useApp } from "../ink/hooks/use-app.js";
export { default as useInput } from "../ink/hooks/use-input.js";
export { default as useStdin } from "../ink/hooks/use-stdin.js";
export { useDeclaredCursor } from "../ink/hooks/use-declared-cursor.js";
export { useHasSelection, useSelection } from "../ink/hooks/use-selection.js";
export type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";

export function useStdout(): { stdout: NodeJS.WriteStream } {
  return { stdout: process.stdout };
}
