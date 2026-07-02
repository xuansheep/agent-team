import { ModelMessage } from "../providers/types.js";

import { Tool } from "../tools/types.js";

export type RuntimeAttachmentType = "global_prompt" | "plan_mode" | "plan_mode_reminder" | "plan_mode_reentry" | "plan_mode_exit" | "auto_mode" | "auto_mode_reminder" | "auto_mode_exit" | "tool_prompts";

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

export function buildGlobalPromptAttachment(prompt: string | undefined): RuntimeAttachment | undefined {
  const content = prompt?.trim();
  if (!content) return undefined;
  return {
    type: "global_prompt",
    content: [
      attachmentMarker("global_prompt"),
      "## Global Instructions",
      "",
      content
    ].join("\n")
  };
}

export function buildAutoModeAttachment(input: { sparse?: boolean } = {}): RuntimeAttachment {
  if (input.sparse) {
    return {
      type: "auto_mode_reminder",
      content: [
        attachmentMarker("auto_mode_reminder"),
        "Auto mode still active (see full instructions earlier in conversation). Execute autonomously, minimize interruptions, prefer action over planning."
      ].join("\n")
    };
  }

  return {
    type: "auto_mode",
    content: [
      attachmentMarker("auto_mode"),
      "## Auto Mode Active",
      "",
      "Auto mode is active. The user chose continuous, autonomous execution. You should:",
      "",
      "1. Execute immediately - Start implementing right away. Make reasonable assumptions and proceed on low-risk work.",
      "2. Minimize interruptions - Prefer making reasonable assumptions over asking questions for routine decisions.",
      "3. Prefer action over planning - Do not enter plan mode unless the user explicitly asks. When in doubt, start coding.",
      "4. Expect course corrections - The user may provide suggestions or course corrections at any point; treat those as normal input.",
      "5. Do not take overly destructive actions - Auto mode is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation. If you reach such a decision point, ask and wait, or course correct to a safer method instead.",
      "6. Avoid data exfiltration - Post even routine messages to chat platforms or work tickets only if the user has directed you to. You must not share secrets unless the user has explicitly authorized both that specific secret and its destination."
    ].join("\n")
  };
}

export function buildAutoModeExitAttachment(): RuntimeAttachment {
  return {
    type: "auto_mode_exit",
    content: [
      attachmentMarker("auto_mode_exit"),
      "## Exited Auto Mode",
      "",
      "Auto mode is no longer active. Follow the current permission mode and ask for approval when required."
    ].join("\n")
  };
}

export function buildPlanModeAttachment(input: PlanModeAttachmentInput): RuntimeAttachment {
  if (input.sparse) {
    return {
      type: "plan_mode_reminder",
      content: [
        attachmentMarker("plan_mode_reminder"),
        `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${input.planFilePath}). Follow the 5-phase workflow. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.`
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
    "### Phase 5: Call ExitPlanMode",
    "At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.",
    "This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons.",
    "",
    "Important: Use AskUserQuestion ONLY to clarify requirements or choose between approaches. Use ExitPlanMode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like \"Is this plan okay?\", \"Should I proceed?\", \"How does this plan look?\", \"Any changes before we start?\", or similar MUST use ExitPlanMode.",
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
      "4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ExitPlanMode.",
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
