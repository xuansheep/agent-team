import React, { useState } from "react";
import type { OptionWithDescription } from "./select.js";
import { Select } from "./select.js";

const doneValue = Symbol("select-multi-done");

export function SelectMulti<T>({
  options,
  defaultValue = [],
  onSubmit,
  onChange,
  onCancel,
  hideIndexes,
  visibleOptionCount
}: {
  options: OptionWithDescription<T>[];
  defaultValue?: T[];
  onSubmit: (values: T[]) => void;
  onChange?: (values: T[]) => void;
  onCancel?: () => void;
  hideIndexes?: boolean;
  visibleOptionCount?: number;
}) {
  const [selected, setSelected] = useState<T[]>(defaultValue);
  const toggle = (value: T) => {
    const next = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    setSelected(next);
    onChange?.(next);
  };
  const selectOptions: OptionWithDescription<T | typeof doneValue>[] = [
    ...options.map((option) => ({ ...option, label: `${selected.includes(option.value) ? "[x]" : "[ ]"} ${String(option.label)}` })),
    { label: "Done", value: doneValue }
  ];
  return (
    <Select
      options={selectOptions}
      onChange={(value) => {
        if (value === doneValue) onSubmit(selected);
        else toggle(value);
      }}
      onCancel={onCancel}
      hideIndexes={hideIndexes}
      visibleOptionCount={visibleOptionCount}
    />
  );
}
