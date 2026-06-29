import { PermissionSet } from "../config/schema.js";

export type PermissionDecision = {
  decision: "allow" | "ask" | "deny";
  rule?: string;
};

type ParsedRule = {
  tool: string;
  specifier?: string;
};

export function decidePermission(tool: string, specifier: string, permissions: PermissionSet): PermissionDecision {
  for (const rule of permissions.deny) {
    if (matchesRule(rule, tool, specifier)) return { decision: "deny", rule };
  }
  for (const rule of permissions.ask) {
    if (matchesRule(rule, tool, specifier)) return { decision: "ask", rule };
  }
  for (const rule of permissions.allow) {
    if (matchesRule(rule, tool, specifier)) return { decision: "allow", rule };
  }
  return { decision: "ask" };
}

export function mergePermissions(base: PermissionSet, node: PermissionSet): PermissionSet {
  return {
    deny: [...base.deny, ...node.deny],
    ask: [...base.ask, ...node.ask],
    allow: [...base.allow, ...node.allow]
  };
}

function matchesRule(rule: string, tool: string, specifier: string): boolean {
  const parsed = parseRule(rule);
  if (parsed.tool !== tool) return false;
  if (!parsed.specifier) return true;
  if (parsed.specifier.toLowerCase().startsWith("prompt:")) {
    return matchesPromptRule(tool, parsed.specifier.slice("prompt:".length), specifier);
  }
  return wildcardMatch(parsed.specifier, specifier);
}

function parseRule(rule: string): ParsedRule {
  const match = /^(?<tool>[A-Za-z][A-Za-z0-9_]*)(?:\((?<specifier>.*)\))?$/.exec(rule.trim());
  if (!match?.groups) throw new Error(`Invalid permission rule ${rule}`);
  return { tool: match.groups.tool, specifier: match.groups.specifier };
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesPromptRule(tool: string, prompt: string, specifier: string): boolean {
  if (tool !== "Bash") return false;
  const normalizedPrompt = prompt.toLowerCase();
  const command = specifier.trim().toLowerCase();
  if (!command || hasUnsafeShellSyntax(command)) return false;
  if (/\btests?\b/.test(normalizedPrompt)) return isTestCommand(command);
  if (/\binstall\b/.test(normalizedPrompt) && /\b(dependencies|packages|deps)\b/.test(normalizedPrompt)) {
    return isDependencyInstallCommand(command);
  }
  return false;
}

function hasUnsafeShellSyntax(command: string): boolean {
  return /[;&|<>`]/.test(command) || command.includes("$(") || command.includes("\n") || command.includes("\r");
}

function isTestCommand(command: string): boolean {
  return [
    /^npm\s+(test|t)(\s|$)/,
    /^pnpm\s+(test|t)(\s|$)/,
    /^yarn\s+(test|t)(\s|$)/,
    /^bun\s+test(\s|$)/,
    /^node\s+--test(\s|$)/,
    /^deno\s+test(\s|$)/,
    /^cargo\s+test(\s|$)/,
    /^go\s+test(\s|$)/,
    /^mvn(\s+\S+)*\s+test(\s|$)/,
    /^gradle\s+test(\s|$)/,
    /^\.\/gradlew\s+test(\s|$)/
  ].some((pattern) => pattern.test(command));
}

function isDependencyInstallCommand(command: string): boolean {
  return [
    /^npm\s+(install|i|ci)(\s|$)/,
    /^pnpm\s+install(\s|$)/,
    /^yarn\s+install(\s|$)/,
    /^bun\s+install(\s|$)/,
    /^pip\s+install(\s|$)/,
    /^pip3\s+install(\s|$)/,
    /^poetry\s+install(\s|$)/,
    /^bundle\s+install(\s|$)/,
    /^composer\s+install(\s|$)/
  ].some((pattern) => pattern.test(command));
}
