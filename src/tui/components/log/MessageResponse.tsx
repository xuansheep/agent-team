import React, { useContext } from "react";
import { Box, Text } from "../../ink.js";

type Props = {
  children: React.ReactNode;
};

const MessageResponseContext = React.createContext(false);

export function MessageResponse({ children }: Props): React.ReactNode {
  const nested = useContext(MessageResponseContext);
  if (nested) return children;

  return (
    <MessageResponseContext.Provider value={true}>
      <Box flexDirection="row" overflowY="hidden">
        <Box flexShrink={0}>
          <Text dimColor>{"  "}⎿  </Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          {children}
        </Box>
      </Box>
    </MessageResponseContext.Provider>
  );
}
