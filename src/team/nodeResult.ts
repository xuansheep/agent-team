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
          required: { type: "boolean" }
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
  "Return only JSON that matches the NodeResult schema.",
  "You may also call SubmitNodeResult with the final NodeResult object when tools are available.",
  "Do not include Markdown fences, explanations, or natural-language text outside the JSON object.",
  "Use status success for completed work, failure for rejected work, and needs_user_input only when user input is required and questions contains at least one concrete question.",
  "Return exactly one NodeResult JSON object. Do not return multiple JSON objects or revisions in one response.",
  "If repository inspection is needed, call tools instead of asking the user for permission to inspect.",
  "When the node is a plan or complete node, put the full user-facing Markdown document in the document field.",
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
  required: z.boolean().default(true)
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
