import React from "react";
import { Box, Text } from "../ink.js";
import { readableValue } from "../toolDisplay.js";

export function UserQuestionPrompt({ questions }: { questions: unknown[] }) {
  if (questions.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color="yellow">User input required</Text>
      {questions.map((question, index) => (
        <Text key={index}>{questionText(question)}</Text>
      ))}
    </Box>
  );
}

function questionText(question: unknown): string {
  return readableValue(question) || "等待用户补充信息";
}
