import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { resolveWorkspacePath } from "../../security/pathBoundary.js";
import { ToolExecutionError, toolPolicyFailureResult } from "../errors.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { SHELL_TERMINATION_SETTLE_MS, terminateProcessTree } from "./shellProvider.js";

const STARTUP_GRACE_MS = 250;
const PROCESS_LOG_MAX_BYTES = 10 * 1024 * 1024;
const PROCESS_TAIL_MAX_CHARS = 8 * 1024;

const startSchema = z.object({
  executable: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default(".")
});
const processIdSchema = z.object({ process_id: z.string().uuid() });

export type ManagedProcessStopReason = "explicit" | "node_complete" | "node_error" | "interrupted";

export type ManagedProcessLifecycleEvent =
  | { type: "managed_process_started"; process_id: string; pid: number; executable: string; output_path?: string }
  | { type: "managed_process_stopped"; process_id: string; pid: number; reason: ManagedProcessStopReason; exit_code: number | null }
  | { type: "managed_process_cleanup_failed"; process_id: string; pid: number; reason: ManagedProcessStopReason; error: string };

type ManagedProcessRecord = {
  id: string;
  child: ManagedChild;
  executable: string;
  args: string[];
  cwd: string;
  output: ManagedProcessOutput;
  state: "running" | "exited";
  exitCode: number | null;
  exitPromise: Promise<void>;
  completeExit: (code: number | null) => void;
  stopEventEmitted: boolean;
};

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export class ManagedProcessManager {
  private readonly processes = new Map<string, ManagedProcessRecord>();

  constructor(private readonly onEvent?: (event: ManagedProcessLifecycleEvent) => void | Promise<void>) {}

  async start(
    input: z.infer<typeof startSchema>,
    context: Pick<ToolContext, "cwd" | "runDir" | "abortSignal">
  ): Promise<ToolResult> {
    context.abortSignal?.throwIfAborted();
    const cwd = resolveWorkspacePath(context.cwd, input.cwd);
    const id = randomUUID();
    const output = new ManagedProcessOutput(context.runDir ? join(context.runDir, "process-output", `${id}.log`) : undefined);
    let child: ManagedChild;
    try {
      child = spawn(input.executable, input.args, {
        cwd,
        detached: false,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
    } catch (error) {
      throw processStartError(input.executable, error);
    }

    const record = createRecord(id, child, input.executable, input.args, cwd, output);
    this.processes.set(id, record);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => output.append("stdout", chunk));
    child.stderr.on("data", (chunk: string) => output.append("stderr", chunk));

    try {
      await waitForSpawn(child);
      await Promise.race([record.exitPromise, delay(STARTUP_GRACE_MS)]);
      context.abortSignal?.throwIfAborted();
      if (record.state === "exited") {
        throw new ToolExecutionError(
          `Managed process exited during startup with code ${String(record.exitCode)}`,
          {
            is_error: true,
            error: `Managed process exited during startup with code ${String(record.exitCode)}`,
            exit_code: record.exitCode ?? 1,
            output: output.stdoutTail,
            stderr: output.stderrTail,
            data: processData(record)
          }
        );
      }
      await this.onEvent?.({
        type: "managed_process_started",
        process_id: id,
        pid: child.pid!,
        executable: input.executable,
        ...(output.path ? { output_path: output.path } : {})
      });
      return {
        output: `Started managed process ${id} (PID ${child.pid})`,
        data: processData(record)
      };
    } catch (error) {
      if (record.state === "running") await this.stopRecord(record, "node_error").catch(() => undefined);
      this.processes.delete(id);
      await output.finish();
      if (error instanceof ToolExecutionError) throw error;
      throw processStartError(input.executable, error);
    }
  }

  status(processId: string): ToolResult {
    const record = this.require(processId);
    return {
      output: record.state === "running"
        ? `Managed process ${processId} is running`
        : `Managed process ${processId} exited with code ${String(record.exitCode)}`,
      exit_code: record.state === "exited" ? record.exitCode ?? 1 : undefined,
      data: processData(record)
    };
  }

  async stop(processId: string, reason: ManagedProcessStopReason = "explicit"): Promise<ToolResult> {
    const record = this.require(processId);
    await this.stopRecord(record, reason);
    return {
      output: `Stopped managed process ${processId}`,
      exit_code: record.exitCode ?? 0,
      data: processData(record)
    };
  }

  async dispose(reason: Exclude<ManagedProcessStopReason, "explicit">): Promise<void> {
    const failures: Error[] = [];
    for (const record of this.processes.values()) {
      if (record.state === "exited") {
        await record.output.finish();
        continue;
      }
      try {
        await this.stopRecord(record, reason);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length) throw new AggregateError(failures, "Managed process cleanup failed");
  }

  private require(processId: string): ManagedProcessRecord {
    const record = this.processes.get(processId);
    if (!record) throw new Error(`Unknown managed process ${processId}`);
    return record;
  }

  private async stopRecord(record: ManagedProcessRecord, reason: ManagedProcessStopReason): Promise<void> {
    if (record.state === "running") {
      const termination = terminateProcessTree(record.child.pid!, () => {
        if (!record.child.killed) record.child.kill("SIGKILL");
      });
      await Promise.race([record.exitPromise, termination.then(() => delay(SHELL_TERMINATION_SETTLE_MS))]);
    }
    if (record.state === "running") {
      const error = new Error(`Managed process ${record.id} (PID ${record.child.pid}) did not exit after forced termination`);
      await this.onEvent?.({
        type: "managed_process_cleanup_failed",
        process_id: record.id,
        pid: record.child.pid!,
        reason,
        error: error.message
      });
      throw error;
    }
    await record.output.finish();
    if (!record.stopEventEmitted) {
      record.stopEventEmitted = true;
      await this.onEvent?.({
        type: "managed_process_stopped",
        process_id: record.id,
        pid: record.child.pid!,
        reason,
        exit_code: record.exitCode
      });
    }
  }
}

export function createManagedProcessTools(manager: ManagedProcessManager): Tool[] {
  const startTool: Tool = {
    name: "ProcessStart",
    description: "Start a node-scoped managed process without a shell. The process is automatically stopped when the node ends.",
    input_schema: {
      type: "object",
      properties: {
        executable: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" }
      },
      required: ["executable"]
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    async execute(input, context) {
      return manager.start(startSchema.parse(input), context);
    }
  };
  const statusTool: Tool = {
    name: "ProcessStatus",
    description: "Inspect a process previously started with ProcessStart.",
    input_schema: {
      type: "object",
      properties: { process_id: { type: "string" } },
      required: ["process_id"]
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      return manager.status(processIdSchema.parse(input).process_id);
    }
  };
  const stopTool: Tool = {
    name: "ProcessStop",
    description: "Stop a process previously started with ProcessStart and wait for its process tree to exit.",
    input_schema: {
      type: "object",
      properties: { process_id: { type: "string" } },
      required: ["process_id"]
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    async execute(input) {
      return manager.stop(processIdSchema.parse(input).process_id);
    }
  };
  return [startTool, statusTool, stopTool];
}

function createRecord(
  id: string,
  child: ManagedChild,
  executable: string,
  args: string[],
  cwd: string,
  output: ManagedProcessOutput
): ManagedProcessRecord {
  let completeExit!: (code: number | null) => void;
  const exitPromise = new Promise<void>((resolve) => {
    completeExit = (code) => {
      if (record.state === "exited") return;
      record.state = "exited";
      record.exitCode = code;
      resolve();
      void output.finish();
    };
  });
  const record: ManagedProcessRecord = {
    id,
    child,
    executable,
    args: [...args],
    cwd,
    output,
    state: "running",
    exitCode: null,
    exitPromise,
    completeExit,
    stopEventEmitted: false
  };
  child.once("exit", (code) => {
    setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      completeExit(code);
    }, SHELL_TERMINATION_SETTLE_MS).unref();
  });
  child.once("close", (code) => completeExit(code));
  return record;
}

function processData(record: ManagedProcessRecord): Record<string, unknown> {
  return {
    process_id: record.id,
    pid: record.child.pid,
    executable: record.executable,
    args: record.args,
    cwd: record.cwd,
    state: record.state,
    exit_code: record.exitCode,
    stdout_tail: record.output.stdoutTail,
    stderr_tail: record.output.stderrTail,
    output_path: record.output.path,
    output_truncated: record.output.truncated
  };
}

function waitForSpawn(child: ManagedChild): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function processStartError(executable: string, error: unknown): ToolExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ToolExecutionError(
    `Failed to start managed process ${executable}: ${message}`,
    toolPolicyFailureResult("process.start.failed", `Failed to start managed process ${executable}: ${message}`, executable)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ManagedProcessOutput {
  private handle?: FileHandle;
  private writeQueue: Promise<void> = Promise.resolve();
  private scheduledBytes = 0;
  private finishPromise?: Promise<void>;
  stdoutTail = "";
  stderrTail = "";
  truncated = false;

  constructor(readonly path?: string) {}

  append(stream: "stdout" | "stderr", content: string): void {
    if (this.finishPromise) return;
    if (stream === "stdout") this.stdoutTail = tail(this.stdoutTail + content);
    else this.stderrTail = tail(this.stderrTail + content);
    if (!this.path || this.scheduledBytes >= PROCESS_LOG_MAX_BYTES) {
      if (this.path) this.truncated = true;
      return;
    }
    const entry = Buffer.from(`\n[${stream}]\n${content}`, "utf8");
    const remaining = PROCESS_LOG_MAX_BYTES - this.scheduledBytes;
    const chunk = entry.subarray(0, remaining);
    this.scheduledBytes += chunk.length;
    if (chunk.length < entry.length) this.truncated = true;
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.handle) {
        await mkdir(dirname(this.path!), { recursive: true, mode: 0o700 });
        this.handle = await open(this.path!, "wx", 0o600);
      }
      await this.handle.write(chunk);
    });
  }

  async finish(): Promise<void> {
    if (!this.finishPromise) this.finishPromise = this.close();
    await this.finishPromise;
  }

  private async close(): Promise<void> {
    await this.writeQueue;
    if (!this.handle) return;
    await this.handle.sync();
    await this.handle.close();
    this.handle = undefined;
  }
}

function tail(value: string): string {
  return value.length <= PROCESS_TAIL_MAX_CHARS ? value : value.slice(-PROCESS_TAIL_MAX_CHARS);
}
