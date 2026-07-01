import { ModelMessage } from "../providers/types.js";

import { Tool } from "../tools/types.js";

export type RuntimeAttachmentType = "plan_mode" | "plan_mode_reminder" | "plan_mode_reentry" | "plan_mode_exit" | "auto_mode" | "auto_mode_reminder" | "auto_mode_exit" | "tool_prompts";

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
        "Plan mode still active. Stay read-only except for the current plan file.",
        "Follow the iterative workflow: explore the codebase, interview the user when needed, and keep the final plan in the current plan file.",
        "End turns only with AskUserQuestion for clarifications or ExitPlanMode for plan approval.",
        "Call ExitPlanMode only after the current plan file contains the complete plan.",
        "Never ask about plan approval via plain text or AskUserQuestion."
      ].join("\n")
    };
  }

  const planFileInfo = input.draft === undefined
    ? `No plan has been saved yet. Create your plan at ${input.planFilePath} using Write.`
    : `A previous plan exists at ${input.planFilePath}. Read it and make incremental edits using Edit or MultiEdit.`;
  const lines = [
    attachmentMarker("plan_mode"),
    `Session: ${input.sessionId}`,
    "Plan mode is active. The user indicated that they do not want execution yet.",
    "If the user asks you to modify, edit, implement, delete, or otherwise change files while Plan Mode is active, treat that as a request to plan the change, not to perform it.",
    "You MUST NOT make edits, run non-readonly tools, change configs, make commits, start workflow execution, or otherwise change the system before approval, with the sole exception of the current plan file listed below.",
    "This supersedes any conflicting instruction.",
    "",
    "## Plan File Info",
    `Current plan file: ${input.planFilePath}`,
    planFileInfo,
    "This is the only file you are allowed to edit while plan mode is active. All other actions must be read-only.",
    "In Plan Mode, call Write/Edit/MultiEdit with the plan content or edits; the runtime automatically targets the current plan file.",
    "",
    "## Iterative Planning Workflow",
    "You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you cannot make alone, and maintain the plan in the current plan file.",
    "Do not write source files while planning. Keep the complete plan in the current plan file.",
    "",
    "### The Loop",
    "Repeat this cycle until the plan is complete:",
    "1. Explore: use read-only tools to inspect relevant code, existing functions, utilities, and patterns to reuse.",
    "2. Update the plan file: after each discovery, immediately capture what you learned in the current plan file. Do not wait until the end.",
    "3. Ask the user: when you hit an ambiguity or decision you cannot resolve from code alone, use AskUserQuestion. Then return to exploration.",
    "",
    "### First Turn",
    "Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton plan to the current plan file and ask the user your first round of questions if clarification is needed. Do not explore exhaustively before engaging the user.",
    "",
    "### Asking Good Questions",
    "- Never ask what you could find out by reading the code.",
    "- Batch related questions together using AskUserQuestion.",
    "- Focus on things only the user can answer: requirements, preferences, tradeoffs, and edge case priorities.",
    "- Scale depth to the task: vague feature requests need more rounds; focused bug fixes may need one or none.",
    "",
    "### Plan File Structure",
    "Use markdown headers that fit the request. The plan should include:",
    "- Context: why this change is being made, the problem it addresses, and the intended outcome.",
    "- Recommended approach only, not a list of all alternatives.",
    "- Critical file paths to modify.",
    "- Existing functions, utilities, and patterns to reuse, with file paths.",
    "- Risks, edge cases, and verification steps for testing end-to-end.",
    "",
    "### When to Converge",
    "The plan is ready when ambiguities are addressed and it covers what to change, which files to modify, what existing code to reuse, and how to verify the change.",
    "When the plan is ready, call ExitPlanMode with no plan text to request approval instead of executing it.",
    "",
    "### Ending Your Turn",
    "Your turn should only end by either:",
    "- Using AskUserQuestion to gather more information.",
    "- Calling ExitPlanMode after the current plan file contains the complete plan and is ready for approval.",
    "",
    "Important: Use ExitPlanMode to request plan approval. Do NOT ask about plan approval via text or AskUserQuestion. Phrases like \"should I proceed\", \"does this plan look good\", or \"any changes before we start\" must use ExitPlanMode."
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
      "4. Continue the plan process, edit the current plan file with the revised complete plan, then call ExitPlanMode with no plan text before requesting approval.",
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
