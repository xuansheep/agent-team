export function slashCommandSuggestions(input: string, _workflows: string[]): string[] {
  const trimmed = input.trim();
  if (trimmed === "/" || trimmed.startsWith("/h")) return ["/help"];
  if (trimmed.startsWith("/d")) return ["/diagnostics"];
  if (trimmed.startsWith("/r")) return ["/resume"];
  if (trimmed.startsWith("/p")) return ["/plan", "/permissions"];
  if (trimmed.startsWith("/s")) return ["/statusline"];
  if (trimmed.startsWith("/n")) return ["/new"];
  return [];
}
