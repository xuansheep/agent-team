import { RuntimeTurnExecutor } from "../runtime/turnExecutor.js";
import { ToolRegistry } from "../tools/registry.js";
import { LocalAgentTaskInput, TaskHandler, TaskRunResult } from "./types.js";

export function createLocalAgentTask(): TaskHandler {
  return async (task): Promise<TaskRunResult> => {
    const input = parseLocalAgentInput(task.input);
    const sessionId = input.sessionId ?? `${task.id}:agent`;
    const events: unknown[] = [];
    const result = await new RuntimeTurnExecutor().execute({
      messages: input.messages.map((message) => ({ ...message })),
      model: input.model,
      provider: input.provider,
      tools: input.tools ?? new ToolRegistry(),
      permissions: {
        mode: input.permissions?.mode ?? "default",
        prePlanMode: input.permissions?.prePlanMode,
        allow: input.permissions?.allow ?? [],
        ask: input.permissions?.ask ?? [],
        deny: input.permissions?.deny ?? [],
        source: input.permissions?.source,
        planFilePath: input.permissions?.planFilePath
      },
      cwd: input.cwd,
      sessionId,
      eventSink: (event) => { events.push(event); }
    });

    if (result.status === "failed") return { status: "failed", error: result.error, events };
    return {
      status: "completed",
      sessionId,
      events,
      result: { status: result.status, messages: result.messages },
      output: assistantOutput(result.messages)
    };
  };
}

function parseLocalAgentInput(input: unknown): LocalAgentTaskInput {
  if (!input || typeof input !== "object") throw new Error("Local agent task input must be an object");
  const value = input as Partial<LocalAgentTaskInput>;
  if (!value.provider) throw new Error("Local agent task requires provider");
  if (!value.model) throw new Error("Local agent task requires model");
  if (!Array.isArray(value.messages)) throw new Error("Local agent task requires messages");
  if (!value.cwd) throw new Error("Local agent task requires cwd");
  return value as LocalAgentTaskInput;
}

function assistantOutput(messages: LocalAgentTaskInput["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && typeof message.content === "string") return message.content;
  }
  return undefined;
}
