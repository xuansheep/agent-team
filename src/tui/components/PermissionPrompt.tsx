import React from "react";
import { Box, Text, useInput } from "ink";
import { TuiPermissionRequestState } from "../state.js";

export function PermissionPrompt({
  request,
  onResolve
}: {
  request?: TuiPermissionRequestState;
  onResolve: (requestId: string, decision: "allow_once" | "deny_once") => void;
}) {
  useInput((input) => {
    if (!request) return;
    if (input.toLowerCase() === "y") onResolve(request.requestId, "allow_once");
    if (input.toLowerCase() === "n") onResolve(request.requestId, "deny_once");
  });

  if (!request) return null;
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        Permission required: {request.tool} {request.specifier}
      </Text>
      <Text dimColor>y allow once | n deny once</Text>
    </Box>
  );
}
