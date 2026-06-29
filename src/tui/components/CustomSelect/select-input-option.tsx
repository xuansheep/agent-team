import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "../../ink.js";
import type { OptionWithDescription, SelectImageAttachment } from "./select.js";
import { SelectOption } from "./select-option.js";

export function SelectInputOption<T>({
  option,
  isFocused,
  isSelected,
  shouldShowDownArrow,
  shouldShowUpArrow,
  maxIndexWidth,
  index,
  inputValue,
  prefix,
  onInputChange,
  onSubmit,
  onExit,
  onOpenEditor,
  inputTextDisabled = false,
  showLabel = false,
  imageAttachments = [],
  onImagePaste,
  onRemoveImage,
  resolveImagePaste,
  enableImageSelection = true
}: {
  option: Extract<OptionWithDescription<T>, { type: "input" }>;
  isFocused: boolean;
  isSelected: boolean;
  shouldShowDownArrow: boolean;
  shouldShowUpArrow: boolean;
  maxIndexWidth: number;
  index: number;
  inputValue: string;
  prefix?: React.ReactNode;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onExit?: () => void;
  onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void;
  inputTextDisabled?: boolean;
  showLabel?: boolean;
  imageAttachments?: SelectImageAttachment[];
  onImagePaste?: (image: Omit<SelectImageAttachment, "id">) => void;
  onRemoveImage?: (id: number) => void;
  resolveImagePaste?: (value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>;
  enableImageSelection?: boolean;
}) {
  const [cursor, setCursor] = useState(inputValue.length);
  const [imagesSelected, setImagesSelected] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const wasFocused = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !wasFocused.current) setCursor(inputValue.length);
    wasFocused.current = isFocused;
  }, [inputValue.length, isFocused]);
  useEffect(() => {
    if (!isFocused || imageAttachments.length === 0) {
      setImagesSelected(false);
      setSelectedImageIndex(0);
      return;
    }
    setSelectedImageIndex((value) => Math.min(value, imageAttachments.length - 1));
  }, [imageAttachments.length, isFocused]);

  useInput((input, key, event) => {
    if (!isFocused) return;
    if (imagesSelected) {
      if (key.escape || key.upArrow) {
        setImagesSelected(false);
        event.stopImmediatePropagation();
        return;
      }
      if (key.leftArrow) {
        setSelectedImageIndex((value) => (value - 1 + imageAttachments.length) % imageAttachments.length);
        event.stopImmediatePropagation();
        return;
      }
      if (key.rightArrow) {
        setSelectedImageIndex((value) => (value + 1) % imageAttachments.length);
        event.stopImmediatePropagation();
        return;
      }
      if ((key.backspace || key.delete) && onRemoveImage) {
        const selectedImage = imageAttachments[selectedImageIndex];
        if (selectedImage) onRemoveImage(selectedImage.id);
        if (imageAttachments.length <= 1) setImagesSelected(false);
        else setSelectedImageIndex((value) => Math.min(value, imageAttachments.length - 2));
        event.stopImmediatePropagation();
        return;
      }
      event.stopImmediatePropagation();
      return;
    }
    if (key.escape) {
      onExit?.();
      event.stopImmediatePropagation();
      return;
    }
    if (enableImageSelection && key.downArrow && imageAttachments.length) {
      setImagesSelected(true);
      setSelectedImageIndex(0);
      event.stopImmediatePropagation();
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      onSubmit(inputValue);
      event.stopImmediatePropagation();
      return;
    }
    if ((input === "\u0007" || (key.ctrl && input === "g")) && onOpenEditor) {
      onOpenEditor(inputValue, (value) => {
        onInputChange(value);
        option.onChange(value);
        setCursor(value.length);
      });
      event.stopImmediatePropagation();
      return;
    }
    if (inputTextDisabled && (event.keypress.isPasted || key.backspace || key.delete || (input && !key.ctrl && !input.startsWith("\u001b")))) return;
    if (event.keypress.isPasted) {
      void handlePaste(input, inputValue, cursor, resolveImagePaste, onImagePaste, onInputChange, setCursor);
      event.stopImmediatePropagation();
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor <= 0 && !inputValue && imageAttachments.length && onRemoveImage) {
        onRemoveImage(imageAttachments[imageAttachments.length - 1].id);
        event.stopImmediatePropagation();
        return;
      }
      if (cursor <= 0) return;
      onInputChange(`${inputValue.slice(0, cursor - 1)}${inputValue.slice(cursor)}`);
      setCursor((value) => Math.max(0, value - 1));
      event.stopImmediatePropagation();
      return;
    }
    if (key.leftArrow) {
      setCursor((value) => Math.max(0, value - 1));
      event.stopImmediatePropagation();
      return;
    }
    if (key.rightArrow) {
      setCursor((value) => Math.min(inputValue.length, value + 1));
      event.stopImmediatePropagation();
      return;
    }
    if (input && !key.ctrl && !input.startsWith("\u001b")) {
      onInputChange(`${inputValue.slice(0, cursor)}${input}${inputValue.slice(cursor)}`);
      setCursor((value) => value + input.length);
      event.stopImmediatePropagation();
    }
  }, { isActive: isFocused });

  const label = showLabel || option.showLabelWithValue ? `${option.label}${option.labelValueSeparator ?? ", "}` : "";
  const placeholder = inputValue ? "" : option.placeholder ?? String(option.label);
  const imageHint = imageAttachments.length
    ? imagesSelected
      ? ` image ${selectedImageIndex + 1}/${imageAttachments.length} selected (←/→ switch, backspace remove, esc cancel)`
      : ` ${imageAttachments.length} image${imageAttachments.length === 1 ? "" : "s"} attached`
    : "";
  return (
    <SelectOption isFocused={isFocused} isSelected={isSelected} shouldShowDownArrow={shouldShowDownArrow} shouldShowUpArrow={shouldShowUpArrow} declareCursor={false}>
      <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" flexShrink={0}>
          <Text dimColor>{`${index}.`.padEnd(maxIndexWidth + 2)}</Text>
          {prefix ? <Text>{prefix} </Text> : null}
          {label ? <Text>{label}</Text> : null}
          <Text color={inputValue ? undefined : "ansi256(244)"}>{inputValue || placeholder}</Text>
          {imageHint ? <Text dimColor>{imageHint}</Text> : null}
        </Box>
        {option.description ? (
          <Box paddingLeft={maxIndexWidth + 2}>
            <Text dimColor wrap="wrap">{option.description}</Text>
          </Box>
        ) : null}
      </Box>
    </SelectOption>
  );
}

async function handlePaste(
  input: string,
  inputValue: string,
  cursor: number,
  resolveImagePaste: ((value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>) | undefined,
  onImagePaste: ((image: Omit<SelectImageAttachment, "id">) => void) | undefined,
  onInputChange: (value: string) => void,
  setCursor: React.Dispatch<React.SetStateAction<number>>
) {
  const parsed = resolveImagePaste ? await resolveImagePaste(input) : parsePastedImages(input);
  for (const image of parsed.images) onImagePaste?.(image);
  if (parsed.text) {
    onInputChange(`${inputValue.slice(0, cursor)}${parsed.text}${inputValue.slice(cursor)}`);
    setCursor((value) => value + parsed.text.length);
  }
}

export function parsePastedImages(value: string): { text: string; images: Array<Omit<SelectImageAttachment, "id">> } {
  const images: Array<Omit<SelectImageAttachment, "id">> = [];
  const text = value.replace(/data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)/g, (_match, mediaType: SelectImageAttachment["media_type"], data: string) => {
    if (data.trim()) images.push({ type: "image", media_type: mediaType, data });
    return "";
  }).trim();
  return { text, images };
}
