export type TuiMouseWheelEvent = {
  type: "wheel";
  direction: "up" | "down";
  x: number;
  y: number;
};

export type ScrollPane<T extends string = string> = {
  id: T;
  top: number;
  bottom: number;
  maxOffset: number;
};

const sgrMousePattern = /^\u001b\[<(\d+);(\d+);(\d+)[mM]$/;

export function parseSgrMouseEvent(input: string | Buffer): TuiMouseWheelEvent | undefined {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const match = sgrMousePattern.exec(text);
  if (!match) return undefined;
  const button = Number(match[1]);
  if (button !== 64 && button !== 65) return undefined;
  return {
    type: "wheel",
    direction: button === 64 ? "up" : "down",
    x: Math.max(0, Number(match[2]) - 1),
    y: Math.max(0, Number(match[3]) - 1)
  };
}

export function scrollPaneByMouse<T extends string>(
  offsets: Record<T, number>,
  panes: Array<ScrollPane<T>>,
  event: TuiMouseWheelEvent
): Record<T, number> {
  const pane = panes.find((item) => event.y >= item.top && event.y <= item.bottom);
  if (!pane) return offsets;
  const next = event.direction === "down" ? offsets[pane.id] + 1 : offsets[pane.id] - 1;
  return { ...offsets, [pane.id]: clamp(next, 0, pane.maxOffset) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
