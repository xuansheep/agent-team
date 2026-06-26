import type React from "react";
import type { OptionWithDescription } from "./select.js";

type OptionMapItem<T> = {
  label: React.ReactNode;
  value: T;
  description?: string;
  previous?: OptionMapItem<T>;
  next?: OptionMapItem<T>;
  index: number;
};

export class OptionMap<T> extends Map<T, OptionMapItem<T>> {
  readonly first?: OptionMapItem<T>;
  readonly last?: OptionMapItem<T>;

  constructor(options: OptionWithDescription<T>[]) {
    const items: Array<[T, OptionMapItem<T>]> = [];
    let first: OptionMapItem<T> | undefined;
    let last: OptionMapItem<T> | undefined;
    let previous: OptionMapItem<T> | undefined;

    options.forEach((option, index) => {
      const item: OptionMapItem<T> = {
        label: option.label,
        value: option.value,
        description: option.description,
        previous,
        index
      };
      if (previous) previous.next = item;
      first ??= item;
      last = item;
      previous = item;
      items.push([option.value, item]);
    });

    super(items);
    this.first = first;
    this.last = last;
  }
}
