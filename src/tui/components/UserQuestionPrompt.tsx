import React from "react";
import { Box, Text } from "../ink.js";
import { readableValue } from "../toolDisplay.js";

export function UserQuestionPrompt({ questions }: { questions: unknown[] }) {
  if (questions.length === 0) return null;
  return (
    <Box flexDirection="column">
      {questions.map((question, index) => (
        <Text key={index}>{questionText(question)}</Text>
      ))}
    </Box>
  );
}

function questionText(question: unknown): string {
  if (question && typeof question === "object") {
    const value = question as { text?: unknown; question?: unknown };
    if (typeof value.text === "string" && value.text.trim()) return value.text;
    if (typeof value.question === "string" && value.question.trim()) return value.question;
  }
  return readableValue(question) || "等待用户补充信息";
}
