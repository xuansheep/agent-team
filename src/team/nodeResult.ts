import { z } from "zod";

export const nodeResultSchema = z.object({
  status: z.enum(["success", "failure", "needs_user_input"]),
  summary: z.string().default(""),
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
