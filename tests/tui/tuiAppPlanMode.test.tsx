import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { planRejectionMessage, TuiApp } from "../../src/tui/TuiApp.js";
import { getPlanFilePath, readPlan, writePlan } from "../../src/plans/planFiles.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";

const config = {
  providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
  roles: { product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } } },
  workflows: { delivery: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] } }
};
const configWithContextWindow = {
  ...config,
  providers: { default: { ...config.providers.default, context_windows: { "gpt-test": 100000 } } }
};

describe("TuiApp global Plan Mode", () => {
  const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");

  before(() => {
    Object.defineProperty(process.stdout, "rows", { value: 48, configurable: true });
  });

  after(() => {
    if (stdoutRows) Object.defineProperty(process.stdout, "rows", stdoutRows);
    else Reflect.deleteProperty(process.stdout, "rows");
  });

  it("starts in Plan Mode when settings default to plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} settings={{ permissions: { defaultMode: "plan" } }} />);

    await waitForFrame(output, /Enabled plan mode/);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /> Type a request or \/help/);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| plan \|/);

    output.unmount();
    output.cleanup();
  });

  it("shows the first message submitted while the input permission mode is plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} settings={{ permissions: { defaultMode: "plan" } }} />);

    await sendTuiLine(output, "Draft from the plan permission mode.");
    await waitForFrame(output, /Draft from the plan permission mode\./);
    await waitForRequest(requests, "Draft from the plan permission mode.");

    assert.equal(starts, 0);
    assert.doesNotMatch(output.lastFrame() ?? "", /Plan draft updated/);

    output.unmount();
    output.cleanup();
  });

  it("creates default Plan Mode sessions without the plan prefix", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Check generated session id.");
    const request = await waitForRequest(requests, "Check generated session id.");
    const sessionId = request.context?.sessionId;
    const planFilePath = planFilePathFromRequest(request);

    assert.equal(typeof sessionId, "string");
    assert.doesNotMatch(sessionId as string, /^plan-/);
    assert.doesNotMatch(planFilePath, new RegExp(String.raw`[\\/]\d{2}T\d{6}-plan-`));

    output.unmount();
    output.cleanup();
  });

  it("shows /help shortcuts without the old footer status bar", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/help");
    await waitForFrame(output, /Keyboard shortcuts:/);
    const frame = output.lastFrame() ?? "";

    assert.match(frame, /\/plan \[open\|text\]/);
    assert.match(frame, /Ctrl\+G/);
    assert.match(frame, /\/mcp list and manage MCP servers/);
    assert.doesNotMatch(frame, /\/diagnostics/);
    assert.doesNotMatch(frame, /workflow delivery \| mode/);
    assert.doesNotMatch(frame, /mode [^\n]*Ctrl\+C stop/);

    output.unmount();
    output.cleanup();
  });

  it("shows the current MCP server list from /mcp", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-mcp-list-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      diagnostics={{
        mcp: [
          { name: "docs", source: "project", state: "connected", transport: "http", toolCount: 1, resourceCount: 2, promptCount: 3 },
          { name: "broken", source: "user", state: "failed", error: "boom", transport: "stdio", toolCount: 0, resourceCount: 0, promptCount: 0 }
        ],
        skills: []
      }}
    />);

    await sendTuiLine(output, "/mcp");
    await waitForFrame(output, /MCP Servers/);
    const frame = output.lastFrame() ?? "";

    assert.match(frame, /2 visible servers/);
    assert.match(frame, /docs/);
    assert.match(frame, /connected/);
    assert.match(frame, /broken/);
    assert.match(frame, /failed/);

    output.unmount();
    output.cleanup();
  });

  it("customizes and persists the bottom statusline with command arguments", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const saved: string[][] = [];
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={planProviderFactory}
        saveStatuslineElements={async (elements) => { saved.push([...elements]); }}
      />
    );

    await sendTuiLine(output, "/statusline permission,tokens-cache");
    await waitForFrame(output, /Statusline updated/);
    let frame = output.lastFrame() ?? "";

    assert.match(frame, /default \| cache 0 \(0%\)/);
    const customStatusLine = frame.split("\n").filter((line) => line.includes("default | cache 0 (0%)")).at(-1) ?? "";
    assert.doesNotMatch(customStatusLine, /delivery/);

    await sendTuiLine(output, "/statusline mode,work-mode,loading");
    await waitForFrame(output, /Unknown element: mode, work-mode, loading/);

    await sendTuiLine(output, "/statusline run,tokens,cache");
    await waitForFrame(output, /Unknown element: run, tokens, cache/);

    await sendTuiLine(output, "/statusline default");
    await waitForFrame(output, /Statusline reset/);
    await sendTuiLine(output, "/statusline all");
    await waitForFrame(output, /Statusline updated/);
    await settleTuiWork();

    assert.deepEqual(saved, [
      ["permission", "tokens-cache"],
      ["run-state", "permission", "current-dir", "git-branch", "tokens-io", "tokens-cache", "run-id", "selection"],
      ["run-state", "permission", "current-dir", "git-branch", "workflow", "run-id", "tokens-io", "tokens-cache", "requests", "selection"]
    ]);

    output.unmount();
    output.cleanup();
  });

  it("shows the current Git branch while plan work is running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-git-branch-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const provider: ModelProvider = {
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 750));
        return { content: "Plan updated." };
      }
    };
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={() => provider}
        resolveGitBranch={async (requestedCwd) => {
          assert.equal(requestedCwd, cwd);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return "feature/statusline";
        }}
      />
    );

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Keep the branch visible while working.");
    await waitForFrame(output, /feature\/statusline/);
    assert.match(output.lastFrame() ?? "", /Thinking \| plan \|/);

    await waitForFrame(output, /Plan updated\./);
    output.unmount();
    output.cleanup();
  });

  it("tracks token I/O, cache metrics, and successful model responses across clear", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Usage recorded.",
          usage: { inputTokens: 15_000, cachedInputTokens: 3_000, outputTokens: 300, totalTokens: 15_300 }
        };
      }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Audit this session.");
    await waitForFrame(output, /tokens 15K\/300 \|\s+cache 3K \(20%\)/);

    await sendTuiLine(output, "/clear");
    await settleTuiWork();
    assert.match(output.lastFrame() ?? "", /tokens 15K\/300 \|\s+cache 3K \(20%\)/);


    output.unmount();
    output.cleanup();
  });

  it("shows one temporary Plan Mode retry status and removes it after recovery", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-plan-retry-");
    const engine = { async startInteractive() { return fakeSession(); } };
    let release!: () => void;
    const recovery = new Promise<void>((resolve) => { release = resolve; });
    const provider: ModelProvider = {
      async generate(request) {
        await request.onRetry?.({
          phase: "request",
          retryAttempt: 1,
          maxRetries: 10,
          retryInMs: 5_000,
          scheduledAt: new Date().toISOString(),
          retryAt: new Date(Date.now() + 5_000).toISOString(),
          errorKind: "server",
          status: 503,
          message: "service unavailable",
          discardedContentChars: 0,
          discardedThinkingChars: 0
        });
        await recovery;
        return { content: "Recovered after retry." };
      }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Retry this plan request.");
    await waitForFrame(output, /模型重连中 .* 1\/10/);
    assert.equal((output.lastFrame() ?? "").match(/模型请求将在/g)?.length, 1);

    release();
    await waitForFrame(output, /Recovered after retry\./);
    assert.doesNotMatch(output.lastFrame() ?? "", /模型重连中|模型请求将在/);

    output.unmount();
    output.cleanup();
  });

  it("keeps toggle rows stable, reorders immediately with arrows, and persists each change", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const saved: string[][] = [];
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={planProviderFactory}
        saveStatuslineElements={async (elements) => { saved.push([...elements]); }}
      />
    );

    await sendTuiLine(output, "/statusline");
    await waitForFrame(output, /Left\/right to reorder enabled items/);
    let frame = output.lastFrame() ?? "";

    for (const element of ["run-state", "permission", "current-dir", "git-branch", "tokens-io", "tokens-cache", "run-id", "workflow", "requests", "selection"]) {
      assert.match(frame, new RegExp("\\[[ \\u2713]\\] " + element));
    }
    assert.ok(frame.indexOf("[\u2713] permission") < frame.indexOf("[\u2713] current-dir"));

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[C");
    await settleTuiWork();
    frame = output.lastFrame() ?? "";
    assert.deepEqual(saved.at(-1)?.slice(0, 3), ["run-state", "current-dir", "permission"]);
    assert.ok(frame.indexOf("[\u2713] current-dir") < frame.indexOf("[\u2713] permission"));

    output.stdin.write("\u001b[D");
    await settleTuiWork();
    frame = output.lastFrame() ?? "";
    assert.deepEqual(saved.at(-1)?.slice(0, 3), ["run-state", "permission", "current-dir"]);
    assert.ok(frame.indexOf("[\u2713] permission") < frame.indexOf("[\u2713] current-dir"));

    output.stdin.write(" ");
    await waitForFrame(output, /\[ \] permission/);
    frame = output.lastFrame() ?? "";
    assert.ok(frame.indexOf("[ ] permission") < frame.indexOf("[\u2713] current-dir"));
    assert.doesNotMatch(frame.split("\n").filter((line) => line.includes(cwd)).at(-1) ?? "", /\bdefault\b/);

    await settleTuiWork();
    assert.deepEqual(saved, [
      ["run-state", "current-dir", "permission", "git-branch", "tokens-io", "tokens-cache", "run-id", "selection"],
      ["run-state", "permission", "current-dir", "git-branch", "tokens-io", "tokens-cache", "run-id", "selection"],
      ["run-state", "current-dir", "git-branch", "tokens-io", "tokens-cache", "run-id", "selection"]
    ]);

    output.stdin.write("\u001b");
    await waitForFrame(output, /Statusline dialog dismissed/);
    await sendTuiLine(output, "/statusline");
    await waitForFrame(output, /Left\/right to reorder enabled items/);
    frame = output.lastFrame() ?? "";
    assert.ok(frame.indexOf("[\u2713] current-dir") < frame.indexOf("[ ] permission"));

    output.unmount();
    output.cleanup();
  });

  it("loads statusline settings and rolls back when the latest save fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={planProviderFactory}
        settings={{ statusLine: ["permission", "current-dir"] }}
        saveStatuslineElements={async () => { throw new Error("disk unavailable"); }}
      />
    );

    await sendTuiLine(output, "/statusline");
    await waitForFrame(output, /\[\u2713\] permission/);
    output.stdin.write(" ");
    await waitForFrame(output, /Failed to save statusline settings: disk unavailable/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /\[\u2713\] permission/);
    assert.match(frame.split("\n").filter((line) => line.includes(cwd)).at(-1) ?? "", /default \|/);

    output.unmount();
    output.cleanup();
  });

  it("serializes statusline saves and rolls back to the last successful configuration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const saved: string[][] = [];
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={planProviderFactory}
        settings={{ statusLine: ["permission"] }}
        saveStatuslineElements={async (elements) => {
          saved.push([...elements]);
          if (saved.length === 1) await firstSave;
          else throw new Error("second save failed");
        }}
      />
    );

    await sendTuiLine(output, "/statusline run-state");
    await sendTuiLine(output, "/statusline current-dir");
    assert.deepEqual(saved, [["run-state"]]);

    releaseFirst();
    await waitForFrame(output, /Failed to save statusline settings: second save failed/);

    assert.deepEqual(saved, [["run-state"], ["current-dir"]]);
    const statusLine = (output.lastFrame() ?? "").split("\n").filter((line) => line.trim() === "Ready").at(-1) ?? "";
    assert.match(statusLine, /Ready/);
    assert.doesNotMatch(statusLine, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    output.unmount();
    output.cleanup();
  });

  it("cycles between the default execution mode and Plan Mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /Permission mode: Plan Mode/);
    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /> Type a request or \/help/);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| plan \|/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Enabled plan mode/);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /Permission mode: Default/);
    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| default \|/);

    output.unmount();
    output.cleanup();
  });

  it("cycles back to full access when it is the default execution mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} settings={{ permissions: { defaultMode: "fullAccess" } }} />);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /Permission mode: Plan Mode/);
    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| plan \|/);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /Permission mode: Full access/);
    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| full access \|/);

    output.unmount();
    output.cleanup();
  });

  it("shows workflow activity status above the prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let resolveResult: ((value: ReturnType<typeof workflowState>) => void) | undefined;
    const result = new Promise<ReturnType<typeof workflowState>>((resolve) => {
      resolveResult = resolve;
    });
    const session = {
      runId: "run-status",
      state: workflowState("pending"),
      events: (async function* () {})(),
      permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
      interrupt: async () => undefined,
      resumeWithUserInput: async () => undefined,
      continueWithInput: async () => undefined,
      result
    };
    const engine = { async startInteractive() { return session; } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "Start a long task.");
    await waitForFrame(output, /- Working[.][.][.] [0-9]+s -+/);
    assert.match(output.lastFrame() ?? "", /> Type a request or \/help/);

    resolveResult?.(workflowState("completed"));
    await waitForFrame(output, /- Worked for [0-9]+s -+/);

    output.unmount();
    output.cleanup();
  });

  it("changes the default execution mode from /permissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/permissions");
    await waitForFrame(output, /Default execution mode/);
    const menu = output.lastFrame() ?? "";
    assert.match(menu, /Default/);
    assert.match(menu, /Full access/);
    assert.doesNotMatch(menu, /Accept Edits/);
    assert.doesNotMatch(menu, /Auto/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(String.fromCharCode(13));
    await waitForFrame(output, /Permission mode: Full access/);
    await sendTuiLine(output, "Start after permissions change.");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess" });

    output.unmount();
    output.cleanup();
  });

  it("uses the /permissions-selected full access mode after plan approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/permissions");
    await waitForFrame(output, /Default execution mode/);
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(String.fromCharCode(13));
    await waitForFrame(output, /Permission mode: Full access/);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    assert.match(output.lastFrame() ?? "", /Yes, and use full access/);

    output.stdin.write("\r");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess" });

    output.unmount();
    output.cleanup();
  });

  it("uses full access when /permissions changes the default during Plan Mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await waitForFrame(output, /Enabled plan mode/);
    await sendTuiLine(output, "/permissions");
    await waitForFrame(output, /Default execution mode/);
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(String.fromCharCode(13));
    await waitForFrame(output, /Permission mode: Full access/);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| plan \|/);

    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess" });

    output.unmount();
    output.cleanup();
  });

  it("cycles back to the /permissions-selected full access mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/permissions");
    await waitForFrame(output, /Default execution mode/);
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(String.fromCharCode(13));
    await waitForFrame(output, /Permission mode: Full access/);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /Permission mode: Plan Mode/);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| plan \|/);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /Permission mode: Full access/);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| full access \|/);

    await sendTuiLine(output, "Start after cycling permissions.");
    await settleTuiWork();
    assertStartOption(options[0], { permissionMode: "fullAccess" });

    output.unmount();
    output.cleanup();
  });

  it("starts ordinary workflow turns with the selected default execution mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} settings={{ permissions: { defaultMode: "fullAccess" } }} />);

    await sendTuiLine(output, "Start in full access.");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess" });

    output.unmount();
    output.cleanup();
  });

  it("prompts before entering Plan Mode from an EnterPlanMode workflow tool call", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-enter-plan-tool-");
    const planRequests: ModelRequest[] = [];
    let workflowTurns = 0;
    const workflowProvider: ModelProvider = {
      async generate(request) {
        if (request.context?.nodeId === "runtime") return planProvider(planRequests).generate(request);
        workflowTurns += 1;
        if (workflowTurns === 1) {
          return { content: "I should plan this first.", tool_calls: [{ id: "tool-enter-plan", name: "EnterPlanMode", input: {} }] };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "abandoned", document: "", handoff: {}, deliverables: [] }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => workflowProvider, cwd, runRoot: join(cwd, ".session") });
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine} providerFactory={() => workflowProvider} />);

    await sendTuiLine(output, "Build auth flow with sign-off.");
    await waitForFrame(output, /Enter plan mode\?/);
    assert.match(output.lastFrame() ?? "", /· Explore the codebase thoroughly/);
    assert.match(output.lastFrame() ?? "", /No code changes will be made until you approve the plan\./);
    assert.match(output.lastFrame() ?? "", /Yes, enter plan mode/);
    assert.match(output.lastFrame() ?? "", /No, start implementing now/);

    output.stdin.write("\r");
    await waitForFrame(output, /Build auth flow with sign-off\./);
    await waitForRequest(planRequests, "Build auth flow with sign-off.");

    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| plan \|/);

    output.unmount();
    output.cleanup();
  });

  it("continues workflow implementation when EnterPlanMode is declined", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-enter-plan-decline-");
    const planRequests: ModelRequest[] = [];
    let workflowTurns = 0;
    const workflowProvider: ModelProvider = {
      async generate(request) {
        if (request.context?.nodeId === "runtime") return planProvider(planRequests).generate(request);
        workflowTurns += 1;
        if (workflowTurns === 1) {
          return { content: "I should plan this first.", tool_calls: [{ id: "tool-enter-plan", name: "EnterPlanMode", input: {} }] };
        }
        assert.match(requestText(request), /Permission denied by user for EnterPlanMode/);
        return { content: JSON.stringify({ direction: "forward", summary: "Implemented directly", document: "", handoff: {}, deliverables: [] }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => workflowProvider, cwd, runRoot: join(cwd, ".session") });
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine} providerFactory={() => workflowProvider} />);

    await sendTuiLine(output, "Build auth flow without planning.");
    await waitForFrame(output, /Enter plan mode\?/);
    output.stdin.write("\u001b[B");
    await waitForFrame(output, /> 2\. No, start implementing now/);
    output.stdin.write("\r");
    await waitForFrame(output, /Implemented directly/);

    assert.equal(workflowTurns, 2);
    assert.equal(planRequests.length, 0);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Working) \| default \|/);

    output.unmount();
    output.cleanup();
  });

  it("enters Plan Mode before workflow execution and does not start workflow while drafting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /(?:Ready|Waiting|Thinking|Working) \| plan \|/);
    assert.match(output.lastFrame() ?? "", /Draft the migration first\./);
    assert.doesNotMatch(output.lastFrame() ?? "", /Plan draft updated/);

    output.unmount();
    output.cleanup();
  });

  it("records Plan Mode global prompt injection metadata without transcript prompt text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const projectPrompt = "Project AGENTS instructions.";
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const configWithGlobalPrompt = {
      ...config,
      global_prompt: projectPrompt,
      global_prompt_metadata: {
        sha256: "global-hash",
        chars: projectPrompt.length,
        lines: 1,
        sources: [{ kind: "project_agents" as const, path: join(cwd, ".einsteins", "AGENTS.md"), sha256: "source-hash", chars: projectPrompt.length, lines: 1 }]
      }
    };
    const output = render(<TuiApp cwd={cwd} config={configWithGlobalPrompt} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Check prompt metadata.");
    const request = await waitForRequest(requests, "Check prompt metadata.");
    const sessionId = request.context?.sessionId;
    assert.equal(typeof sessionId, "string");
    const store = new SessionStore(join(cwd, ".einsteins", "projects", "tui"));
    const metadata = await waitForPromptInjectionMetadata(store, sessionId as string);
    const transcript = await store.loadTranscript(sessionId as string);

    assert.equal(metadata.promptInjection?.globalPrompt?.presentInRequest, true);
    assert.equal(metadata.promptInjection?.globalPrompt?.injectedThisTurn, true);
    assert.equal(metadata.promptInjection?.globalPrompt?.sources?.[0]?.kind, "project_agents");
    assert.equal(JSON.stringify(metadata.promptInjection).includes(projectPrompt), false);
    assert.equal(JSON.stringify(transcript).includes(projectPrompt), false);

    output.unmount();
    output.cleanup();
  });

  it("shows a Plan Mode user message while the planning turn is still running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={hangingPlanProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration while provider is pending.");
    await waitForFrame(output, /Draft the migration while provider is pending\./);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);

    output.unmount();
    output.cleanup();
  });

  it("aborts an active Plan Mode turn on Escape and ignores late provider output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    let capturedSignal: AbortSignal | undefined;
    let resolveLate: ((value: { content: string }) => void) | undefined;
    const provider: ModelProvider = {
      async generate(request) {
        capturedSignal = request.signal;
        return new Promise((resolve, reject) => {
          resolveLate = resolve;
          request.signal?.addEventListener("abort", () => {
            const error = new Error("aborted by test");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      }
    };
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration while provider is pending.");
    await waitForFrame(output, /Draft the migration while provider is pending\./);
    for (let attempt = 0; attempt < 100 && !capturedSignal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(capturedSignal, "provider did not start before Escape");

    output.stdin.write("");
    await settleTerminalEscape();
    await waitForFrame(output, /Plan Mode interrupted; waiting for your input/);
    resolveLate?.({ content: "Late plan output must not render." });
    await settleTuiWork();

    assert.equal(starts, 0);
    assert.equal(capturedSignal?.aborted, true);
    assert.doesNotMatch(output.lastFrame() ?? "", /Late plan output must not render/);
    assert.match(output.lastFrame() ?? "", /> Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("shows queued Plan Mode user messages immediately while the previous turn is still running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={hangingPlanProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "First planning message is still running.");
    await waitForFrame(output, /First planning message is still running\./);

    await sendTuiLine(output, "Second planning message should still be visible.");
    await waitForFrame(output, /Second planning message should still be visible\./);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);

    output.unmount();
    output.cleanup();
  });

  it("renders each Plan Mode assistant response only once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const provider: ModelProvider = {
      async generate() {
        return { content: "Unique assistant response." };
      }
    };
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Show one assistant response.");
    await waitForFrame(output, /Unique assistant response\./);

    const frame = output.lastFrame() ?? "";
    assert.equal((frame.match(/Unique assistant response\./g) ?? []).length, 1);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("keeps earlier Plan Mode logs visible while waiting for approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const provider: ModelProvider = {
      async generate(request) {
        const last = request.messages.at(-1);
        if (last?.role === "tool") return { content: "First tool finished." };
        const text = requestText(request);
        if (/Ready for approval now/.test(text)) {
          return { content: "Requesting approval now.", tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: {} }] };
        }
        return {
          content: "First planning response stays visible.",
          tool_calls: [{ id: "tool-write-plan", name: "Write", input: { file_path: planFilePathFromRequest(request), content: "# Plan\n\nKeep earlier logs visible.\n" } }]
        };
      }
    };
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Start with an earlier plan log.");
    await waitForFrame(output, /First tool finished\./);
    await sendTuiLine(output, "Ready for approval now.");
    await waitForFrame(output, /Ready to code\?/);

    const expandedFrame = output.lastFrame() ?? "";
    assert.match(expandedFrame, /Waiting \| plan \|/);
    assert.match(expandedFrame, /Here is Einstein's plan:/);
    assert.match(expandedFrame, /Keep earlier logs visible\./);
    assert.doesNotMatch(expandedFrame, /First planning response stays visible\./);

    output.stdin.write("`");
    await settleTuiWork();
    const collapsedFrame = output.lastFrame() ?? "";
    assert.match(collapsedFrame, /First planning response stays visible\./);
    assert.match(collapsedFrame, /No, keep planning/);
    assert.match(collapsedFrame, /Here is Einstein's plan:/);

    output.stdin.write("`");
    await settleTuiWork();
    const restoredFrame = output.lastFrame() ?? "";
    assert.match(restoredFrame, /Here is Einstein's plan:/);
    assert.doesNotMatch(restoredFrame, /First planning response stays visible\./);

    output.stdin.write("·");
    await settleTuiWork();
    const chineseCollapsedFrame = output.lastFrame() ?? "";
    assert.match(chineseCollapsedFrame, /First planning response stays visible\./);
    assert.match(chineseCollapsedFrame, /Here is Einstein's plan:/);

    output.stdin.write("｀");
    await settleTuiWork();
    const chineseRestoredFrame = output.lastFrame() ?? "";
    assert.match(chineseRestoredFrame, /Here is Einstein's plan:/);
    assert.doesNotMatch(chineseRestoredFrame, /First planning response stays visible\./);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("shows Plan Mode thinking in the activity status instead of the log", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={hangingPlanProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Keep thinking in status.");
    await waitForFrame(output, /- Working[.][.][.] [0-9]+s \(Plan Mode is thinking\) -+/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Thinking \| plan \|/);
    assert.doesNotMatch(frame, /● Plan Mode is thinking/);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("accepts another prompt after a Plan Mode text turn completes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: `Plan response ${calls}.` };
      }
    };
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "First plan turn.");
    await waitForFrame(output, /Plan response 1\./);
    assert.match(output.lastFrame() ?? "", /Ready \| plan \|/);
    await sendTuiLine(output, "Second plan turn.");
    await waitForFrame(output, /Second plan turn\./);
    await waitForFrame(output, /Plan response 2\./);
    await waitForFrame(output, /- Worked for [0-9]+s -+/);

    assert.equal(starts, 0);
    assert.equal(calls, 2);
    assert.match(output.lastFrame() ?? "", /> Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("shows the Plan Mode Bash denial in the TUI without starting workflow execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 2) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          assert.match(String(request.messages.at(-1)?.content), /Permission denied for Bash: Plan Mode blocks shell execution/);
          return { content: "Planning without running tests." };
        }
        return { content: "Trying shell.", tool_calls: [{ id: "tool-bash-denied", name: "Bash", input: { command: "npm test", timeout_ms: 30000 } }] };
      }
    };
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Try to run tests while planning.");
    await waitForFrame(output, /Planning without running tests\./);

    const frame = output.lastFrame() ?? "";
    assert.equal(starts, 0);
    assert.equal(calls, 2);
    assert.match(frame, /Trying shell\./);
    assert.match(frame, /Planning without running tests\./);
    assert.match(frame, /Permission denied for Bash: Plan Mode blocks shell execution/);
    assert.match(frame, /> Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("continues planning after Edit targets a non-plan file in Plan Mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 2) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          assert.match(String(request.messages.at(-1)?.content), /Permission denied for Edit: Plan Mode writes are limited to the current plan file/);
          return {
            content: "Writing plan file.",
            tool_calls: [{ id: "tool-write-plan", name: "Write", input: { file_path: planFilePathFromRequest(request), content: "# Plan\n\nRemove edges node safely after approval.\n" } }]
          };
        }
        if (calls === 3) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          return {
            content: "Requesting plan approval.",
            tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: {} }]
          };
        }
        return {
          content: "Removing edges node.",
          tool_calls: [{
            id: "tool-edit-denied",
            name: "Edit",
            input: { file_path: "src/graph.ts", old_string: "edges", new_string: "" }
          }]
        };
      }
    };
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "移除edges节点");
    await waitForFrame(output, /Ready to code\?/);

    const frame = output.lastFrame() ?? "";
    assert.equal(starts, 0);
    assert.equal(calls, 3);
    assert.doesNotMatch(frame, /Permission denied for Edit: Plan Mode writes are limited to the current plan file/);
    assert.match(frame, /Remove edges node safely after approval/);

    output.unmount();
    output.cleanup();
  });

  it("runs /plan descriptions as the first planning turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan Draft from command arguments.");
    await waitForRequest(requests, "Draft from command arguments.");

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);

    output.unmount();
    output.cleanup();
  });

  it("treats /plan open outside Plan Mode as entering Plan Mode only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    let opened = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editPlanFile={async () => {
        opened += 1;
        return { content: null };
      }}
    />);

    await sendTuiLine(output, "/plan open");
    await waitForFrame(output, /Enabled plan mode/);

    assert.equal(starts, 0);
    assert.equal(opened, 0);
    assert.equal(requests.length, 0);
    assert.match(output.lastFrame() ?? "", /> Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("does not open an editor for /plan open before any plan is written", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let opened = 0;
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      editPlanFile={async () => {
        opened += 1;
        return { content: null };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "/plan open");
    await waitForFrame(output, /Already in plan mode\. No plan written yet\./);

    assert.equal(opened, 0);
    assert.match(output.lastFrame() ?? "", /> Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("opens the current Plan Mode plan with /plan open", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const editedFiles: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const previousEditor = process.env.EDITOR;
    const previousVisual = process.env.VISUAL;
    process.env.EDITOR = "code";
    delete process.env.VISUAL;
    let output: ReturnType<typeof render> | undefined;
    try {
      output = render(<TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={planProviderFactory}
        editPlanFile={async (filePath) => {
          editedFiles.push(filePath);
          return { content: await readPlan(filePath) ?? null };
        }}
      />);

      await sendTuiLine(output, "/plan");
      await sendTuiLine(output, "Draft opened from command.");
      await waitForFrame(output, /Ran Write/);
      await sendTuiLine(output, "/plan");
      await waitForFrame(output, /Current Plan/);
      const currentPlanFrame = output.lastFrame() ?? "";
      assert.match(currentPlanFrame, /Draft opened from command\./);
      assert.match(currentPlanFrame.replace(/\s+/g, ""), /[.]einsteins[\\/]projects[\\/].+[\\/]plans[\\/]plan[.]md/);
      await sendTuiLine(output, "/plan open");
      for (let index = 0; index < 20 && editedFiles.length === 0; index += 1) await settleTuiWork();

      assert.equal(editedFiles.length, 1);
      assert.match(editedFiles[0] ?? "", /[.]einsteins[\\/]projects[\\/].+[\\/]plans[\\/]plan[.]md$/);
    } finally {
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
      output?.unmount();
      output?.cleanup();
    }
  });

  it("sends pasted image file attachments in ordinary Plan Mode messages", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-plan-prompt-image-");
    const imagePath = join(cwd, "prompt-feedback.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    output.stdin.write(`\u001b[200~Use this screenshot\n"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const imageRequest = await waitForImageFeedbackRequest(requests);
    const imageMessage = imageRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.equal(starts, 0);
    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[0] : undefined, { type: "text", text: "Use this screenshot" });
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("requests plan approval through ExitPlanMode and starts workflow only after approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown, option: unknown) { inputs.push(input); options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    assert.equal(inputs.length, 0);
    assert.match(output.lastFrame() ?? "", /Here is Einstein's plan:/);
    assert.match(output.lastFrame() ?? "", /Plan saved to:/);
    assert.match(output.lastFrame() ?? "", /Draft the migration first\./);
    output.stdin.write("\r");
    await settleTuiWork();

    assert.equal(inputs.length, 1);
    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first."
    });
    assertStartOption(options[0], { permissionMode: "default" });

    output.unmount();
    output.cleanup();
  });

  it("starts the selected workflow after approving a plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, workflow: string, input: unknown) { inputs.push({ workflow, input }); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\r");
    await settleTuiWork();

    assert.equal(inputs.length, 1);
    assert.equal((inputs[0] as { workflow: string }).workflow, "delivery");
    assertApprovedPlanHandoff((inputs[0] as { input: unknown }).input, {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first."
    });
    assert.doesNotMatch(output.lastFrame() ?? "", /Select workflow from the bottom interaction area/);

    output.unmount();
    output.cleanup();
  });

  it("shows the clear-context approval option when the Plan Mode setting is enabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    assert.match(output.lastFrame() ?? "", /Yes, clear context/);
    output.stdin.write("\r");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "default", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("shows context usage on clear-context Plan approval when model usage and context window are known", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={configWithContextWindow}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={usagePlanProviderFactory}
      settings={{ showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    assert.match(output.lastFrame() ?? "", /Yes, clear context \(25% used\)/);

    output.unmount();
    output.cleanup();
  });

  it("uses full-access approval options when Plan Mode was entered from full access", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "fullAccess" }, showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Yes, clear context and use full access/);
    assert.match(frame, /Yes, and use full access/);
    output.stdin.write("\r");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("uses full-access approval options when Plan Mode was entered from full access mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "fullAccess" }, showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Yes, clear context and use full access/);
    assert.match(frame, /Yes, and use full access/);
    output.stdin.write("\r");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("injects only Plan Mode instructions during Plan Mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { throw new Error("workflow must not start before approval"); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      settings={{ permissions: { defaultMode: "fullAccess" } }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    const request = await waitForRequest(requests, "Draft the migration first.");
    const text = requestText(request);

    assert.match(text, /ATTACHMENT plan_mode/);
    assert.doesNotMatch(text, /ATTACHMENT auto_mode/);

    output.unmount();
    output.cleanup();
  });

  it("approves a non-empty full-access plan on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "fullAccess" } }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess" });

    output.unmount();
    output.cleanup();
  });

  it("approves a non-empty full-access plan with clear context on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "fullAccess" }, showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "fullAccess", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("shows ExitPlanMode requested permissions and preserves them in the approved handoff", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready with permissions.");
    await waitForFrame(output, /Ready to code\?/);

    assert.equal(inputs.length, 0);
    assert.match(output.lastFrame() ?? "", /Requested permissions:/);
    assert.match(output.lastFrame() ?? "", /Bash\(prompt: run tests\)/);

    output.stdin.write("\r");
    await waitForArrayItem(inputs, 0);

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first.",
      plan_requested_permissions: [{ tool: "Bash", prompt: "run tests" }]
    });

    output.unmount();
    output.cleanup();
  });

  it("keeps Plan Mode logs visible after approved plan starts workflow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = {
      async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) {
        options.push(option);
        return fakeSession([
          { type: "run_started", workflow_id: "delivery", input: { request: "workflow from approved plan" }, ts: "2026-07-04T00:00:00.000Z", seq: 1 }
        ]);
      }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/statusline run-state,permission,workflow");
    await waitForFrame(output, /Statusline updated/);
    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\r");
    await waitForFrame(output, /workflow from approved plan/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Draft the migration first\./);
    assert.match(frame, /workflow from approved plan/);
    const statusLine = frame.split("\n").filter((line) => line.trim()).at(-1) ?? "";
    assert.match(statusLine, /(?:Working|Ready) \| default \| delivery/);
    assert.doesNotMatch(statusLine, /work-mode|run-state|permission|workflow/);
    assertStartOption(options[0], { permissionMode: "default" });

    output.unmount();
    output.cleanup();
  });

  it("opens the pending approval plan with Ctrl+G before approving", async (t) => {
    const previousEditor = process.env.EDITOR;
    const previousVisual = process.env.VISUAL;
    process.env.EDITOR = "code";
    process.env.VISUAL = "";
    t.after(() => {
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
    });
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const requests: ModelRequest[] = [];
    const editedFiles: string[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editPlanFile={async (filePath) => {
        editedFiles.push(filePath);
        await writePlan(filePath, "Edited migration plan from editor.\n");
        return { content: "Edited migration plan from editor.\n" };
      }}
      planSavedMessageDurationMs={500}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    const draftRequest = await waitForRequest(requests, "Draft the migration first.");
    const planFilePath = planFilePathFromRequest(draftRequest);
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    assert.match(output.lastFrame() ?? "", /Here is Einstein's plan:/);
    assert.match(output.lastFrame() ?? "", /ctrl-g to edit in VS Code/);
    assertFrameIncludesPath(output.lastFrame() ?? "", relative(cwd, planFilePath));

    output.stdin.write("\u0007");
    await waitForFrame(output, /Plan saved!/);
    await waitForPlanSavedMessageToHide();
    assert.doesNotMatch(output.lastFrame() ?? "", /Plan saved!/);

    output.stdin.write("\r");
    await settleTuiWork();

    assert.deepEqual(editedFiles, [planFilePath]);
    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Edited migration plan from editor.",
      plan_file_path: planFilePath
    });

    output.unmount();
    output.cleanup();
  });

  it("approves a non-empty plan with default permissions on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    assert.equal(options.length, 0);

    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assertStartOption(options[0], { permissionMode: "default" });

    output.unmount();
    output.cleanup();
  });

  it("approves a plan with typed approval feedback on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown, option: unknown) { inputs.push(input); options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("Also update the README.");
    await settleTuiWork();
    assert.match(output.lastFrame() ?? "", /No, keep planning: Also update the README\./);
    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first.",
      plan_approval_feedback: "Also update the README."
    });
    assertStartOption(options[0], { permissionMode: "default" });

    output.unmount();
    output.cleanup();
  });

  it("preserves typed approval feedback when approving from a Yes option", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown, option: unknown) { inputs.push(input); options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("Also update the README.");
    await settleTuiWork();
    output.stdin.write("\u001b[A");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first.",
      plan_approval_feedback: "Also update the README."
    });
    assertStartOption(options[0], { permissionMode: "default" });

    output.unmount();
    output.cleanup();
  });

  it("does not carry image-only approval feedback when approving from a Yes option", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[200~data:image/png;base64,iVBORw0KGgo=\u001b[201~");
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\u001b[A");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first."
    });

    output.unmount();
    output.cleanup();
  });

  it("re-enters Plan Mode with the previous approved plan file and re-entry guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    assert.equal(inputs.length, 1);

    await sendTuiLine(output, "/plan Revisit the same task.");
    const reentryRequest = await waitForRequest(requests, "Revisit the same task.");
    const text = requestText(reentryRequest);

    assert.match(text, /ATTACHMENT plan_mode_reentry/);
    assert.match(text, /## Re-entering Plan Mode/);
    assert.match(text, /previously exited it/);
    assert.match(text, /ATTACHMENT plan_mode/);
    assert.doesNotMatch(text, /Current draft:/);
    assert.doesNotMatch(text, /Draft the migration first\./);

    output.unmount();
    output.cleanup();
  });

  it("requires a written plan before ExitPlanMode can request approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        const planFilePath = planFilePathFromRequest(request);
        if (calls === 1) return { content: "Requesting empty exit.", tool_calls: [{ id: "tool-empty-exit", name: "ExitPlanMode", input: {} }] };
        if (calls === 2) {
          assert.match(String(request.messages.at(-1)?.content), /Please write your plan to this file before calling ExitPlanMode/);
          return { content: "Writing missing plan.", tool_calls: [{ id: "tool-write-plan", name: "Write", input: { file_path: planFilePath, content: "# Plan\n\nRemove edges after approval.\n" } }] };
        }
        return { content: "Requesting approval.", tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: {} }] };
      }
    };
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Ready empty exit.");
    await waitForFrame(output, /Ready to code\?/);

    assert.equal(inputs.length, 0);
    assert.match(output.lastFrame() ?? "", /Remove edges after approval/);

    output.stdin.write("\r");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], { original_input: { request: "Ready empty exit." }, approved_plan: "# Plan\n\nRemove edges after approval." });

    output.unmount();
    output.cleanup();
  });

  it("keeps planning when an empty ExitPlanMode is blocked and the model only writes a draft", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    let calls = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        const planFilePath = planFilePathFromRequest(request);
        if (calls === 1) return { content: "Requesting empty exit.", tool_calls: [{ id: "tool-empty-exit", name: "ExitPlanMode", input: {} }] };
        if (calls === 2) return { content: "Writing missing plan.", tool_calls: [{ id: "tool-write-plan", name: "Write", input: { file_path: planFilePath, content: "# Plan\n\nStay in planning.\n" } }] };
        return { content: "Plan draft saved." };
      }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Ready empty exit.");
    await waitForFrame(output, /Plan draft saved\./);

    const frame = output.lastFrame() ?? "";
    assert.equal(starts, 0);
    assert.equal(calls, 3);
    assert.doesNotMatch(frame, /Exit plan mode\?/);
    assert.match(frame, /(?:Ready|Waiting|Thinking|Working) \| plan \|/);

    output.unmount();
    output.cleanup();
  });

  it("continues Plan Mode after answering AskUserQuestion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Staged/);

    assert.equal(starts, 0);
    assert.ok(answerRequest.messages.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.name === "AskUserQuestion")));
    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content))));
    await waitForFrame(output, /Planning staged rollout/);

    output.unmount();
    output.cleanup();
  });

  it("keeps single AskUserQuestion questions out of the submit tab flow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);

    output.stdin.write("\t");
    await settleTuiWork();
    assert.doesNotMatch(output.lastFrame() ?? "", /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Staged/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("lets the user chat about an AskUserQuestion directly from the question page", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);
    assert.match(output.lastFrame() ?? "", /Chat about this/);
    assert.doesNotMatch(output.lastFrame() ?? "", /3\. Chat about this/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Skip interview/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Planning:/);

    for (let index = 0; index < 2; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /The user wants to clarify these questions/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Start by asking them what they would like to clarify/);
    assert.match(answerText, /Which rollout path\?/);

    output.unmount();
    output.cleanup();
  });

  it("lets the user skip the AskUserQuestion interview directly from the question page", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);
    assert.match(output.lastFrame() ?? "", /Skip interview and plan/);
    assert.match(output.lastFrame() ?? "", /immediately/);

    for (let index = 0; index < 3; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /provided enough answers for the plan interview/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Stop asking clarifying questions/);
    assert.match(answerText, /Which rollout path\?/);

    output.unmount();
    output.cleanup();
  });

  it("rejects AskUserQuestion on Escape and continues Plan Mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);

    output.stdin.write("\u001b");
    const rejectionRequest = await waitForToolAnswerRequest(requests, /doesn't want to proceed with this tool use/);

    assert.equal(starts, 0);
    assert.match(requestText(rejectionRequest), /"rejected":true/);
    await waitForFrame(output, /Planning without that answer\./);

    output.unmount();
    output.cleanup();
  });

  it("collects multiple AskUserQuestion questions before returning answers to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content)))), false);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Submit answers/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Which verification steps/.test(String(message.content)))), false);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Which verification steps/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /User has answered your questions:/);
    assert.match(answerText, /"Which rollout path\?"="Staged"/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests"/);
    assert.match(answerText, /You can now continue with the user's answers in mind\./);
    await waitForFrame(output, /> Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("shows tui-code style AskUserQuestion submit review actions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Ready to submit your answers\?/);
    assert.match(output.lastFrame() ?? "", /Submit answers/);
    assert.match(output.lastFrame() ?? "", /Cancel/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Respond to Einstein/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Finish plan interview/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Back to questions/);

    output.unmount();
    output.cleanup();
  });

  it("warns when AskUserQuestion submit review has unanswered questions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\t");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    output.stdin.write("\t");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);

    assert.match(output.lastFrame() ?? "", /You have not answered all questions/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /User has answered your questions/.test(String(message.content)))), false);

    output.unmount();
    output.cleanup();
  });

  it("cancels the Plan Mode AskUserQuestion interview from review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Cancel/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /doesn't want to proceed with this tool use/);
    const answerText = requestText(feedbackRequest);

    assert.match(answerText, /"rejected":true/);
    assert.doesNotMatch(answerText, /Which rollout path\?=/);

    output.unmount();
    output.cleanup();
  });

  it("returns to a previous AskUserQuestion before submitting multi-question answers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /Previous question/);

    for (let index = 0; index < 3; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content)))), false);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Which verification steps/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /"Which rollout path\?"="Big bang"/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests"/);

    output.unmount();
    output.cleanup();
  });

  it("navigates multi-question AskUserQuestion tabs without submitting answers early", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);
    assert.match(output.lastFrame() ?? "", /☐ Rollout/);
    assert.match(output.lastFrame() ?? "", /☐ Verify/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /☒ Rollout/);
    assert.match(output.lastFrame() ?? "", /☐ Verify/);

    output.stdin.write("\t");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /✓ Submit/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Which rollout path/.test(String(message.content)))), false);

    output.stdin.write("\u001b[D");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Which verification steps/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /"Which rollout path\?"="Staged"/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests"/);

    output.unmount();
    output.cleanup();
  });

  it("returns freeform AskUserQuestion answers as the Other option", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need freeform choice.");
    await waitForFrame(output, /Deployment window\?/);

    assert.match(output.lastFrame() ?? "", /Other/);
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("Saturday night");
    await waitForFrame(output, /Other, Saturday night/);
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Saturday night/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Saturday night/);
    assert.match(answerText, /"Deployment window\?"="Saturday night"/);
    assert.doesNotMatch(answerText, /"question_id"/);
    assert.doesNotMatch(answerText, /"option_value"/);

    output.unmount();
    output.cleanup();
  });

  it("edits AskUserQuestion Other input with Ctrl+G before submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const editedInputs: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editQuestionText={(text) => {
        editedInputs.push(text);
        return { content: "Saturday night" };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need freeform choice.");
    await waitForFrame(output, /Deployment window\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u0007");
    await waitForFrame(output, /Saturday night/);
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Saturday night/);

    assert.deepEqual(editedInputs, [""]);
    assert.match(requestText(answerRequest), /"Deployment window\?"="Saturday night"/);

    output.unmount();
    output.cleanup();
  });

  it("returns AskUserQuestion image attachments with Other answers", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-question-image-");
    const imagePath = join(cwd, "question-feedback.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need freeform choice.");
    await waitForFrame(output, /Deployment window\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(`\u001b[200~"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const answerRequest = await waitForImageFeedbackRequest(requests);
    const answerText = requestText(answerRequest);
    const imageMessage = answerRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.match(answerText, /\(Image attached\)/);
    assert.match(answerText, /"Deployment window\?"="\(Image attached\)"/);
    assert.doesNotMatch(answerText, /"question_id"/);
    assert.doesNotMatch(answerText, /"option_value"/);
    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("returns selected AskUserQuestion preview content to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Phase 1/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content)) && /Phase 1/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("focuses AskUserQuestion preview options with number keys without submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("2");
    await settleTuiWork();
    await waitForFrame(output, /All users/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Big bang/.test(String(message.content)))), false);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /All users/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Big bang/.test(String(message.content)) && /All users/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("returns AskUserQuestion preview notes to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);
    assert.match(output.lastFrame() ?? "", /press n to add notes/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    await waitForFrame(output, /All users/);
    output.stdin.write("n");
    await settleTuiWork();
    await waitForFrame(output, /Add notes on this design/);
    await sendTuiLine(output, "Only if rollback is instant.");
    const answerRequest = await waitForToolAnswerRequest(requests, /rollback is instant/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Big bang/);
    assert.match(answerText, /All users/);
    assert.match(answerText, /rollback is instant/);
    assert.match(answerText, /"Which rollout path\?"="Big bang"/);
    assert.match(answerText, /selected preview:\nAll users/);
    assert.match(answerText, /user notes: Only if rollback is instant\./);

    output.unmount();
    output.cleanup();
  });

  it("edits AskUserQuestion preview notes with Ctrl+G before submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const editedInputs: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editQuestionText={(text) => {
        editedInputs.push(text);
        return { content: "Edited notes from external editor." };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    await waitForFrame(output, /All users/);
    output.stdin.write("n");
    await settleTuiWork();
    await waitForFrame(output, /Add notes on this design/);
    output.stdin.write("\u0007");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Edited notes from external editor/);
    const answerText = requestText(answerRequest);

    assert.deepEqual(editedInputs, [""]);
    assert.match(answerText, /Big bang/);
    assert.match(answerText, /All users/);
    assert.match(answerText, /Edited notes from external editor/);
    assert.match(answerText, /"Which rollout path\?"="Big bang"/);
    assert.match(answerText, /selected preview:\nAll users/);
    assert.match(answerText, /user notes: Edited notes from external editor\./);

    output.unmount();
    output.cleanup();
  });

  it("returns multiple AskUserQuestion selections to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);
    const questionFrame = output.lastFrame() ?? "";
    assert.match(questionFrame, /Planning:/);
    assert.match(questionFrame, /\.einsteins/);
    const planningLine = questionFrame.split(/\r?\n/).find((line) => line.includes("Planning:")) ?? "";
    assert.equal(planningLine.includes(cwd), false);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Unit tests/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Unit tests/.test(String(message.content)) && /Manual smoke/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("lets the user chat about a multi-select AskUserQuestion directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /Chat about this/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Done/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Submit/);
    assert.match(output.lastFrame() ?? "", /Submit/);
    assert.match(output.lastFrame() ?? "", /4\. Chat about this/);
    assert.match(output.lastFrame() ?? "", /5\. Skip interview and plan immediately/);
    assert.doesNotMatch(output.lastFrame() ?? "", /\[ \] Chat about this/);

    for (let index = 0; index < 4; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /The user wants to clarify these questions/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Start by asking them what they would like to clarify/);
    assert.match(answerText, /Which verification steps\?/);
    assert.doesNotMatch(answerText, /option_values/);

    output.unmount();
    output.cleanup();
  });

  it("lets the user skip a multi-select AskUserQuestion interview directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /Skip interview and plan/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Done/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Submit/);
    assert.match(output.lastFrame() ?? "", /Submit/);
    assert.match(output.lastFrame() ?? "", /4\. Chat about this/);
    assert.match(output.lastFrame() ?? "", /5\. Skip interview and plan immediately/);
    assert.doesNotMatch(output.lastFrame() ?? "", /\[ \] Skip interview/);

    for (let index = 0; index < 5; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /provided enough answers for the plan interview/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Stop asking clarifying questions/);
    assert.match(answerText, /Which verification steps\?/);
    assert.doesNotMatch(answerText, /option_values/);

    output.unmount();
    output.cleanup();
  });

  it("returns multi-select AskUserQuestion Other input to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("Accessibility pass");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Accessibility pass/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Unit tests/);
    assert.match(answerText, /Accessibility pass/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests, Accessibility pass"/);
    assert.doesNotMatch(answerText, /"option_values"/);

    output.unmount();
    output.cleanup();
  });

  it("edits multi-select AskUserQuestion Other input with Ctrl+G before submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const editedInputs: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editQuestionText={(text) => {
        editedInputs.push(text);
        return { content: "Accessibility pass" };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u0007");
    await waitForFrame(output, /Accessibility pass/);
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Accessibility pass/);

    assert.deepEqual(editedInputs, [""]);
    assert.match(requestText(answerRequest), /"Which verification steps\?"="Unit tests, Accessibility pass"/);

    output.unmount();
    output.cleanup();
  });

  it("returns multi-select AskUserQuestion image attachments with Other input", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-question-multi-image-");
    const imagePath = join(cwd, "verification-feedback.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(`\u001b[200~"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");

    const answerRequest = await waitForImageFeedbackRequest(requests);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Unit tests/);
    assert.match(answerText, /\(Image attached\)/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests, \(Image attached\)"/);
    assert.doesNotMatch(answerText, /"option_values"/);
    assert.ok(answerRequest.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")));

    output.unmount();
    output.cleanup();
  });

  it("keeps planning with typed feedback from the plan approval input", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    const approvalFrame = output.lastFrame() ?? "";
    assert.match(approvalFrame, /Tell Einstein what to change/);
    assert.match(approvalFrame, /shift\+tab to approve with this feedback/);
    assert.doesNotMatch(approvalFrame, /> Type a request or \/help/);

    const feedback = "Split the migration into two smaller phases.";
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(feedback);
    await waitForFrame(output, /No, keep planning: Split the migration into two smaller phases\./);
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForRequestContaining(requests, /Split the migration into two smaller phases\./);
    const feedbackRequestText = requestText(feedbackRequest);
    await waitForFrame(output, /Plan Review \(needs revision\)/);
    const frame = output.lastFrame() ?? "";

    assert.equal(starts, 0);
    assert.match(frame, /Plan Mode/);
    assert.match(frame, /> Type a request or \/help/);
    assert.doesNotMatch(frame, /Type a request or \/help[^\n]*smaller phases/);
    assert.doesNotMatch(frame, /Ctrl\+C stop[^\n]*smaller phases/);
    assert.match(feedbackRequestText, /The agent proposed a plan that was rejected by the user/);
    assert.match(feedbackRequestText, /Rejected plan:/);
    assert.match(feedbackRequestText, /Draft the migration first\./);
    assert.match(feedbackRequestText, /User feedback:/);
    assert.match(feedbackRequestText, /Split the migration into two smaller phases\./);

    output.unmount();
    output.cleanup();
  });

  it("keeps the plan approval open when No is submitted without feedback", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    const requestCount = requests.length;

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    const frame = output.lastFrame() ?? "";
    assert.equal(starts, 0);
    assert.equal(requests.length, requestCount);
    assert.match(frame, /Ready to code\?/);
    assert.doesNotMatch(frame, /> Type a request or \/help/);
    assert.match(frame, /No, keep planning/);
    assert.match(frame, /Tell Einstein what to change/);
    assert.doesNotMatch(frame, /needs revision/);

    output.unmount();
    output.cleanup();
  });

  it("preserves image feedback when rejecting a plan approval", () => {
    const message = planRejectionMessage("Update auth flow.", {
      answer: "Use this diagram.",
      contentBlocks: [{
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo="
        }
      }]
    });

    assert.equal(message.role, "user");
    assert.ok(Array.isArray(message.content));
    assert.match(message.content[0].type === "text" ? message.content[0].text : "", /Use this diagram/);
    assert.deepEqual(message.content[1], { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });
  });

  it("keeps planning with pasted image feedback during plan approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[200~Use this screenshot data:image/png;base64,iVBORw0KGgo=\u001b[201~");
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const feedbackRequest = await waitForImageFeedbackRequest(requests);
    const imageMessage = feedbackRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("keeps planning with pasted image file feedback during plan approval", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-plan-image-path-");
    const imagePath = join(cwd, "Screenshot Path.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(`\u001b[200~"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const feedbackRequest = await waitForImageFeedbackRequest(requests);
    const imageMessage = feedbackRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("keeps Plan Mode draft across /clear", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { throw new Error("workflow must not start before approval"); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Keep this draft.");
    await sendTuiLine(output, "/clear");
    await sendTuiLine(output, "/plan");

    await waitForFrame(output, /Current Plan/);
    assert.match(output.lastFrame() ?? "", /Keep this draft/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Ready to code\?/);

    output.unmount();
    output.cleanup();
  });


  it("renders long Plan approval documents in the approval dialog with choices visible", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-long-plan", cwd);
    const longPlan = Array.from({ length: 80 }, (_, index) => `Step ${String(index + 1).padStart(2, "0")}: verify the migration guardrail before executing.`).join(String.fromCharCode(10));
    await writePlan(planFilePath, `${longPlan}${String.fromCharCode(10)}`);
    await new SessionStore(join(cwd, ".einsteins", "projects", "tui")).savePlanState("session-long-plan", {
      mode: "waiting_approval",
      sessionId: "session-long-plan",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume long plan" }
    });
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { throw new Error("workflow must not start before approval"); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { value: 48, configurable: true });
    t.after(() => {
      if (stdoutRows) Object.defineProperty(process.stdout, "rows", stdoutRows);
      else Reflect.deleteProperty(process.stdout, "rows");
    });
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write(String.fromCharCode(13));
    await settleTuiWork();
    await waitForFrame(output, /Ready to code\?/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Here is Einstein's plan:/);
    assert.match(frame, /Step 01: verify the migration guardrail before executing\./);
    assert.match(frame, /Lines 1-\d+\/80/);
    assert.match(frame, /Step 19: verify the migration guardrail before executing\./);
    assert.match(frame, /Step 20: verify the migration guardrail before executing\./);
    assert.match(frame, /Einstein has written up a plan and is ready to execute/);
    assert.match(frame, /Yes, continue/);
    assert.doesNotMatch(frame, /manually approve edits/);
    assert.doesNotMatch(frame, /Yes, bypass permissions/);
    assert.match(frame, /No, keep planning/);

    output.unmount();
    output.cleanup();
  });


  it("sorts mixed resume entries by recent activity and timestamps session and run labels", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const store = new SessionStore(join(cwd, ".einsteins", "projects", "tui"));
    await store.savePlanState("session-planning", {
      mode: "planning",
      sessionId: "session-planning",
      planFilePath: getPlanFilePath("session-planning", cwd),
      prePlanMode: "default",
      originalInput: { request: "session request" }
    });
    const engine = {
      async listRuns() {
        return [{ runId: "run-future", workflowId: "delivery", status: "completed", updatedAt: "2099-12-31T23:59:00", inputPreview: "orphan request" }];
      }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /> 1\. 12-31 23:59 delivery completed orphan request/);
    assert.match(frame, /2\. \d{2}-\d{2} \d{2}:\d{2} session planning session request/);

    output.unmount();
    output.cleanup();
  });

  it("restores waiting Plan Mode sessions from /resume without starting workflow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-plan", cwd);
    await writePlan(planFilePath, "Saved plan.\n");
    const store = new SessionStore(join(cwd, ".einsteins", "projects", "tui"));
    await store.savePlanState("session-plan", {
      mode: "waiting_approval",
      sessionId: "session-plan",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume this" }
    });
    await store.recordModelResponse("session-plan", { inputTokens: 15_000, cachedInputTokens: 3_000, outputTokens: 300, totalTokens: 15_300 });
    let starts = 0;
    let resumes = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { resumes += 1; return fakeSession(); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    assert.match(output.lastFrame() ?? "", /\d{2}-\d{2} \d{2}:\d{2} session waiting_approval Resume this/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Ready to code\?/);
    assert.equal(starts, 0);
    assert.equal(resumes, 0);
    assert.match(output.lastFrame() ?? "", /tokens 15K\/300 \|\s+cache 3K \(20%\)/);

    output.unmount();
    output.cleanup();
  });

  it("recovers missing waiting Plan Mode plan files from the transcript on /resume", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-plan-recover", cwd);
    const store = new SessionStore(join(cwd, ".einsteins", "projects", "tui"));
    await store.savePlanState("session-plan-recover", {
      mode: "waiting_approval",
      sessionId: "session-plan-recover",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Recover this plan" }
    });
    await store.appendTranscript("session-plan-recover", {
      role: "assistant",
      content: "Writing the plan.",
      tool_calls: [{ id: "write-plan", name: "Write", input: { file_path: planFilePath, content: "# Recovered Plan\n\nUse transcript.\n" } }]
    });
    let starts = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Ready to code\?/);
    assert.match(output.lastFrame() ?? "", /Einstein has written up a plan and is ready to execute/);
    assert.doesNotMatch(output.lastFrame() ?? "", /without a written plan/);
    assert.equal(await readPlan(planFilePath), "# Recovered Plan\n\nUse transcript.\n");
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("recovers missing Plan Mode metadata as planning when no ExitPlanMode was recorded", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const sessionId = "session-missing-plan-metadata";
    const store = new SessionStore(join(cwd, ".einsteins", "projects", "tui"));
    const planFilePath = join(store.sessionDir(sessionId), "plans", "plan.md");
    await writePlan(planFilePath, "# Plan\n\nKeep planning before approval.\n");
    await store.appendTranscript(sessionId, { role: "user", content: "Recover metadata" });
    await store.appendTranscript(sessionId, { role: "assistant", content: "Plan draft saved." });
    let starts = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Plan Mode restored/);
    assert.match(output.lastFrame() ?? "", /Plan draft saved\./);
    assert.doesNotMatch(output.lastFrame() ?? "", /Ready to code\?/);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("restores Plan Mode transcript messages into the TUI log", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-planning-transcript", cwd);
    const store = new SessionStore(join(cwd, ".einsteins", "projects", "tui"));
    await store.savePlanState("session-planning-transcript", {
      mode: "planning",
      sessionId: "session-planning-transcript",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume this planning session" }
    });
    await store.appendTranscript("session-planning-transcript", { role: "user", content: "Previously sent in Plan Mode." });
    await store.appendTranscript("session-planning-transcript", { role: "user", content: "Internal compact summary must stay hidden.", metadata: { compactSummary: true } });
    await store.appendTranscript("session-planning-transcript", { role: "assistant", content: "Previously acknowledged." });
    await store.appendWorkflowTranscriptEntries("session-planning-transcript", [{
      message: { role: "assistant", content: "Workflow-only transcript entry." },
      runId: "run-workflow",
      entryId: "workflow:run-workflow:node:dev:attempt:1:message:0"
    }]);
    let starts = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Previously sent in Plan Mode\./);
    assert.match(output.lastFrame() ?? "", /Previously acknowledged\./);
    assert.doesNotMatch(output.lastFrame() ?? "", /Internal compact summary must stay hidden\./);
    assert.doesNotMatch(output.lastFrame() ?? "", /Workflow-only transcript entry\./);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("restores empty waiting Plan Mode sessions back into planning", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-empty-plan", cwd);
    await new SessionStore(join(cwd, ".einsteins", "projects", "tui")).savePlanState("session-empty-plan", {
      mode: "waiting_approval",
      sessionId: "session-empty-plan",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume empty plan" }
    });
    let starts = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/statusline permission");
    await waitForFrame(output, /Statusline updated/);
    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Plan file is empty; keep planning/);
    const frame = output.lastFrame() ?? "";
    assert.doesNotMatch(frame, /Exit plan mode\?/);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });
});

function workflowState(status: "pending" | "completed") {
  return { status, workflow_id: "delivery", attempts: [], handoff: undefined };
}

function fakeSession(events: unknown[] = []) {
  const state = { status: "completed" as const, workflow_id: "delivery", attempts: [], handoff: undefined };
  return {
    runId: "run-approved-plan",
    state,
    events: (async function* () {
      for (const event of events) yield event;
    })(),
    permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
    interrupt: async () => undefined,
    resumeWithUserInput: async () => undefined,
    continueWithInput: async () => undefined,
    result: Promise.resolve(state)
  };
}

function planProviderFactory(): ModelProvider {
  return planProvider();
}

function usagePlanProviderFactory(): ModelProvider {
  const provider = planProvider();
  return {
    async generate(request) {
      const response = await provider.generate(request);
      return { ...response, usage: { inputTokens: 32000, outputTokens: 1000, totalTokens: 33000 } };
    }
  };
}

function recordingPlanProviderFactory(requests: ModelRequest[]): () => ModelProvider {
  return () => planProvider(requests);
}


function hangingPlanProviderFactory(): ModelProvider {
  return {
    async generate() {
      return new Promise(() => undefined);
    }
  };
}

function planProvider(requests?: ModelRequest[]): ModelProvider {
  return {
    async generate(request: ModelRequest) {
      requests?.push(request);
      const last = request.messages.at(-1);
      if (last?.role === "tool" && /Which verification steps/.test(String(last.content))) return { content: "Planning multi-question answer." };
      if (last?.role === "tool" && /Staged/.test(String(last.content))) return { content: "Planning staged rollout." };
      if (last?.role === "tool" && /Unit tests/.test(String(last.content))) return { content: "Planning selected verification." };
      if (last?.role === "tool" && /Saturday night/.test(String(last.content))) return { content: "Planning Saturday rollout." };
      if (last?.role === "tool" && /Accessibility pass/.test(String(last.content))) return { content: "Planning extra verification." };
      if (last?.role === "tool" && /staged rollout/.test(String(last.content))) return { content: "Planning staged rollout." };
      if (last?.role === "tool" && /doesn't want to proceed with this tool use/.test(String(last.content))) return { content: "Planning without that answer." };
      if (last?.role === "tool") return { content: "Plan draft saved." };
      const planFilePath = planFilePathFromRequest(request);
      const userText = [...request.messages].reverse().find((message) => message.role === "user" && typeof message.content === "string" && !message.content.includes("ATTACHMENT plan_mode"))?.content;
      if (typeof userText === "string" && userText.includes("Need clarification")) {
        return {
          content: "Need clarification.",
          tool_calls: [{
            id: "tool-question",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which rollout path?",
                header: "Rollout",
                options: [
                  { label: "Staged", description: "Release gradually", preview: "Phase 1\nPhase 2" },
                  { label: "Big bang", description: "Release all at once", preview: "All users" }
                ]
              }]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Need two questions")) {
        return {
          content: "Need two answers.",
          tool_calls: [{
            id: "tool-question-two",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which rollout path?",
                  header: "Rollout",
                  options: [
                    { label: "Staged", description: "Release gradually" },
                    { label: "Big bang", description: "Release all at once" }
                  ]
                },
                {
                  question: "Which verification steps?",
                  header: "Verify",
                  options: [
                    { label: "Unit tests", description: "Run focused automated tests" },
                    { label: "Manual smoke", description: "Try the TUI interaction manually" }
                  ]
                }
              ]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Need multiple choices")) {
        return {
          content: "Need multiple choices.",
          tool_calls: [{
            id: "tool-question-multi",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which verification steps?",
                header: "Verify",
                multiSelect: true,
                options: [
                  { label: "Unit tests", description: "Run focused automated tests" },
                  { label: "Manual smoke", description: "Try the TUI interaction manually" }
                ]
              }]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Need freeform choice")) {
        return {
          content: "Need freeform choice.",
          tool_calls: [{
            id: "tool-question-freeform",
            name: "AskUserQuestion",
            input: {
              questions: [{
                id: "window",
                question: "Deployment window?",
                header: "Window",
                options: [
                  { label: "Weekday morning", description: "Lower staffing risk" },
                  { label: "Weekday evening", description: "Lower user traffic" }
                ]
              }]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Ready with permissions")) {
        return {
          content: "Requesting approval with permissions.",
          tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: { allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] } }]
        };
      }
      if (typeof userText === "string" && userText.includes("Ready empty exit")) {
        return {
          content: "Requesting empty exit.",
          tool_calls: [{ id: "tool-exit-plan-empty", name: "ExitPlanMode", input: {} }]
        };
      }
      if (typeof userText === "string" && userText.includes("Ready for approval")) {
        return {
          content: "Requesting approval.",
          tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: {} }]
        };
      }
      return {
        content: "Writing the plan draft.",
        tool_calls: [{ id: "tool-1", name: "Write", input: { file_path: planFilePath, content: String(userText ?? "Plan") } }]
      };
    }
  };
}

function planFilePathFromRequest(request: ModelRequest): string {
  const text = request.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  const match = /(?:Current plan file:|create your plan at|plan file already exists at)\s+(.+?)(?: using Write|\. You can read|$)/i.exec(text);
  if (!match?.[1]) throw new Error("Plan file attachment missing");
  return match[1].trim();
}

async function sendTuiLine(output: { stdin: { write(value: string): void } }, text: string): Promise<void> {
  output.stdin.write(text);
  await settleTuiWork();
  output.stdin.write("\r");
  await settleTuiWork();
}

async function waitForFrame(output: { lastFrame(): string | undefined }, pattern: RegExp): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    if (pattern.test(output.lastFrame() ?? "")) return;
    await settleTuiWork();
  }
  assert.match(output.lastFrame() ?? "", pattern);
}

async function makeProjectTmpCwd(prefix: string): Promise<string> {
  const root = resolve(".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

async function waitForArrayItem(items: unknown[], index: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (items.length > index) return;
    await settleTuiWork();
  }
  assert.ok(items.length > index);
}

async function waitForPromptInjectionMetadata(store: SessionStore, sessionId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const metadata = await store.loadMetadata(sessionId);
    if (metadata?.promptInjection?.globalPrompt) return metadata;
    await settleTuiWork();
  }
  const metadata = await store.loadMetadata(sessionId);
  assert.ok(metadata?.promptInjection?.globalPrompt);
  return metadata;
}

async function waitForRequest(requests: ModelRequest[], text: string): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => item.messages.some((message) => message.role === "user" && message.content === text));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => item.messages.some((message) => message.role === "user" && message.content === text));
  assert.ok(request);
  return request;
}

async function waitForRequestContaining(requests: ModelRequest[], pattern: RegExp): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => pattern.test(requestText(item)));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => pattern.test(requestText(item)));
  assert.ok(request);
  return request;
}

async function waitForImageFeedbackRequest(requests: ModelRequest[]): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => item.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => item.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")));
  assert.ok(request);
  return request;
}

async function waitForToolAnswerRequest(requests: ModelRequest[], pattern: RegExp): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => item.messages.some((message) => message.role === "tool" && pattern.test(String(message.content))));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => item.messages.some((message) => message.role === "tool" && pattern.test(String(message.content))));
  assert.ok(request);
  return request;
}

function requestText(request: ModelRequest): string {
  return request.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}

function assertFrameIncludesPath(frame: string, path: string): void {
  const normalize = (value: string) => value.replace(/\s+/g, "");
  assert.ok(normalize(frame).includes(normalize(path)));
}

function assertApprovedPlanHandoff(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual && typeof actual === "object");
  const handoff = actual as Record<string, unknown>;
  assert.equal(typeof handoff.plan_file_path, "string");
  assert.ok(String(handoff.plan_file_path).trim());
  assert.deepEqual(handoff, {
    ...expected,
    plan_file_path: expected.plan_file_path ?? handoff.plan_file_path
  });
}

function assertStartOption(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual && typeof actual === "object");
  const option = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(option[key], value);
  }
  if ("sessionId" in option) {
    assert.equal(typeof option.sessionId, "string");
    assert.ok(String(option.sessionId).trim());
  }
  if ("sessionDir" in option) {
    assert.equal(typeof option.sessionDir, "string");
    assert.ok(String(option.sessionDir).trim());
  }
}

function settleTuiWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function settleTerminalEscape(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 35));
}

function waitForPlanSavedMessageToHide(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 550));
}
