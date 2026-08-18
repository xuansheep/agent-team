import { z } from "zod";

export const userQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
  preview: z.string().optional()
});

export const userQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  multiSelect: z.boolean().default(false),
  options: z.array(userQuestionOptionSchema).min(2).max(4)
});

export const userQuestionsSchema = z.array(userQuestionSchema)
  .min(1)
  .max(4)
  .refine(uniqueQuestionsAndOptions, {
    message: "Question texts must be unique, option labels must be unique within each question"
  });

export type UserQuestionInput = z.infer<typeof userQuestionSchema>;
export type UserQuestion = UserQuestionInput & {
  id: string;
  text: string;
  required: true;
  allow_freeform: true;
  options: Array<UserQuestionInput["options"][number] & { value: string }>;
};

export function normalizeUserQuestions(questions: UserQuestionInput[]): UserQuestion[] {
  return questions.map((question, index) => {
    const text = question.question;
    return {
      ...question,
      id: question.header || `question_${index + 1}`,
      text,
      question: text,
      required: true,
      allow_freeform: true,
      options: question.options.map((option) => ({
        ...option,
        value: option.label
      }))
    };
  });
}

export function userQuestionsJsonSchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 4,
    items: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The complete question to ask the user. It should be clear, specific, and end with a question mark."
        },
        header: {
          type: "string",
          description: "Very short label displayed as a chip/tag."
        },
        multiSelect: {
          type: "boolean",
          default: false,
          description: "Set to true to allow the user to select multiple options instead of one."
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          description: "The available choices. Do not include an Other option; the UI adds it automatically.",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description: "The display text for this option."
              },
              description: {
                type: "string",
                description: "A short explanation of this option's impact or tradeoff."
              },
              preview: {
                type: "string",
                description: "Optional preview content rendered when this option is focused."
              }
            },
            required: ["label", "description"]
          }
        }
      },
      required: ["question", "header", "options"]
    }
  };
}

function uniqueQuestionsAndOptions(questions: UserQuestionInput[]): boolean {
  const questionTexts = questions.map((question) => question.question);
  if (questionTexts.length !== new Set(questionTexts).size) return false;
  return questions.every((question) => {
    const labels = question.options.map((option) => option.label);
    return labels.length === new Set(labels).size;
  });
}
