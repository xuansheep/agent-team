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
  const humanTurnCount = Math.max(0, messages.filter(isHumanTurn).length - 1);
  const planAttachments = attachments.filter((attachment) => isPlanModeAttachment(attachment.type));
  const systemAttachments = attachments.filter((attachment) => !isPlanModeAttachment(attachment.type));
  const baseMessages: ModelMessage[] = [
    ...systemAttachments.map((attachment) => ({
      role: "system" as const,
      content: attachment.content,
      metadata: { runtimeAttachment: { type: attachment.type, humanTurnCount } }
    })),
    ...messages
  ];
  if (!planAttachments.length) return baseMessages;
  const planMessages = planAttachments.map((attachment) => ({
    role: "user" as const,
    content: wrapInSystemReminder(attachment.content),
    metadata: { runtimeAttachment: { type: attachment.type, humanTurnCount } }
  }));
  const insertAt = lastHumanTurnIndex(baseMessages);
  if (insertAt < 0) return [...baseMessages, ...planMessages];
  return [
    ...baseMessages.slice(0, insertAt),
    ...planMessages,
    ...baseMessages.slice(insertAt)
  ];
}

export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>
${content}
</system-reminder>`;
}


function isPlanModeAttachment(type: string): boolean {
  return type === "plan_mode" || type === "plan_mode_reminder" || type === "plan_mode_reentry" || type === "plan_mode_exit";
}

function isHumanTurn(message: ModelMessage): boolean {
  return message.role === "user" && !message.metadata?.runtimeAttachment;
}

function lastHumanTurnIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanTurn(messages[index]!)) return index;
  }
  return -1;
}
