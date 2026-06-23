import { TuiInputEvent, TuiInputKey } from "./types.js";

const pasteStart = "\u001b[200~";
const pasteEnd = "\u001b[201~";
const sgrMouse = /^(?:\u001b)?\[<(\d+);(\d+);(\d+)([mM])/;
const x10Mouse = /^\u001b\[M([\s\S]{3})/;

export type TerminalInputParser = {
  feed(input: string): TuiInputEvent[];
  flush(): TuiInputEvent[];
};

export function createTerminalInputParser(): TerminalInputParser {
  let pending = "";
  let inPaste = false;
  let pasteBuffer = "";

  const parse = (chunk: string, flush: boolean): TuiInputEvent[] => {
    let data = pending + chunk;
    pending = "";
    const events: TuiInputEvent[] = [];
    let index = 0;

    const emitText = (text: string) => {
      if (text) events.push({ type: "key", input: text, key: {} });
    };

    while (index < data.length) {
      if (inPaste) {
        const end = data.indexOf(pasteEnd, index);
        if (end === -1) {
          pasteBuffer += data.slice(index);
          index = data.length;
          break;
        }
        pasteBuffer += data.slice(index, end);
        events.push({ type: "paste", text: pasteBuffer });
        pasteBuffer = "";
        inPaste = false;
        index = end + pasteEnd.length;
        continue;
      }

      if (data.startsWith(pasteStart, index)) {
        inPaste = true;
        pasteBuffer = "";
        index += pasteStart.length;
        continue;
      }

      const rest = data.slice(index);
      const mouse = parseMouse(rest);
      if (mouse) {
        events.push(mouse.event);
        index += mouse.length;
        continue;
      }

      const key = parseKnownKey(rest);
      if (key) {
        events.push(key.event);
        index += key.length;
        continue;
      }

      const char = data[index] ?? "";
      if (char === "\u001b") {
        if (!flush && isPotentialEscapePrefix(rest)) {
          pending = rest;
          index = data.length;
          break;
        }
        events.push({ type: "key", input: "", key: { escape: true } });
        index += 1;
        continue;
      }

      const nextEscape = data.indexOf("\u001b", index + 1);
      const nextOrphanMouse = findNextOrphanMouse(data, index + 1);
      const nextSpecial = [nextEscape, nextOrphanMouse].filter((value) => value !== -1).sort((a, b) => a - b)[0] ?? -1;
      const end = nextSpecial === -1 ? data.length : nextSpecial;
      emitText(data.slice(index, end));
      index = end;
    }

    if (flush && pending) {
      events.push({ type: "key", input: "", key: { escape: true } });
      pending = "";
    }

    return events;
  };

  return {
    feed(input: string) {
      return parse(input, false);
    },
    flush() {
      return parse("", true);
    }
  };
}

function parseMouse(input: string): { event: TuiInputEvent; length: number } | undefined {
  const sgr = sgrMouse.exec(input);
  if (sgr) {
    const button = Number(sgr[1]);
    const x = Math.max(0, Number(sgr[2]) - 1);
    const y = Math.max(0, Number(sgr[3]) - 1);
    const length = sgr[0].length;
    if ((button & 0x43) === 0x40) return { event: { type: "key", input: "", key: { wheelUp: true } }, length };
    if ((button & 0x43) === 0x41) return { event: { type: "key", input: "", key: { wheelDown: true } }, length };
    return { event: { type: "mouse", action: sgr[4] === "M" ? "press" : "release", button, x, y }, length };
  }

  const x10 = x10Mouse.exec(input);
  if (!x10) return undefined;
  const payload = x10[1] ?? "";
  const button = payload.charCodeAt(0) - 32;
  const x = Math.max(0, payload.charCodeAt(1) - 33);
  const y = Math.max(0, payload.charCodeAt(2) - 33);
  if ((button & 0x43) === 0x40) return { event: { type: "key", input: "", key: { wheelUp: true } }, length: 6 };
  if ((button & 0x43) === 0x41) return { event: { type: "key", input: "", key: { wheelDown: true } }, length: 6 };
  return { event: { type: "mouse", action: "press", button, x, y }, length: 6 };
}

function parseKnownKey(input: string): { event: TuiInputEvent; length: number } | undefined {
  const sequences: Array<[string, TuiInputKey]> = [
    ["\u001b[A", { upArrow: true }],
    ["\u001b[B", { downArrow: true }],
    ["\u001b[C", { rightArrow: true }],
    ["\u001b[D", { leftArrow: true }],
    ["\u001b[H", { home: true }],
    ["\u001bOH", { home: true }],
    ["\u001b[1~", { home: true }],
    ["\u001b[7~", { home: true }],
    ["\u001b[F", { end: true }],
    ["\u001bOF", { end: true }],
    ["\u001b[4~", { end: true }],
    ["\u001b[8~", { end: true }],
    ["\u001b[3~", { delete: true }],
    ["\u001b[5~", { pageUp: true }],
    ["\u001b[6~", { pageDown: true }]
  ];
  for (const [sequence, key] of sequences) {
    if (input.startsWith(sequence)) return { event: { type: "key", input: "", key }, length: sequence.length };
  }

  const first = input[0];
  if (first === "\r" || first === "\n") return { event: { type: "key", input: "", key: { return: true } }, length: 1 };
  if (first === "\t") return { event: { type: "key", input: "", key: { tab: true } }, length: 1 };
  if (first === "\u007f" || first === "\b") return { event: { type: "key", input: "", key: { backspace: true } }, length: 1 };
  if (first && first >= "\u0001" && first <= "\u001a") {
    return { event: { type: "key", input: String.fromCharCode(first.charCodeAt(0) + 96), key: { ctrl: true } }, length: 1 };
  }
  return undefined;
}

function isPotentialEscapePrefix(input: string): boolean {
  return /^\u001b(?:\[|\[<|\[\d*|\[[?]?\d*(?:;\d*){0,2})?$/.test(input) || input === "\u001b";
}

function findNextOrphanMouse(input: string, from: number): number {
  const match = /\[<\d+;\d+;\d+[mM]/.exec(input.slice(from));
  return match?.index === undefined ? -1 : from + match.index;
}
