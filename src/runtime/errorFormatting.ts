export type FormattedRunError = {
  message: string;
  detail?: string;
};

export function formatRunError(error: unknown): FormattedRunError {
  const message = error instanceof Error ? error.message : String(error);
  const detail = [explicitErrorDetail(error), causeErrorDetail(error)].filter(Boolean).join("\n");
  return { message, ...(detail ? { detail } : {}) };
}

export function formatRunErrorText(error: unknown): string {
  const formatted = formatRunError(error);
  return formatted.detail ? `${formatted.message}\n\n${formatted.detail}` : formatted.message;
}

function explicitErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim() ? detail : undefined;
}

function causeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("cause" in error)) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause) return undefined;
  return errorDetailLines("cause", cause).join("\n");
}

function errorDetailLines(prefix: string, value: unknown): string[] {
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return [
      `${prefix}.name: ${value.name}`,
      `${prefix}.message: ${value.message}`,
      ...(typeof code === "string" || typeof code === "number" ? [`${prefix}.code: ${String(code)}`] : [])
    ];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["name", "message", "code"]
      .filter((key) => typeof record[key] === "string" || typeof record[key] === "number")
      .map((key) => `${prefix}.${key}: ${String(record[key])}`);
  }
  return [`${prefix}.message: ${String(value)}`];
}
