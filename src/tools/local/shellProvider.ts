import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { basename, delimiter, dirname, join, normalize } from "node:path";
import treeKill from "tree-kill";

export type ShellType = "bash" | "powershell";

export type ShellProcessResult = {
  stdout: string;
  stderr: string;
  code: number;
  interrupted: boolean;
  timedOut: boolean;
  executable: string;
  truncated: boolean;
  persistedOutputPath?: string;
  persistedOutputSize?: number;
};

export type ShellExecutionOptions = {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  outputDir?: string;
  maxOutputLength?: number;
};

export type ShellProvider = {
  type: ShellType;
  shellPath: string;
  detached: boolean;
  spawnArgs(command: string): string[];
};

export const SHELL_MAX_OUTPUT_DEFAULT = 30_000;
export const SHELL_MAX_OUTPUT_UPPER_LIMIT = 150_000;

export class ShellStartError extends Error {
  constructor(message: string, readonly executable?: string) {
    super(message);
    this.name = "ShellStartError";
  }
}

export async function executeBash(command: string, options: ShellExecutionOptions): Promise<ShellProcessResult> {
  const executable = await findBashExecutable();
  if (!executable) throw new ShellStartError("Bash executable was not found");
  return executeProcess(createBashShellProvider(executable), command, options);
}

export async function executePowerShell(command: string, options: ShellExecutionOptions): Promise<ShellProcessResult> {
  const executable = await findPowerShellExecutable();
  if (!executable) throw new ShellStartError("PowerShell executable was not found");
  const result = await executeProcess(createPowerShellProvider(executable), powerShellWrapper(command), options);
  return {
    ...result,
    stdout: cleanPowerShellOutput(result.stdout),
    stderr: cleanPowerShellOutput(result.stderr)
  };
}

export function createBashShellProvider(shellPath: string): ShellProvider {
  return {
    type: "bash",
    shellPath,
    detached: process.platform !== "win32",
    spawnArgs(command) {
      return ["-lc", command];
    }
  };
}

export function createPowerShellProvider(shellPath: string): ShellProvider {
  return {
    type: "powershell",
    shellPath,
    detached: false,
    spawnArgs(command) {
      return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellText(command)];
    }
  };
}

export async function findBashExecutable(): Promise<string | undefined> {
  if (process.platform !== "win32") {
    const configured = process.env.AGENT_TEAM_BASH_PATH || process.env.CLAUDE_CODE_SHELL;
    if (configured && (configured.includes("bash") || configured.includes("zsh")) && await isUsable(configured)) return configured;
    if (process.env.SHELL && (process.env.SHELL.includes("bash") || process.env.SHELL.includes("zsh"))) return process.env.SHELL;
    return "bash";
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

export function getShellMaxOutputLength(): number {
  const raw = process.env.AGENT_TEAM_SHELL_MAX_OUTPUT_LENGTH ?? process.env.BASH_MAX_OUTPUT_LENGTH;
  if (!raw) return SHELL_MAX_OUTPUT_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return SHELL_MAX_OUTPUT_DEFAULT;
  return Math.min(parsed, SHELL_MAX_OUTPUT_UPPER_LIMIT);
}

function executeProcess(provider: ShellProvider, command: string, options: ShellExecutionOptions): Promise<ShellProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let interrupted = false;
    let timedOut = false;
    let terminationStarted = false;
    const collector = new ShellOutputCollector(
      options.maxOutputLength ?? getShellMaxOutputLength(),
      options.outputDir
    );
    let child;
    try {
      child = spawn(provider.shellPath, provider.spawnArgs(command), {
        cwd: options.cwd,
        detached: provider.detached,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SHELL: provider.type === "bash" ? provider.shellPath : process.env.SHELL,
          GIT_EDITOR: "true",
          AGENT_TEAM: "1"
        }
      });
    } catch (error) {
      reject(new ShellStartError(error instanceof Error ? error.message : String(error), provider.shellPath));
      return;
    }

    const finish = async (action: (output: Awaited<ReturnType<ShellOutputCollector["finish"]>>) => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      try {
        action(await collector.finish());
      } catch (error) {
        reject(error);
      }
    };
    const terminate = (reason: "abort" | "timeout") => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      interrupted = reason === "abort";
      timedOut = reason === "timeout";
      if (child.pid) {
        treeKill(child.pid, "SIGKILL", (error) => {
          if (error && !child.killed) child.kill("SIGKILL");
        });
      } else {
        child.kill("SIGKILL");
      }
    };
    const abort = () => terminate("abort");
    const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timer.unref();

    if (options.signal?.aborted) queueMicrotask(abort);
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => collector.append("stdout", chunk));
    child.stderr.on("data", (chunk: string) => collector.append("stderr", chunk));
    child.once("error", (error) => {
      void finish(() => reject(new ShellStartError(error.message, provider.shellPath)));
    });
    child.once("close", (code) => {
      void finish((output) => resolve({
        ...output,
        code: timedOut ? 124 : interrupted ? 130 : code ?? 1,
        interrupted,
        timedOut,
        executable: provider.shellPath
      }));
    });
  });
}

class ShellOutputCollector {
  private stdout = "";
  private stderr = "";
  private stdoutLength = 0;
  private stderrLength = 0;
  private filePath?: string;
  private handle?: FileHandle;
  private writeQueue: Promise<void> = Promise.resolve();
  private history: Array<{ stream: "stdout" | "stderr"; content: string }> = [];
  private truncated = false;

  constructor(private readonly maxLength: number, private readonly outputDir?: string) {}

  append(stream: "stdout" | "stderr", content: string): void {
    const wasPersisting = Boolean(this.filePath);
    if (!wasPersisting) this.history.push({ stream, content });
    if (stream === "stdout") {
      this.stdoutLength += content.length;
      this.stdout += content.slice(0, Math.max(0, this.maxLength - this.stdout.length));
      if (this.stdoutLength > this.maxLength) this.truncated = true;
    } else {
      this.stderrLength += content.length;
      this.stderr += content.slice(0, Math.max(0, this.maxLength - this.stderr.length));
      if (this.stderrLength > this.maxLength) this.truncated = true;
    }
    if (this.truncated && this.outputDir && !this.filePath) this.startPersistence();
    if (wasPersisting) this.queueWrite(stream, content);
  }

  async finish(): Promise<{
    stdout: string;
    stderr: string;
    truncated: boolean;
    persistedOutputPath?: string;
    persistedOutputSize?: number;
  }> {
    await this.writeQueue;
    if (this.handle) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = undefined;
    }
    const persistedOutputSize = this.filePath
      ? (await stat(this.filePath)).size
      : undefined;
    return {
      stdout: this.stdout,
      stderr: this.stderr,
      truncated: this.truncated,
      ...(this.filePath ? { persistedOutputPath: this.filePath } : {}),
      ...(persistedOutputSize !== undefined ? { persistedOutputSize } : {})
    };
  }

  private startPersistence(): void {
    this.filePath = join(this.outputDir!, "shell-" + randomUUID() + ".log");
    const initial = this.history.map(({ stream, content }) => "\n[" + stream + "]\n" + content).join("");
    this.history = [];
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.outputDir!, { recursive: true, mode: 0o700 });
      this.handle = await open(this.filePath!, "wx", 0o600);
      await this.handle.writeFile(initial, "utf8");
    });
  }

  private queueWrite(stream: "stdout" | "stderr", content: string): void {
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.handle) return;
      await this.handle.writeFile("\n[" + stream + "]\n" + content, "utf8");
    });
  }
}


function encodePowerShellText(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function powerShellWrapper(command: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$global:LASTEXITCODE = $null",
    "try {",
    "  & { " + command + " }",
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

export function cleanPowerShellOutput(value: string): string {
  if (!value.includes("#< CLIXML")) return value;
  const body = value.replace(/^#< CLIXML\s*/m, "");
  const messages = [...body.matchAll(/<S S="(?:Error|Warning|Verbose|Debug)">([\s\S]*?)<\/S>/g)]
    .map((match) => decodePowerShellXml(match[1]));
  if (messages.length) return messages.join("\n").trim();
  return decodePowerShellXml(body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodePowerShellXml(value: string): string {
  return value
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/_x000A_/g, "\n")
    .replace(/_x000D_/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function pathExecutables(name: string): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry.replace(/^"|"$/g, ""), name));
}

async function firstUsable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of uniquePaths(candidates)) {
    if (await isUsable(candidate)) return candidate;
  }
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
