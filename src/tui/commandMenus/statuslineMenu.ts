import type { InteractionChoice } from "../components/InteractionArea.js";
import { availableStatusLineElements } from "../components/StatusLine.js";
import type { StatusLineElement } from "../components/StatusLine.js";

const descriptions: Record<StatusLineElement, string> = {
  "run-state": "Compact runtime state (Starting, Ready, Working, Waiting, Thinking)",
  permission: "Current permission mode",
  "current-dir": "Current working directory",
  "git-branch": "Current Git branch (omitted when unavailable)",
  workflow: "Selected workflow",
  "run-id": "Current run ID",
  "tokens-io": "Current session input and output tokens",
  "tokens-cache": "Current session cached input tokens and hit rate",
  requests: "Current session model responses",
  selection: "Copied text selection and character count"
};

export function buildStatuslineChoice(input: {
  selectedElements: StatusLineElement[];
  onChange: (elements: StatusLineElement[]) => void;
  onClose: () => void;
}): InteractionChoice {
  const orderedElements = [
    ...input.selectedElements,
    ...availableStatusLineElements.filter((element) => !input.selectedElements.includes(element))
  ];
  const labelWidth = Math.max(...orderedElements.map((element) => element.length));

  return {
    title: "Statusline",
    detail: "Space toggles items without moving rows. Left/right to reorder enabled items. Changes apply and save immediately.",
    options: orderedElements.map((element) => ({
      label: element.padEnd(labelWidth),
      value: element,
      description: descriptions[element]
    })),
    selectedValue: orderedElements[0] ?? "",
    selectedValues: input.selectedElements,
    visibleOptionCount: availableStatusLineElements.length,
    multiSelect: true,
    enableOrdering: true,
    submitButtonText: "Close",
    onCancel: input.onClose,
    onSubmit: () => undefined,
    onChangeValues: (values) => input.onChange(values as StatusLineElement[]),
    onSubmitValues: input.onClose
  };
}
