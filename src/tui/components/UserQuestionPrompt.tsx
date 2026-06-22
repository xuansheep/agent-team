import React from "react";
import { Box, Text } from "ink";

export function UserQuestionPrompt({ questions }: { questions: unknown[] }) {
  if (questions.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color="yellow">User input required</Text>
      <Text>{JSON.stringify(questions).slice(0, 300)}</Text>
    </Box>
  );
}
