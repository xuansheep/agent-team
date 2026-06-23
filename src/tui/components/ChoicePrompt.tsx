import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, useStdin } from "ink";
import { ensureRefableStdin } from "../inkStdin.js";

export type ChoicePromptOption = {
  label: string;
  value: string;
  shortcut?: string;
};

export function ChoicePrompt({
  title,
  detail,
  options,
  defaultValue,
  selectedValue,
  interactive = true,
  onSelect,
  onSubmit
}: {
  title: string;
  detail?: string;
  options: ChoicePromptOption[];
  defaultValue: string;
  selectedValue?: string;
  interactive?: boolean;
  onSelect?: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const { stdin, setRawMode, internal_eventEmitter } = useStdin();
  ensureRefableStdin(stdin);
  const defaultIndex = Math.max(0, options.findIndex((option) => option.value === defaultValue));
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === (selectedValue ?? options[defaultIndex]?.value)));
  const [internalIndex, setInternalIndex] = useState(defaultIndex);
  const activeIndex = selectedValue === undefined ? internalIndex : selectedIndex;
  const activeIndexRef = useRef(activeIndex);
  const escapeBufferRef = useRef("");
  const lastInputRef = useRef<{ value: string; time: number }>();
  activeIndexRef.current = activeIndex;

  useEffect(() => {
    if (selectedValue !== undefined) return;
    setInternalIndex(defaultIndex);
  }, [defaultIndex, selectedValue]);

  const selectIndex = (index: number) => {
    if (!options.length) return;
    const normalized = (index + options.length) % options.length;
    if (selectedValue === undefined) setInternalIndex(normalized);
    onSelect?.(options[normalized].value);
  };

  useLayoutEffect(() => {
    if (!interactive || options.length === 0) return;
    const handleInput = (value: unknown) => {
      if (typeof value !== "string") return;
      if (isDuplicateInput(value, lastInputRef)) return;
      const input = normalizeInputSequence(value, escapeBufferRef);
      if (!input) return;
      if (input === "\u001b[A") {
        selectIndex(activeIndexRef.current - 1);
        return;
      }
      if (input === "\u001b[B") {
        selectIndex(activeIndexRef.current + 1);
        return;
      }
      if (input === "\r" || input === "\n") {
        onSubmit(options[activeIndexRef.current].value);
        return;
      }

      const shortcut = input.toLowerCase();
      const option = options.find((item) => item.shortcut?.toLowerCase() === shortcut);
      if (option) onSubmit(option.value);
    };
    setRawMode(true);
    internal_eventEmitter.on("input", handleInput);
    stdin.on?.("data", handleInput);
    return () => {
      internal_eventEmitter.off("input", handleInput);
      stdin.off?.("data", handleInput);
      setRawMode(false);
    };
  }, [interactive, internal_eventEmitter, onSubmit, options, setRawMode, stdin]);

  if (options.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color="yellow">{title}</Text>
      {detail ? <Text dimColor>{detail}</Text> : null}
      {options.map((option, index) => (
        <Text key={option.value} color={index === activeIndex ? "cyan" : undefined}>
          {index === activeIndex ? ">" : " "} {option.label}{option.shortcut ? ` (${option.shortcut})` : ""}
        </Text>
      ))}
      {interactive ? <Text dimColor>Use up/down and Enter</Text> : null}
    </Box>
  );
}

function normalizeInputSequence(value: string, bufferRef: React.MutableRefObject<string>): string {
  const next = bufferRef.current ? `${bufferRef.current}${value}` : value;
  if (next === "" || next === "[") {
    bufferRef.current = next;
    return "";
  }
  bufferRef.current = "";
  return next;
}

function isDuplicateInput(value: string, lastInputRef: React.MutableRefObject<{ value: string; time: number } | undefined>): boolean {
  const now = Date.now();
  const last = lastInputRef.current;
  lastInputRef.current = { value, time: now };
  return Boolean(last && last.value === value && now - last.time < 8);
}
