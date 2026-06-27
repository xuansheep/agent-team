import { z } from "zod";
export const nodeResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["success", "failure", "needs_user_input"] },
    summary: { type: "string" },
    document: { type: "string" },
    deliverables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifact_id: { type: "string" },
          description: { type: "string" }
        },
        required: ["artifact_id", "description"]
      }
    },
    feedback: {
      type: "object",
      additionalProperties: false,
      properties: {
        defects: { type: "array", items: { type: "string" } },
        change_requests: { type: "array", items: { type: "string" } }
      },
      required: ["defects", "change_requests"]
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          required: { type: "boolean" },
          placeholder: { type: "string" },
          allow_freeform: { type: "boolean" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                value: { type: "string" },
                description: { type: "string" },
                disabled: { type: "boolean" }
              },
              required: ["label", "value"]
            }
          }
        },
        required: ["id", "text", "required"]
      }
    },
    handoff: {
      type: "object",
      additionalProperties: false,
      properties: {
        instruction: { type: "string" },
        must_follow: { type: "array", items: { type: "string" } },
        known_risks: { type: "array", items: { type: "string" } },
        open_questions: { type: "array", items: { type: "string" } }
      },
      required: ["instruction", "must_follow", "known_risks", "open_questions"]
    }
  },
  required: ["status", "summary", "document", "deliverables", "feedback", "questions", "handoff"]
} as const;
export const nodeResultOutputInstructions = [
  "# Preamble messages",
  "Before making tool calls, send a brief preamble to the user explaining what you are about to do.",
  "Before calling tools, send a brief user-visible preamble explaining the immediate next action.",
  "Logically group related actions: if you are about to run several related commands, describe them together in one preamble rather than sending a separate note for each.",
  "Keep preambles concise: usually one sentence, focused on immediate tangible next steps.",
  "Build on prior context: if this is not your first tool call, use the preamble to connect the dots with what has been done so far and explain the next action.",
  "Write preambles in the same language as the user unless a higher-priority instruction requires otherwise.",
  "Write preambles as natural-language assistant commentary, not JSON, status labels, or placeholders.",
  "Examples of good preambles:",
  "- I've explored the repo; now checking the API route definitions.",
  "- Next, I'll patch the config and update the related tests.",
  "- Finished checking the event flow; now verifying how failures render.",
  "- 我先检查项目结构，再确认关键配置和入口。",
  "- 已看完事件流，接下来验证 TUI 日志渲染。",
  "On every non-SubmitNodeResult tool-call turn, the assistant content field must contain the preamble; do not leave it empty unless only SubmitNodeResult is being called.",
  "When SubmitNodeResult is available, use it for the final NodeResult instead of writing NodeResult JSON as assistant text.",
  "Never start a tool-use turn with raw NodeResult JSON; assistant text before tools must be natural-language preamble only.",
  "Never draft or stream NodeResult JSON before tool calls; if tools are needed, the assistant content must be preamble text only.",
  "Do not begin writing NodeResult keys before tool calls; write only the natural-language preamble, then call tools.",
  "Do not put NodeResult JSON in assistant content; put final structured data only in SubmitNodeResult input, or in the final JSON response when no tools are available.",
  "The final NodeResult must be only JSON that matches the NodeResult schema, or a SubmitNodeResult tool call when tools are available.",
  "Do not include Markdown fences, explanations, or natural-language text around the final NodeResult JSON object.",
  "Use status success for completed work, failure for rejected work, and needs_user_input only when user input is required and questions contains at least one concrete question.",
  "When a question has clear mutually-exclusive answers, include them in questions[].options with label and value. Set allow_freeform to false only when the user must choose one of those options.",
  "Return exactly one final NodeResult JSON object. Do not return multiple JSON objects or revisions in one response.",
  "If repository inspection is needed, call tools instead of asking the user for permission to inspect.",
  "When the node is a plan or complete node, put the full user-facing Markdown document in document.",
  "For plan nodes, document is the review document itself; do not put only a short summary in document and move the plan to ArtifactWrite.",
  "For task nodes that do not need a user-facing document, set document to an empty string."
].join("\n");
const deliverableSchema = z.object({
  artifact_id: z.string(),
  description: z.string().default("")
}).strict();
const feedbackSchema = z.object({
  defects: z.array(z.string()).default([]),
  change_requests: z.array(z.string()).default([])
}).strict();
const questionSchema = z.object({
  id: z.string(),
  text: z.string(),
  required: z.boolean().default(true),
  placeholder: z.string().optional(),
  allow_freeform: z.boolean().optional(),
  options: z.array(z.object({
    label: z.string(),
    value: z.string(),
    description: z.string().optional(),
    disabled: z.boolean().optional()
  }).strict()).optional()
}).strict();
const handoffSchema = z.object({
  instruction: z.string().default(""),
  must_follow: z.array(z.string()).default([]),
  known_risks: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([])
}).strict();
export const nodeResultSchema = z.object({
  status: z.enum(["success", "failure", "needs_user_input"]),
  summary: z.string().default(""),
  document: z.string().default(""),
  deliverables: z.array(deliverableSchema).default([]),
  feedback: feedbackSchema.default({}),
  questions: z.array(questionSchema).default([]),
  handoff: handoffSchema.default({})
}).strict().superRefine((result, ctx) => {
  if (result.status !== "needs_user_input") return;
  if (result.questions.some((question) => question.text.trim())) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["questions"],
    message: "needs_user_input results must include at least one concrete question"
  });
});
export type NodeResult = z.infer<typeof nodeResultSchema>;
export function visibleAssistantTextBeforeNodeResult(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed) return "";
  if (looksLikeStructuredPayloadStart(trimmed)) return "";
  const jsonStart = nodeResultJsonStart(text);
  if (jsonStart === -1) return text;
  return text.slice(0, jsonStart).trimEnd();
}

function looksLikeStructuredPayloadStart(text: string): boolean {
  if (text.startsWith("{") || text.startsWith("[")) return true;
  return /^```(?:json)?\s*[{[]/i.test(text);
}
function nodeResultJsonStart(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    if (isNodeResultObjectStart(text.slice(index))) return index;
  }
  return -1;
}
const NODE_RESULT_KEYS = ["status", "summary", "document", "deliverables", "feedback", "handoff", "questions"];
function isNodeResultObjectStart(text: string): boolean {
  const afterBrace = text.slice(1).trimStart();
  if (!afterBrace || afterBrace === "\"") return true;
  if (!afterBrace.startsWith("\"")) return false;
  const key = /^[A-Za-z_]+/.exec(afterBrace.slice(1))?.[0].toLowerCase() ?? "";
  if (!key) return true;
  const afterKey = afterBrace.slice(key.length + 1);
  return NODE_RESULT_KEYS.some((candidate) => candidate.startsWith(key) || (candidate === key && (afterKey === "" || /^[\s":]/.test(afterKey))));
}
export function parseNodeResult(text: string): NodeResult {
  const candidates = uniqueCandidates([text.trim(), ...extractJsonCandidates(text)]);
  let parseError: unknown;
  let schemaError: unknown;
  const parsedCandidates: unknown[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      parsedCandidates.push(JSON.parse(candidate));
    } catch (error) {
      parseError = error;
    }
  }
  const nodeResultLikeCount = parsedCandidates.filter(looksLikeNodeResult).length;
  if (nodeResultLikeCount > 1) throw new Error("Response contained multiple NodeResult objects; return exactly one final NodeResult JSON object.");
  for (const parsed of parsedCandidates) {
    try {
      return nodeResultSchema.parse(parsed);
    } catch (error) {
      schemaError = error;
    }
  }
  if (schemaError) throw schemaError;
  const detail = parseError instanceof Error ? parseError.message : String(parseError ?? "no JSON object found");
  throw new Error(`NodeResult was not valid JSON: ${detail}. Response excerpt: ${excerpt(text)}`);
}
function uniqueCandidates(candidates: string[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (;;) {
    const match = fenced.exec(text);
    if (!match) break;
    candidates.push(match[1] ?? "");
  }
  candidates.push(...extractJsonObjects(text));
  return candidates;
}
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let searchIndex = 0;
  for (;;) {
    const start = text.indexOf("{", searchIndex);
    if (start < 0) break;
    const extracted = extractJsonObjectAt(text, start);
    if (!extracted) {
      searchIndex = start + 1;
      continue;
    }
    objects.push(extracted.object);
    searchIndex = extracted.end;
  }
  return objects;
}
function extractJsonObjectAt(text: string, start: number): { object: string; end: number } | undefined {
  if (text[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { object: text.slice(start, index + 1), end: index + 1 };
    }
  }
  return undefined;
}
function looksLikeNodeResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return status === "success" || status === "failure" || status === "needs_user_input";
}
function excerpt(text: string): string {
  return JSON.stringify(text.slice(0, 240));
}
