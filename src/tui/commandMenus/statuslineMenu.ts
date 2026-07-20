import type { InteractionChoice } from "../components/InteractionArea.js";
import { availableStatusLineElements } from "../components/StatusLine.js";
import type { StatusLineElement } from "../components/StatusLine.js";

const labels: Record<StatusLineElement, string> = {
  mode: "mode",
  permission: "permission",
  workflow: "workflow",
  run: "run",
  tokens: "tokens I/O",
  cache: "cache tokens",
  requests: "requests",
  selection: "selection",
  loading: "loading"
};

const labelWidth = Math.max(...Object.values(labels).map((label) => label.length));

const descriptions: Record<StatusLineElement, string> = {
  mode: "Current interaction mode",
  permission: "Current permission mode",
  workflow: "Selected workflow",
  run: "Current run ID",
  tokens: "Current session input and output tokens",
  cache: "Current session cached input tokens and hit rate",
  requests: "Current session model responses",
  selection: "Active text selection",
  loading: "Current running state"
};

export function buildStatuslineChoice(input: {
  selectedElements: StatusLineElement[];
  onChange: (elements: StatusLineElement[]) => void;
  onClose: () => void;
}): InteractionChoice {
  return {
    title: "Statusline",
    detail: "Space to enable or disable items. Changes apply immediately.",
    options: availableStatusLineElements.map((element) => ({
      label: labels[element].padEnd(labelWidth),
      value: element,
      description: descriptions[element]
    })),
    selectedValue: availableStatusLineElements[0] ?? "",
    selectedValues: availableStatusLineElements.filter((element) => input.selectedElements.includes(element)),
    visibleOptionCount: availableStatusLineElements.length,
    multiSelect: true,
    submitButtonText: "Close",
    onCancel: input.onClose,
    onSubmit: () => undefined,
    onChangeValues: (values) => input.onChange(availableStatusLineElements.filter((element) => values.includes(element))),
    onSubmitValues: input.onClose
  };
}
