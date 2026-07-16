import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, delimiter, dirname, join, normalize } from "node:path";
import treeKill from "tree-kill";

export type ShellProcessResult = {
  stdout: string;
  stderr: string;
  code: number;
  interrupted: boolean;
  executable: string;
};

export class ShellStartError extends Error {
  constructor(message: string, readonly executable?: string) {
    super(message);
    this.name = "ShellStartError";
  }
}

export async function executeBash(command: string, options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ShellProcessResult> {
  const executable = await findBashExecutable();
  if (!executable) throw new ShellStartError("Bash executable was not found");
  return executeProcess(executable, ["-lc", command], options);
}

export async function executePowerShell(command: string, options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ShellProcessResult> {
  const executable = await findPowerShellExecutable();
  if (!executable) throw new ShellStartError("PowerShell executable was not found");
  const encoded = encodePowerShellCommand(command);
  return executeProcess(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], options);
}

export async function findBashExecutable(): Promise<string | undefined> {
  if (process.platform !== "win32") {
    const configured = process.env.AGENT_TEAM_BASH_PATH || process.env.CLAUDE_CODE_GIT_BASH_PATH;
    return configured && await isUsable(configured) ? configured : process.env.SHELL?.includes("bash") ? process.env.SHELL : "bash";
  }

  const candidates: string[] = [];
  addCandidate(candidates, process.env.AGENT_TEAM_BASH_PATH);
  addCandidate(candidates, process.env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const git of pathExecutables("git.exe")) {
    const root = dirname(dirname(git));
    addCandidate(candidates, join(root, "bin", "bash.exe"));
  }
  addCandidate(candidates, process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"));
  addCandidate(candidates, process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"]!, "Git", "bin", "bash.exe"));
  addCandidate(candidates, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  for (const bash of pathExecutables("bash.exe")) {
    if (!normalize(bash).toLowerCase().endsWith("\\windows\\system32\\bash.exe")) addCandidate(candidates, bash);
  }
  return firstUsable(candidates);
}

export async function findPowerShellExecutable(): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const name of process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"]) {
    for (const candidate of pathExecutables(name)) addCandidate(candidates, candidate);
  }
  if (process.platform === "win32") {
    addCandidate(candidates, process.env.ProgramFiles && join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
    addCandidate(candidates, process.env.SystemRoot && join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }
  return firstUsable(candidates);
}

function executeProcess(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal }
): Promise<ShellProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let interrupted = false;
    let terminationStarted = false;
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new ShellStartError(error instanceof Error ? error.message : String(error), executable));
      return;
    }

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => {
      if (terminationStarted || settled) return;
      interrupted = true;
      terminationStarted = true;
      if (child.pid) treeKill(child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, options.timeoutMs);
    if (options.signal?.aborted) queueMicrotask(abort);
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(new ShellStartError(error.message, executable))));
    child.once("close", (code) => finish(() => resolve({
      stdout,
      stderr,
      code: code ?? (interrupted ? 124 : 1),
      interrupted,
      executable
    })));
  });
}

export function encodePowerShellCommand(command: string): string {
  return Buffer.from(powerShellWrapper(command), "utf16le").toString("base64");
}

function powerShellWrapper(command: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$global:LASTEXITCODE = $null",
    "try {",
    `  & { ${command} }`,
    "  $ok = $?",
    "  $code = $global:LASTEXITCODE",
    "  if ($null -ne $code) { exit $code }",
    "  if (-not $ok) { exit 1 }",
    "} catch {",
    "  [Console]::Error.WriteLine($_)",
    "  exit 1",
    "}"
  ].join("\n");
}

function pathExecutables(name: string): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry.replace(/^"|"$/g, ""), name));
}

async function firstUsable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of uniquePaths(candidates)) if (await isUsable(candidate)) return candidate;
  return undefined;
}

async function isUsable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function addCandidate(target: string[], value: string | undefined): void {
  if (value?.trim()) target.push(value.trim());
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return basename(path) !== "" || path !== "";
  });
}
