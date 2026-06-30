import type { Tool, ToolContext, ToolResult } from "../../tools/types.js";

export type KernelUserInteractionRequest =
  | { type: "ask_user_question"; questions?: unknown[] }
  | { type: "plan_approval" };

export type KernelTool<TInput = unknown, TResult extends ToolResult = ToolResult> = {
  name: string;
  description: string;
  prompt?: string | (() => string);
  input_schema: Record<string, unknown>;
  shouldDefer(input: TInput, context: ToolContext): boolean | Promise<boolean>;
  isReadOnly(input: TInput, context: ToolContext): boolean | Promise<boolean>;
  requiresUserInteraction(
    input: TInput,
    context: ToolContext
  ): KernelUserInteractionRequest | null | Promise<KernelUserInteractionRequest | null>;
  validateInput(input: unknown, context: ToolContext): Promise<{ result: true; input: TInput } | { result: false; message: string }>;
  execute(input: TInput, context: ToolContext): Promise<TResult>;
  mapToolResultToModelResult(result: TResult, context: ToolContext): unknown;
  legacyTool: Tool;
};

export function adaptToolToKernelTool(tool: Tool): KernelTool {
  return {
    name: tool.name,
    description: tool.description,
    prompt: tool.prompt,
    input_schema: tool.input_schema,
    shouldDefer: () => false,
    isReadOnly: async (input, context) => await tool.isReadOnly?.(input, context) === true,
    requiresUserInteraction: async (input) => {
      if (await tool.requiresUserInteraction?.(input) !== true) return null;
      if (tool.name === "AskUserQuestion") return { type: "ask_user_question", questions: questionList(input) };
      if (tool.name === "ExitPlanMode") return { type: "plan_approval" };
      return { type: "ask_user_question" };
    },
    validateInput: async (input, context) => {
      const validation = await tool.validateInput?.(input, context);
      if (validation && !validation.result) return validation;
      return { result: true, input };
    },
    execute: (input, context) => tool.execute(input, context),
    mapToolResultToModelResult: (result) => tool.mapToolResultToModelResult?.(result) ?? result,
    legacyTool: tool
  };
}

function questionList(input: unknown): unknown[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const questions = (input as { questions?: unknown }).questions;
  return Array.isArray(questions) ? questions : undefined;
}
