import { z } from "zod";
import {
  normalizeUserQuestions,
  userQuestionsJsonSchema,
  userQuestionsSchema
} from "../userQuestionProtocol.js";
import { Tool } from "../types.js";

const inputSchema = z.strictObject({
  questions: userQuestionsSchema,
  answers: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.object({
    preview: z.string().optional(),
    notes: z.string().optional()
  })).optional(),
  metadata: z.object({
    source: z.string().optional()
  }).optional()
});

export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- Ask 1-4 questions, each with 2-4 options. Do not include an "Other" option; the UI adds it automatically.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ExitPlanMode. If you need plan approval, use ExitPlanMode instead.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`;

export const askUserQuestionTool: Tool = {
  name: "AskUserQuestion",
  description: "Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.",
  prompt: ASK_USER_QUESTION_TOOL_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      questions: userQuestionsJsonSchema(),
      answers: {
        type: "object",
        additionalProperties: { type: "string" }
      },
      annotations: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            preview: { type: "string" },
            notes: { type: "string" }
          }
        }
      },
      metadata: {
        type: "object",
        properties: {
          source: { type: "string" }
        }
      }
    },
    required: ["questions"],
    additionalProperties: false
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  requiresUserInteraction: () => true,
  mapToolResultToModelResult: askUserQuestionModelResult,
  async execute(input) {
    const parsed = inputSchema.parse(input);
    return {
      output: "Waiting for user input.",
      data: { type: "user_input_requested", questions: normalizeUserQuestions(parsed.questions) }
    };
  }
};

export function askUserQuestionModelResult(result: unknown): string | unknown {
  const payload = toolResultPayload(result);
  const feedback = payload?.feedback;
  if (typeof feedback === "string" && feedback.trim()) return feedback;
  const answers = payload?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return result;

  const annotations = payload?.annotations && typeof payload.annotations === "object" && !Array.isArray(payload.annotations)
    ? payload.annotations as Record<string, unknown>
    : undefined;
  const answersText = Object.entries(answers as Record<string, unknown>)
    .map(([questionText, answer]) => {
      const annotation = annotations?.[questionText];
      const parts = [`"${questionText}"="${String(answer)}"`];
      if (annotation && typeof annotation === "object") {
        const preview = (annotation as { preview?: unknown }).preview;
        const notes = (annotation as { notes?: unknown }).notes;
        if (typeof preview === "string" && preview.trim()) parts.push(`selected preview:\n${preview}`);
        if (typeof notes === "string" && notes.trim()) parts.push(`user notes: ${notes}`);
      }
      return parts.join(" ");
    })
    .join(", ");
  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}

function toolResultPayload(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = result as { data?: unknown; answers?: unknown; annotations?: unknown };
  if (value.answers !== undefined) return value as Record<string, unknown>;
  return value.data && typeof value.data === "object" && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : undefined;
}
