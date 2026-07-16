export type CommandInterpretation = {
  isError: boolean;
  message?: string;
};

type CommandSemantic = (exitCode: number, stdout: string, stderr: string) => CommandInterpretation;

const defaultSemantic: CommandSemantic = (exitCode) => ({
  isError: exitCode !== 0,
  message: exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined
});

const grepSemantic: CommandSemantic = (exitCode) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? "No matches found" : undefined
});

const bashSemantics = new Map<string, CommandSemantic>([
  ["grep", grepSemantic],
  ["rg", grepSemantic],
  ["find", (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? "Some directories were inaccessible" : undefined
  })],
  ["diff", (exitCode) => ({
    isError: exitCode >= 2,
    message: exitCode === 1 ? "Files differ" : undefined
  })],
  ["test", conditionSemantic],
  ["[", conditionSemantic]
]);

const powerShellSemantics = new Map<string, CommandSemantic>([
  ["grep", grepSemantic],
  ["rg", grepSemantic],
  ["findstr", grepSemantic],
  ["robocopy", (exitCode) => ({
    isError: exitCode >= 8,
    message: exitCode === 0
      ? "No files copied (already in sync)"
      : exitCode < 8
        ? (exitCode & 1) === 1 ? "Files copied successfully" : "Robocopy completed (no errors)"
        : undefined
  })]
]);

export function interpretBashCommand(command: string, exitCode: number, stdout: string, stderr: string): CommandInterpretation {
  return (bashSemantics.get(lastBashCommand(command)) ?? defaultSemantic)(exitCode, stdout, stderr);
}

export function interpretPowerShellCommand(command: string, exitCode: number, stdout: string, stderr: string): CommandInterpretation {
  return (powerShellSemantics.get(lastPowerShellCommand(command)) ?? defaultSemantic)(exitCode, stdout, stderr);
}

function conditionSemantic(exitCode: number): CommandInterpretation {
  return {
    isError: exitCode >= 2,
    message: exitCode === 1 ? "Condition is false" : undefined
  };
}

function lastBashCommand(command: string): string {
  const segments = command.split(/(?:&&|\|\||[;|])/).filter((value) => value.trim());
  return baseCommand(segments.at(-1) ?? command, false);
}

function lastPowerShellCommand(command: string): string {
  const segments = command.split(/[;|]/).filter((value) => value.trim());
  return baseCommand(segments.at(-1) ?? command, true);
}

function baseCommand(segment: string, windows: boolean): string {
  const stripped = segment.trim().replace(/^[&.]\s+/, "");
  const token = (stripped.split(/\s+/)[0] ?? "").replace(/^["']|["']$/g, "");
  const name = token.split(/[\\/]/).at(-1) ?? token;
  return windows ? name.toLowerCase().replace(/\.exe$/i, "") : name;
}
