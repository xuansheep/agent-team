import { ModelContentPart, ModelMessage } from "../providers/types.js";
import { RuntimeAttachment } from "./attachments.js";

export type BuildRuntimeMessagesInput = {
  system: string;
  user: string | ModelContentPart[];
  attachments?: RuntimeAttachment[];
};

export function buildRuntimeMessages(input: BuildRuntimeMessagesInput): ModelMessage[] {
  return withRuntimeAttachments([
    { role: "system", content: input.system },
    { role: "user", content: input.user }
  ], input.attachments ?? []);
}

export function withRuntimeAttachments(messages: ModelMessage[], attachments: RuntimeAttachment[]): ModelMessage[] {
  if (!attachments.length) return messages.slice();
  return [
    ...attachments.map((attachment) => ({ role: "system" as const, content: attachment.content })),
    ...messages
  ];
}
