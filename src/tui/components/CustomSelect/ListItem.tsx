import { type ReactNode } from "react";
import { Box, Text, useDeclaredCursor } from "../../ink.js";

export function ListItem({
  isFocused,
  isSelected = false,
  children,
  description,
  showScrollDown,
  showScrollUp,
  styled = true,
  disabled = false,
  declareCursor = true
}: {
  isFocused: boolean;
  isSelected?: boolean;
  children: ReactNode;
  description?: string;
  showScrollDown?: boolean;
  showScrollUp?: boolean;
  styled?: boolean;
  disabled?: boolean;
  declareCursor?: boolean;
}) {
  const cursorRef = useDeclaredCursor({ line: 0, column: 0, active: isFocused && !disabled && declareCursor });
  const color = disabled ? undefined : isFocused ? "cyan" : isSelected ? "green" : undefined;
  return (
    <Box ref={cursorRef} flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={isFocused && !disabled ? "cyan" : undefined} dimColor={!isFocused || disabled}>
          {indicator(isFocused, disabled, showScrollDown, showScrollUp)}
        </Text>
        {styled ? <Text color={color} dimColor={disabled}>{children}</Text> : children}
      </Box>
      {description ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">{description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function indicator(isFocused: boolean, disabled: boolean, showScrollDown?: boolean, showScrollUp?: boolean): string {
  if (disabled) return " ";
  if (isFocused) return ">";
  if (showScrollDown) return "v";
  if (showScrollUp) return "^";
  return " ";
}
