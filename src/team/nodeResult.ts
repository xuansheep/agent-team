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
  "Do not include Markdown fences, explanations, or natural-language text outside the JSON object.",
  "Use status success for completed work, failure for rejected work, and needs_user_input only when user input is required.",
  "When the node is a plan or complete node, put the full user-facing Markdown document in the document field.",
  "For task nodes that do not need a user-facing document, set document to an empty string."
].join("\n");

export const nodeResultSchema = z.object({
  status: z.enum(["success", "failure", "needs_user_input"]),
  summary: z.string().default(""),
  document: z.string().default(""),
  deliverables: z.array(z.object({ artifact_id: z.string(), description: z.string().default("") })).default([]),
  feedback: z.object({
    defects: z.array(z.string()).default([]),
    change_requests: z.array(z.string()).default([])
  }).default({}),
  questions: z.array(z.object({
    id: z.string(),
    text: z.string(),
    required: z.boolean().default(true)
  })).default([]),
  handoff: z.object({
    instruction: z.string().default(""),
    must_follow: z.array(z.string()).default([]),
    known_risks: z.array(z.string()).default([]),
    open_questions: z.array(z.string()).default([])
  }).default({})
});

export type NodeResult = z.infer<typeof nodeResultSchema>;

export function parseNodeResult(text: string): NodeResult {
  return nodeResultSchema.parse(JSON.parse(text));
}
