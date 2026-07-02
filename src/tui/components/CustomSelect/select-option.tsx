import { type ReactNode } from "react";
import { ListItem } from "./ListItem.js";

export function SelectOption({
  isFocused,
  isSelected,
  children,
  description,
  shouldShowDownArrow,
  shouldShowUpArrow,
  declareCursor
}: {
  isFocused: boolean;
  isSelected: boolean;
  children: ReactNode;
  description?: string;
  shouldShowDownArrow?: boolean;
  shouldShowUpArrow?: boolean;
  declareCursor?: boolean;
}) {
  return (
    <ListItem
      isFocused={isFocused}
      isSelected={isSelected}
      description={description}
      showScrollDown={shouldShowDownArrow}
      showScrollUp={shouldShowUpArrow}
      styled={false}
      declareCursor={declareCursor}
    >
      {children}
    </ListItem>
  );
}
