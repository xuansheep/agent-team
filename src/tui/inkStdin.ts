export function ensureRefableStdin(stdin: unknown): void {
  if (!stdin || typeof stdin !== "object") return;
  const refable = stdin as { ref?: () => unknown; unref?: () => unknown };
  if (typeof refable.ref !== "function") refable.ref = () => stdin;
  if (typeof refable.unref !== "function") refable.unref = () => stdin;
}
