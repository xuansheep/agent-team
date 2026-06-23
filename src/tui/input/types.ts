export type TuiInputKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  wheelUp?: boolean;
  wheelDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
};

export type TuiKeyInputEvent = {
  type: "key";
  input: string;
  key: TuiInputKey;
};

export type TuiMouseInputEvent = {
  type: "mouse";
  action: "press" | "release";
  button: number;
  x: number;
  y: number;
};

export type TuiPasteInputEvent = {
  type: "paste";
  text: string;
};

export type TuiInputEvent = TuiKeyInputEvent | TuiMouseInputEvent | TuiPasteInputEvent;
