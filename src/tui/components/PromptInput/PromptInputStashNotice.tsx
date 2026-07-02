import { Text } from "../../ink.js";

export function PromptInputStashNotice({ hasStash }: { hasStash: boolean }) {
  if (!hasStash) return null;
  return <Text color="yellow">unsent input stashed</Text>;
}
