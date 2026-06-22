export function slashCommandSuggestions(input: string, workflows: string[]): string[] {
  const trimmed = input.trim();
  if (trimmed === "/" || trimmed.startsWith("/h")) return ["/help"];
  if (trimmed.startsWith("/r")) return ["/run", "/resume", ...workflows.map((workflow) => `/run ${workflow}`)];
  if (trimmed.startsWith("/s")) return ["/status"];
  return [];
}
