import { readPlan } from "./planFiles.js";

export const PLAN_FILE_REQUIRED_MESSAGE = "Plan Mode cannot request approval yet because the current plan file is empty. Write the implementation plan to the current plan file first, then call ExitPlanMode again.";

export async function readRequiredPlan(planFilePath: string): Promise<string> {
  const document = (await readPlan(planFilePath))?.trim() ?? "";
  if (!document) {
    throw new Error(`No plan file found at ${planFilePath}. Please write your plan to this file before calling ExitPlanMode.`);
  }
  return document;
}

export function isSourceEditPermissionQuestion(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as { metadata?: unknown; questions?: unknown };
  if (metadataSource(value.metadata) === "plan_mode_block") return true;
  if (!Array.isArray(value.questions)) return false;
  return value.questions.some((question) => questionLooksLikeSourceEditPermission(question));
}

export function isPlanModeRepairToolResult(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return /Stay in Plan Mode, write the plan file|Invalid Plan Mode question/i.test(content);
}

export function isBlockedPlanModePlainText(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const text = content.toLowerCase();
  return /(plan mode|计划模式|退出|exit).*?(edit|modify|source|file|code|修改|编辑|文件|源码|代码|implement|coding)|(?:blocked|cannot|can't|不允许|不能|无法).*?(edit|modify|source|file|code|修改|编辑|文件|源码|代码)/i.test(text);
}

export function planModeNoToolReminder(planFilePath?: string): string {
  const path = planFilePath ? ` (${planFilePath})` : "";
  return `Plan Mode is still active. Do not end the turn with plain text and do not ask for permission to edit source files. Call Write/Edit/MultiEdit with the plan content or edits; the runtime will target the current plan file${path}. Ask a real clarification question with AskUserQuestion, or call ExitPlanMode only after the plan file is complete.`;
}

export function sourceEditPermissionQuestionMessage(planFilePath?: string): string {
  const path = planFilePath ? ` ${planFilePath}` : "";
  return `Invalid Plan Mode question: do not ask the user whether you may exit Plan Mode or edit source files. Treat the edit request as a planning request, call Write/Edit/MultiEdit with the implementation plan, let the runtime target the current plan file${path}, then call ExitPlanMode for approval.`;
}

function metadataSource(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const source = (metadata as { source?: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

function questionLooksLikeSourceEditPermission(question: unknown): boolean {
  if (!question || typeof question !== "object" || Array.isArray(question)) return false;
  const value = question as { question?: unknown; header?: unknown; options?: unknown };
  const text = [
    typeof value.header === "string" ? value.header : "",
    typeof value.question === "string" ? value.question : "",
    ...optionTexts(value.options)
  ].join("\n").toLowerCase();
  if (!text) return false;
  return /plan mode|退出|exit plan mode|start coding|start implementing|开始修改|直接修改|继续编辑|允许.*(edit|修改|编辑)|是否.*(edit|修改|编辑)|可以.*(edit|修改|编辑)/i.test(text) &&
    /(edit|modify|source|file|code|修改|编辑|文件|源码|代码|退出|exit|implement|coding)/i.test(text);
}

function optionTexts(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return [];
    const value = option as { label?: unknown; description?: unknown };
    return [
      typeof value.label === "string" ? value.label : "",
      typeof value.description === "string" ? value.description : ""
    ];
  });
}
