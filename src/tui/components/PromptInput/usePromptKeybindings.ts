import { useInput } from "ink";
import { parseSlashCommand } from "../../commands.js";
import { backspace, clearBuffer, insertNewline, insertText, moveLeft, moveRight } from "./usePromptBuffer.js";
import { nextHistory, previousHistory, pushHistory } from "./usePromptHistory.js";
import { resolvePromptKey } from "./keybindings.js";
import { PromptBuffer, PromptHistory, PromptInputEvent, PromptInputMode } from "./types.js";

export function usePromptKeybindings(input: {
  mode: PromptInputMode;
  buffer: PromptBuffer;
  history: PromptHistory;
  isLoading: boolean;
  onBuffer: (buffer: PromptBuffer) => void;
  onHistory: (history: PromptHistory) => void;
  onEvent: (event: PromptInputEvent) => void;
}) {
  useInput((value, key) => {
    const action = resolvePromptKey(value, key);
    if (action === "submit") {
      const text = input.buffer.text.trim();
      if (!text) return;

      const command = parseSlashCommand(text);
      input.onHistory(pushHistory(input.history, text));
      input.onBuffer(clearBuffer());
      if (input.isLoading) {
        input.onEvent({ type: "queue", text });
      } else if (command) {
        input.onEvent({ type: "command", name: command.name, args: command.args });
      } else {
        input.onEvent({ type: "submit", text });
      }
      return;
    }

    if (action === "newline") input.onBuffer(insertNewline(input.buffer));
    else if (action === "cancel") input.onEvent({ type: "cancel" });
    else if (action === "backspace") input.onBuffer(backspace(input.buffer));
    else if (action === "left") input.onBuffer(moveLeft(input.buffer));
    else if (action === "right") input.onBuffer(moveRight(input.buffer));
    else if (action === "history_previous") {
      const previous = previousHistory(input.history);
      input.onHistory(previous.history);
      input.onBuffer({ text: previous.value, cursor: previous.value.length });
    } else if (action === "history_next") {
      const next = nextHistory(input.history);
      input.onHistory(next.history);
      input.onBuffer({ text: next.value, cursor: next.value.length });
    } else if (value) {
      input.onBuffer(insertText(input.buffer, value));
    }
  });
}
