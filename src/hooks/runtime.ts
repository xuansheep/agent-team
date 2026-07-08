import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fetch } from "undici";
import type { ModelMessage, ModelProvider, ModelToolCall } from "../providers/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { FunctionHook, HookCommand, HookEvent, HookInput, HookJSONOutput, HookMatcher, HookRunResult, HooksSettings, RuntimeHook } from "./types.js";

const defaultCommandHookTimeoutMs = 10 * 60 * 1000;
const defaultModelHookTimeoutMs = 30 * 1000;
const defaultAgentHookTimeoutMs = 60 * 1000;
const maxAgentHookIterations = 5;
const wiredHookEvents = new Set<HookEvent>(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"]);

export type HookRuntimeContext = {
  cwd: string;
  sessionId: string;
  runId?: string;
  permissionMode?: string;
  signal?: AbortSignal;
  provider?: ModelProvider;
  model?: string;
  tools?: Tool[];
};

export type CommandHookExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandHookExecutor = (
  hook: Extract<HookCommand, { type: "command" }>,
  input: HookInput,
  context: HookRuntimeContext,
  timeoutMs: number,
  detached: boolean
) => CommandHookExecutionResult | Promise<CommandHookExecutionResult> | void;

export type HookRuntimeOptions = {
  commandExecutor?: CommandHookExecutor;
};

export type HookRuntimeDiagnostic = {
  id: string;
  event: HookEvent;
  matcher: string;
  type: RuntimeHook["type"];
  source: HookSource;
  command: string;
  wired: boolean;
  skillRoot?: string;
  once?: boolean;
  disabled?: boolean;
  lastExecution?: {
    outcome: HookExecution["outcome"];
    command: string;
    error?: string;
  };
};

type HookSource = "settings" | "session" | "skill" | "builtin";

type HookEntry = {
  id: string;
  event: HookEvent;
  matcher: string;
  hook: RuntimeHook;
  source: HookSource;
  sessionId?: string;
  skillName?: string;
  skillRoot?: string;
};

type HookExecution = {
  outcome: "success" | "blocking" | "non_blocking_error" | "cancelled";
  command: string;
  output?: HookJSONOutput;
  error?: string;
};

export class HookRuntime {
  private readonly settingsEntries: HookEntry[];
  private readonly sessionEntries = new Map<string, HookEntry>();
  private readonly disabledOnceHooks = new Set<string>();
  private readonly lastExecutions = new Map<string, HookExecution>();

  constructor(hooks?: HooksSettings, private readonly options: HookRuntimeOptions = {}) {
    this.settingsEntries = flattenHooks(hooks, "settings");
  }

  addSessionHooks(hooks: HooksSettings, options: { source?: HookSource; sessionId?: string; skillName?: string; skillRoot?: string } = {}): string[] {
    const entries = flattenHooks(hooks, options.source ?? "session", options);
    for (const entry of entries) this.sessionEntries.set(entry.id, entry);
    return entries.map((entry) => entry.id);
  }

  removeSkillHooks(sessionId: string, skillName: string): void {
    for (const [id, entry] of this.sessionEntries) {
      if (entry.source === "skill" && entry.sessionId === sessionId && entry.skillName === skillName) {
        this.sessionEntries.delete(id);
      }
    }
  }

  clearSessionHooks(sessionId: string): void {
    for (const [id, entry] of this.sessionEntries) {
      if (entry.sessionId === sessionId) {
        this.sessionEntries.delete(id);
        this.disabledOnceHooks.delete(id);
        this.lastExecutions.delete(id);
      }
    }
  }

  addFunctionHook(event: HookEvent, matcher: string, hook: FunctionHook, options: { source?: HookSource } = {}): string {
    const id = hook.id ?? `function-hook-${randomUUID()}`;
    this.sessionEntries.set(id, {
      id,
      event,
      matcher,
      hook: { ...hook, id },
      source: options.source ?? "builtin"
    });
    return id;
  }

  removeSessionHook(id: string): void {
    this.sessionEntries.delete(id);
  }

  async run(event: HookEvent, input: Record<string, unknown>, context: HookRuntimeContext): Promise<HookRunResult> {
    const hookInput = normalizeHookInput(event, input, context);
    const result: HookRunResult = {
      event,
      executed: 0,
      blockingErrors: [],
      nonBlockingErrors: [],
      additionalContexts: [],
      systemMessages: []
    };

    for (const entry of this.entriesForEvent(event, hookInput)) {
      if (this.disabledOnceHooks.has(entry.id)) continue;
      const execution = await this.executeEntry(entry, hookInput, context);
      this.lastExecutions.set(entry.id, execution);
      if (execution.outcome === "cancelled") continue;
      result.executed += 1;
      if (execution.outcome === "non_blocking_error") {
        result.nonBlockingErrors.push(execution.error ?? `Hook failed: ${execution.command}`);
      }
      if (execution.outcome === "blocking") {
        result.blockingErrors.push({
          blockingError: execution.error ?? execution.output?.reason ?? "Blocked by hook",
          command: execution.command
        });
      }
      if (execution.output) applyHookOutput(result, execution.output, execution.command);
      if (entry.hook.once && execution.outcome === "success") this.disabledOnceHooks.add(entry.id);
    }

    return result;
  }

  private entriesForEvent(event: HookEvent, input: HookInput): HookEntry[] {
    return [...this.settingsEntries, ...this.sessionEntries.values()]
      .filter((entry) => entry.event === event)
      .filter((entry) => matchesHook(entry, input));
  }

  private async executeEntry(entry: HookEntry, input: HookInput, context: HookRuntimeContext): Promise<HookExecution> {
    const hook = entry.hook;
    if (hook.type === "function") return executeFunctionHook(hook, input, context.signal);
    if (hook.type === "command") return executeCommandHook(hook, input, context, this.options.commandExecutor);
    if (hook.type === "http") return executeHttpHook(hook, input, context);
    return executeModelHook(hook, input, context);
  }

  getDiagnostics(): HookRuntimeDiagnostic[] {
    return [...this.settingsEntries, ...this.sessionEntries.values()].map((entry) => {
      const lastExecution = this.lastExecutions.get(entry.id);
      return {
        id: entry.id,
        event: entry.event,
        matcher: entry.matcher,
        type: entry.hook.type,
        source: entry.source,
        command: hookCommandLabel(entry.hook),
        wired: wiredHookEvents.has(entry.event),
        skillRoot: entry.skillRoot,
        once: entry.hook.once,
        disabled: this.disabledOnceHooks.has(entry.id),
        lastExecution: lastExecution ? {
          outcome: lastExecution.outcome,
          command: lastExecution.command,
          error: lastExecution.error
        } : undefined
      };
    });
  }
}

export function registerSkillHooks(runtime: HookRuntime, hooks: HooksSettings | undefined, skillName: string, skillRoot?: string, sessionId?: string): string[] {
  if (!hooks || Object.keys(hooks).length === 0) return [];
  const hookSessionId = sessionId ?? "global";
  runtime.removeSkillHooks(hookSessionId, skillName);
  return runtime.addSessionHooks(hooks, { source: "skill", sessionId: hookSessionId, skillName, skillRoot });
}

function flattenHooks(
  hooks: HooksSettings | undefined,
  source: HookSource,
  options: { sessionId?: string; skillName?: string; skillRoot?: string } = {}
): HookEntry[] {
  if (!hooks) return [];
  const entries: HookEntry[] = [];
  for (const [event, matchers] of Object.entries(hooks) as Array<[HookEvent, HookMatcher[] | undefined]>) {
    for (const matcher of matchers ?? []) {
      for (const hook of matcher.hooks) {
        entries.push({
          id: `${source}:${event}:${entries.length}:${randomUUID()}`,
          event,
          matcher: matcher.matcher ?? "",
          hook,
          source,
          sessionId: options.sessionId,
          skillName: options.skillName,
          skillRoot: options.skillRoot
        });
      }
    }
  }
  return entries;
}

function hookCommandLabel(hook: RuntimeHook): string {
  if (hook.type === "function") return "function";
  if (hook.type === "http") return hook.url;
  if (hook.type === "command") return hook.command;
  return hook.prompt;
}

function normalizeHookInput(event: HookEvent, input: Record<string, unknown>, context: HookRuntimeContext): HookInput {
  return {
    ...input,
    hook_event_name: event,
    session_id: context.sessionId,
    cwd: context.cwd,
    ...(context.runId ? { run_id: context.runId } : {}),
    ...(context.permissionMode ? { permission_mode: context.permissionMode } : {})
  };
}

function matchesHook(entry: HookEntry, input: HookInput): boolean {
  if (!matchesMatcher(entry.matcher, input)) return false;
  const condition = entry.hook.type === "function" ? undefined : entry.hook.if;
  if (!condition) return true;
  return matchesCondition(condition, input);
}

function matchesMatcher(matcher: string, input: HookInput): boolean {
  if (!matcher.trim()) return true;
  const value = matchValue(input);
  return value !== undefined && wildcardMatch(String(value), matcher);
}

function matchesCondition(condition: string, input: HookInput): boolean {
  const trimmed = condition.trim();
  const match = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/.exec(trimmed);
  if (!match) return false;
  const name = match[1]!;
  const pattern = match[2];
  if (!wildcardMatch(String(input.tool_name ?? input.hook_event_name), name)) return false;
  if (!pattern) return true;
  const candidate = String(input.tool_input ?? input.prompt ?? input.message ?? "");
  return wildcardMatch(candidate, pattern);
}

function matchValue(input: HookInput): unknown {
  return input.tool_name ?? input.prompt ?? input.message ?? input.reason ?? input.hook_event_name;
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`);
  return regex.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

async function executeFunctionHook(hook: FunctionHook, input: HookInput, signal?: AbortSignal): Promise<HookExecution> {
  try {
    const output = await runWithTimeout(
      (abortSignal) => hook.callback(input, abortSignal),
      secondsToMs(hook.timeout) ?? defaultModelHookTimeoutMs,
      signal
    );
    if (typeof output === "boolean") {
      return output
        ? { outcome: "success", command: "function" }
        : { outcome: "blocking", command: "function", error: hook.errorMessage ?? "Blocked by function hook" };
    }
    return hookOutputToExecution(output, "function");
  } catch (error) {
    if (isAbortLikeError(error)) return { outcome: "cancelled", command: "function" };
    return { outcome: "non_blocking_error", command: "function", error: errorMessage(error) };
  }
}

async function executeCommandHook(
  hook: Extract<HookCommand, { type: "command" }>,
  input: HookInput,
  context: HookRuntimeContext,
  commandExecutor: CommandHookExecutor = defaultCommandExecutor
): Promise<HookExecution> {
  const timeoutMs = secondsToMs(hook.timeout) ?? defaultCommandHookTimeoutMs;
  if (hook.async || hook.asyncRewake) {
    commandExecutor(hook, input, context, timeoutMs, true);
    return { outcome: "success", command: hook.command };
  }

  try {
    const completed = await commandExecutor(hook, input, context, timeoutMs, false) as CommandHookExecutionResult;
    const parsed = parseHookOutput(completed.stdout);
    if (completed.exitCode === 2) {
      return {
        outcome: "blocking",
        command: hook.command,
        output: parsed,
        error: parsed?.reason ?? (completed.stderr.trim() || completed.stdout.trim() || "Blocked by command hook")
      };
    }
    if (completed.exitCode !== 0) {
      return {
        outcome: "non_blocking_error",
        command: hook.command,
        output: parsed,
        error: completed.stderr.trim() || completed.stdout.trim() || `Hook exited with ${completed.exitCode}`
      };
    }
    return parsed ? hookOutputToExecution(parsed, hook.command) : { outcome: "success", command: hook.command };
  } catch (error) {
    if (isAbortLikeError(error)) return { outcome: "cancelled", command: hook.command };
    return { outcome: "non_blocking_error", command: hook.command, error: errorMessage(error) };
  }
}

function spawnHookProcess(
  hook: Extract<HookCommand, { type: "command" }>,
  input: HookInput,
  context: HookRuntimeContext,
  timeoutMs: number,
  detached: true
): void;
function spawnHookProcess(
  hook: Extract<HookCommand, { type: "command" }>,
  input: HookInput,
  context: HookRuntimeContext,
  timeoutMs: number,
  detached: false
): Promise<{ stdout: string; stderr: string; exitCode: number }>;
function spawnHookProcess(
  hook: Extract<HookCommand, { type: "command" }>,
  input: HookInput,
  context: HookRuntimeContext,
  timeoutMs: number,
  detached: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> | void {
  const child = spawn(hook.command, {
    cwd: context.cwd,
    shell: shellForHook(hook.shell),
    detached,
    env: {
      ...process.env,
      AGENT_TEAM_HOOK_EVENT: input.hook_event_name,
      AGENT_TEAM_HOOK_INPUT: JSON.stringify(input)
    },
    stdio: detached ? "ignore" : "pipe"
  });

  if (detached) {
    child.unref();
    return;
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.end(JSON.stringify(input));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error("Hook command timed out"), { name: "AbortError" }));
    }, timeoutMs);
    const abort = () => {
      child.kill();
      reject(Object.assign(new Error("Hook command aborted"), { name: "AbortError" }));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 0
      });
    });
  });
}

const defaultCommandExecutor: CommandHookExecutor = (hook, input, context, timeoutMs, detached) => {
  return detached
    ? spawnHookProcess(hook, input, context, timeoutMs, true)
    : spawnHookProcess(hook, input, context, timeoutMs, false);
};

function shellForHook(shell: Extract<HookCommand, { type: "command" }>["shell"]): boolean | string {
  if (!shell || shell === "bash" || shell === "sh") return true;
  if (shell === "powershell") return "powershell.exe";
  if (shell === "pwsh") return "pwsh";
  return "cmd.exe";
}

async function executeHttpHook(hook: Extract<HookCommand, { type: "http" }>, input: HookInput, context: HookRuntimeContext): Promise<HookExecution> {
  const timeoutMs = secondsToMs(hook.timeout) ?? defaultCommandHookTimeoutMs;
  try {
    const body = await runWithTimeout(async (signal) => {
      const response = await fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(hook.headers ?? {}) },
        body: JSON.stringify(input),
        signal
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    }, timeoutMs, context.signal);
    const parsed = parseHookOutput(body.text);
    if (!body.ok) {
      return { outcome: "non_blocking_error", command: hook.url, output: parsed, error: `HTTP hook returned ${body.status}` };
    }
    return parsed ? hookOutputToExecution(parsed, hook.url) : { outcome: "success", command: hook.url };
  } catch (error) {
    if (isAbortLikeError(error)) return { outcome: "cancelled", command: hook.url };
    return { outcome: "non_blocking_error", command: hook.url, error: errorMessage(error) };
  }
}

async function executeModelHook(
  hook: Extract<HookCommand, { type: "prompt" | "agent" }>,
  input: HookInput,
  context: HookRuntimeContext
): Promise<HookExecution> {
  if (!context.provider || !context.model) {
    return { outcome: "non_blocking_error", command: hook.prompt, error: `${hook.type} hook requires a model provider` };
  }
  if (hook.type === "agent") return executeAgentHook(hook, input, context);

  const timeoutMs = secondsToMs(hook.timeout) ?? defaultModelHookTimeoutMs;
  try {
    const response = await runWithTimeout(async (signal) => {
      const messages: ModelMessage[] = [
        {
          role: "system",
          content: modelHookSystemMessage()
        },
        { role: "user", content: hookPrompt(hook.prompt, input) }
      ];
      return context.provider!.generate({
        model: hook.model ?? context.model!,
        messages,
        tools: [],
        response_schema: hookResponseSchema(),
        signal
      });
    }, timeoutMs, context.signal);
    const parsed = parseHookOutput(response.content ?? "");
    return modelHookOutputToExecution(parsed, hook.prompt);
  } catch (error) {
    if (isAbortLikeError(error)) return { outcome: "cancelled", command: hook.prompt };
    return { outcome: "non_blocking_error", command: hook.prompt, error: errorMessage(error) };
  }
}

async function executeAgentHook(
  hook: Extract<HookCommand, { type: "agent" }>,
  input: HookInput,
  context: HookRuntimeContext
): Promise<HookExecution> {
  const timeoutMs = secondsToMs(hook.timeout) ?? defaultAgentHookTimeoutMs;
  try {
    return await runWithTimeout(async (signal) => {
      const messages: ModelMessage[] = [
        {
          role: "system",
          content: `${modelHookSystemMessage()} You may call only the supplied read-only tools. Do not request user interaction.`
        },
        { role: "user", content: hookPrompt(hook.prompt, input) }
      ];
      for (let iteration = 0; iteration < maxAgentHookIterations; iteration += 1) {
        const response = await context.provider!.generate({
          model: hook.model ?? context.model!,
          messages,
          tools: context.tools ?? [],
          response_schema: hookResponseSchema(),
          signal
        });
        if (!response.tool_calls?.length) {
          return modelHookOutputToExecution(parseHookOutput(response.content ?? ""), hook.prompt);
        }
        messages.push({ role: "assistant", content: response.content ?? "", tool_calls: response.tool_calls });
        for (const call of response.tool_calls) {
          messages.push(await executeAgentHookToolCall(call, context));
        }
      }
      return { outcome: "non_blocking_error", command: hook.prompt, error: "Agent hook exceeded tool iterations" };
    }, timeoutMs, context.signal);
  } catch (error) {
    if (isAbortLikeError(error)) return { outcome: "cancelled", command: hook.prompt };
    return { outcome: "non_blocking_error", command: hook.prompt, error: errorMessage(error) };
  }
}

async function executeAgentHookToolCall(call: ModelToolCall, context: HookRuntimeContext): Promise<ModelMessage> {
  const tool = (context.tools ?? []).find((candidate) => candidate.name === call.name);
  if (!tool) return toolMessage(call.id, { error: `Unknown hook tool ${call.name}` });
  const toolContext: ToolContext = {
    cwd: context.cwd,
    sessionId: context.sessionId,
    runId: context.runId,
    abortSignal: context.signal,
    nodeId: "hook-agent",
    attempt: 1
  };
  if (await tool.requiresUserInteraction?.(call.input)) {
    return toolMessage(call.id, { error: `Hook tool ${call.name} requires user interaction and was denied` });
  }
  if (tool.isReadOnly?.(call.input, toolContext) !== true) {
    return toolMessage(call.id, { error: `Hook tool ${call.name} is not read-only and was denied` });
  }
  try {
    return toolMessage(call.id, await tool.execute(call.input, toolContext));
  } catch (error) {
    return toolMessage(call.id, { error: errorMessage(error) });
  }
}

function toolMessage(toolCallId: string, result: unknown): ModelMessage {
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(result) };
}

function hookPrompt(prompt: string, input: HookInput): string {
  const jsonInput = JSON.stringify(input);
  return prompt.includes("$ARGUMENTS") ? prompt.replace(/\$ARGUMENTS/g, jsonInput) : `${prompt}\n\n${jsonInput}`;
}

function modelHookSystemMessage(): string {
  return "You are evaluating an agent-team hook. Return only JSON: {\"ok\":true} or {\"ok\":false,\"reason\":\"...\"}.";
}

function hookResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { ok: { type: "boolean" }, reason: { type: "string" } },
    required: ["ok"],
    additionalProperties: false
  };
}

function modelHookOutputToExecution(output: HookJSONOutput | undefined, command: string): HookExecution {
  if (!output) return { outcome: "non_blocking_error", command, error: "Model hook returned no JSON" };
  if (typeof (output as { ok?: unknown }).ok === "boolean") {
    const ok = (output as { ok: boolean; reason?: string }).ok;
    return ok ? { outcome: "success", command } : { outcome: "blocking", command, error: (output as { reason?: string }).reason ?? "Blocked by model hook" };
  }
  return hookOutputToExecution(output, command);
}

function parseHookOutput(output: string): HookJSONOutput | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as HookJSONOutput;
  } catch {
    return undefined;
  }
}

function hookOutputToExecution(output: HookJSONOutput, command: string): HookExecution {
  if (output.continue === false || output.decision === "block") {
    return { outcome: "blocking", command, output, error: output.reason ?? output.stopReason ?? "Blocked by hook" };
  }
  if (output.hookSpecificOutput?.permissionDecision === "deny") {
    return { outcome: "blocking", command, output, error: output.reason ?? "Denied by hook" };
  }
  return { outcome: "success", command, output };
}

function applyHookOutput(result: HookRunResult, output: HookJSONOutput, command: string): void {
  if (output.continue === false) result.preventContinuation = true;
  if (output.stopReason) result.stopReason = output.stopReason;
  if (output.systemMessage) result.systemMessages.push(output.systemMessage);
  if (output.decision === "approve") result.permissionBehavior = "allow";
  if (output.decision === "block") result.permissionBehavior = "deny";
  const specific = output.hookSpecificOutput;
  if (!specific) return;
  if (specific.permissionDecision) result.permissionBehavior = specific.permissionDecision;
  if (typeof specific.additionalContext === "string" && specific.additionalContext.trim()) result.additionalContexts.push(specific.additionalContext);
  if (specific.updatedInput && typeof specific.updatedInput === "object" && !Array.isArray(specific.updatedInput)) {
    result.updatedInput = specific.updatedInput;
  }
  if ("updatedMCPToolOutput" in specific) result.updatedMCPToolOutput = specific.updatedMCPToolOutput;
  if (result.permissionBehavior === "deny" && !result.blockingErrors.length) {
    result.blockingErrors.push({ blockingError: output.reason ?? "Denied by hook", command });
  }
}

async function runWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T> | T, timeoutMs: number, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

function secondsToMs(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : Math.max(1, Math.floor(seconds * 1000));
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
