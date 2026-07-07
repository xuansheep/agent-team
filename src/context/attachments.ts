import { ModelMessage } from "../providers/types.js";

import { Tool } from "../tools/types.js";

export type RuntimeAttachmentType = "global_prompt" | "plan_mode" | "plan_mode_reminder" | "plan_mode_reentry" | "plan_mode_exit" | "tool_prompts";

export type RuntimeAttachment = {
  type: RuntimeAttachmentType;
  content: string;
};

export type PlanModeAttachmentInput = {
  sessionId: string;
  planFilePath: string;
  draft?: string;
  sparse?: boolean;
};

export type PlanModeExitAttachmentInput = {
  planFilePath?: string;
};

export type PlanModeReentryAttachmentInput = {
  planFilePath: string;
};

export type ToolPromptsAttachmentInput = {
  tools: Tool[];
};

const globalPromptInstruction =
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

export function buildGlobalPromptAttachment(prompt: string | undefined): RuntimeAttachment | undefined {
  const content = prompt?.trim();
  if (!content) return undefined;
  return {
    type: "global_prompt",
    content: [
      attachmentMarker("global_prompt"),
      "## Global Instructions",
      "",
      globalPromptInstruction,
      "",
      content
    ].join("\n")
  };
}

export function buildPlanModeAttachment(input: PlanModeAttachmentInput): RuntimeAttachment {
  if (input.sparse) {
    return {
      type: "plan_mode_reminder",
      content: [
        attachmentMarker("plan_mode_reminder"),
        `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${input.planFilePath}). Follow the Plan Workflow. If you write or edit the plan file in this turn, you must call ExitPlanMode before ending the turn.`
      ].join("\n")
    };
  }

  const planFileInfo = input.draft === undefined
    ? `No plan file exists yet. You should create your plan at ${input.planFilePath} using Write.`
    : `A plan file already exists at ${input.planFilePath}. You can read it and make incremental edits using Edit or MultiEdit.`;
  const lines = [
    attachmentMarker("plan_mode"),
    `Session: ${input.sessionId}`,
    "Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.",
    "",
    "## Plan File Info:",
    planFileInfo,
    "You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.",
    "If you write or edit the plan file in this turn, you must call ExitPlanMode before ending the turn.",
    "",
    "## Plan Workflow",
    "",
    "### Phase 1: Initial Understanding",
    "Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.",
    "1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused - avoid proposing new code when suitable implementations already exist.",
    "",
    "### Phase 2: Design",
    "Goal: Design an implementation approach based on the user's intent and your exploration results from Phase 1.",
    "",
    "### Phase 3: Review",
    "Goal: Review the plan and ensure alignment with the user's intentions.",
    "1. Read the critical files identified during exploration to deepen your understanding.",
    "2. Ensure that the plan aligns with the user's original request.",
    "3. Use AskUserQuestion to clarify any remaining questions with the user.",
    "",
    "### Phase 4: Final Plan",
    "Goal: Write your final plan to the plan file (the only file you can edit).",
    "- List the paths of files to be modified and what changes in each.",
    "- Reference existing functions and utilities to reuse, with their file paths.",
    "- Include verification describing how to test the changes end-to-end.",
    "",
    "NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the AskUserQuestion tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins."
  ];

  return { type: "plan_mode", content: lines.join("\n") };
}

export function buildPlanModeExitAttachment(input: PlanModeExitAttachmentInput): RuntimeAttachment {
  const planReference = input.planFilePath
    ? ` The plan file is located at ${input.planFilePath} if you need to reference it.`
    : "";
  const lines = [
    attachmentMarker("plan_mode_exit"),
    "## Exited Plan Mode",
    "",
    `You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`
  ];
  return {
    type: "plan_mode_exit",
    content: lines.join("\n")
  };
}

export function buildPlanModeReentryAttachment(input: PlanModeReentryAttachmentInput): RuntimeAttachment {
  return {
    type: "plan_mode_reentry",
    content: [
      attachmentMarker("plan_mode_reentry"),
      "## Re-entering Plan Mode",
      "",
      `You are returning to plan mode after having previously exited it. A plan file exists at ${input.planFilePath} from your previous planning session.`,
      "",
      "Before proceeding with any new planning, you should:",
      "1. Read the existing plan file to understand what was previously planned.",
      "2. Evaluate the user's current request against that plan.",
      "3. Decide how to proceed:",
      "   - Different task: if the user's request is for a different task, start fresh by overwriting the existing plan.",
      "   - Same task, continuing: if this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections.",
      "",
      "Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first."
    ].join("\n")
  };
}

export function buildToolPromptsAttachment(input: ToolPromptsAttachmentInput): RuntimeAttachment | undefined {
  const entries = input.tools.flatMap((tool) => {
    const prompt = typeof tool.prompt === "function" ? tool.prompt() : tool.prompt;
    return prompt?.trim() ? [{ name: tool.name, prompt: prompt.trim() }] : [];
  });
  if (!entries.length) return undefined;
  return {
    type: "tool_prompts",
    content: [
      attachmentMarker("tool_prompts"),
      "## Tool Prompts",
      "",
      "The following tool-specific instructions supplement the short tool descriptions in the tool schema.",
      ...entries.flatMap((entry) => ["", `### ${entry.name}`, entry.prompt])
    ].join("\n")
  };
}

export function hasRuntimeAttachment(messages: ModelMessage[], type: RuntimeAttachmentType): boolean {
  const marker = attachmentMarker(type);
  return messages.some((message) => typeof message.content === "string" && message.content.includes(marker));
}

function attachmentMarker(type: RuntimeAttachmentType): string {
  return `ATTACHMENT ${type}`;
}
