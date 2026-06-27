const destructiveGitPatterns = [
  /\bgit\s+reset\s+(--hard|--merge|--keep)\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\b[^\n]*(?:-f|--force)\b/i,
  /\bgit\s+checkout\b[^\n]*\s--\s+\S/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+rebase\b/i
];

export function isDestructiveGitCommand(command: string): boolean {
  return destructiveGitPatterns.some((pattern) => pattern.test(command));
}
