import React from "react";
import { Box, Text, useInput } from "../ink.js";

export function WorkflowPicker({ workflows, selected, onSelect }: { workflows: string[]; selected?: string; onSelect: (workflow: string) => void }) {
  useInput((input) => {
    const index = Number(input) - 1;
    if (Number.isInteger(index) && workflows[index]) onSelect(workflows[index]);
  });

  return (
    <Box flexDirection="column">
      <Text>Select workflow</Text>
      {workflows.map((workflow, index) => (
        <Text key={workflow}>
          {index + 1}. {workflow}
          {workflow === selected ? " *" : ""}
        </Text>
      ))}
    </Box>
  );
}
