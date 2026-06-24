export function slashCommandSuggestions(input: string, workflows: string[]): string[] {
  const trimmed = input.trim();
  if (trimmed === "/" || trimmed.startsWith("/h")) return ["/help"];
  if (trimmed.startsWith("/r")) return ["/resume"];
  if (trimmed.startsWith("/n")) return ["/new"];
  return [];
}
