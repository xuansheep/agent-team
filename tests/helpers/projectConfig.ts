import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DispatcherConfig } from "../../src/config/schema.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/providers/types.js";

export const testDispatcher = {
  provider: "default",
  model: "gpt-test",
  effort: "medium",
  confidence_threshold: 0.8
} satisfies DispatcherConfig;

export function testBusResponse(request: ModelRequest, nodeId: string): ModelResponse | undefined {
  if (request.context?.nodeId !== "bus") return undefined;
  const systemPrompt = request.messages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
  if (systemPrompt.includes("The workflow is at a bus boundary")) {
    return {
      content: JSON.stringify({
        type: "finalize",
        confidence: 1,
        summary: {
          summary: "Test workflow completed.",
          outcomes: [],
          verification: [],
          residual_risks: [],
          artifacts: []
        }
      })
    };
  }
  if (systemPrompt.includes("The user is in Plan Mode")) {
    return {
      content: JSON.stringify({
        type: "plan",
        confidence: 1,
        node_id: nodeId,
        reason: "test routing"
      })
    };
  }
  return {
    content: JSON.stringify({
      type: "dispatch",
      confidence: 1,
      node_id: nodeId,
      instruction: "Execute the test request.",
      reason: "test routing"
    })
  };
}

export function withTestBusRouting(provider: ModelProvider, nodeId: string): ModelProvider {
  return {
    async generate(request) {
      return testBusResponse(request, nodeId) ?? provider.generate(request);
    }
  };
}

export function testBusProviderFactory(nodeId: string): (providerId: string) => ModelProvider {
  const provider: ModelProvider = {
    async generate(request) {
      const response = testBusResponse(request, nodeId);
      if (!response) throw new Error(`Unexpected non-bus model request for provider ${request.model}`);
      return response;
    }
  };
  return () => provider;
}

export type TestRole = {
  description?: string;
  system_prompt: string;
};

export type TestWorkflow = {
  description?: string;
  nodes: unknown[];
  permissions?: unknown;
};

export async function writeProjectConfig(
  cwd: string,
  options: {
    prompt?: string;
    roles?: Record<string, TestRole>;
    workflows?: Record<string, TestWorkflow>;
    teams?: Record<string, TestWorkflow>;
  } = {}
): Promise<string> {
  const configDir = join(cwd, "config");
  const rolesDir = join(configDir, "roles");
  const workflowsDir = join(configDir, "workflows");
  const teamsDir = join(configDir, "teams");
  await Promise.all([
    mkdir(rolesDir, { recursive: true }),
    mkdir(workflowsDir, { recursive: true }),
    mkdir(teamsDir, { recursive: true })
  ]);
  await writeFile(join(configDir, "prompt.md"), options.prompt ?? "", "utf8");

  const roles = options.roles ?? { dev: { system_prompt: "Build safely." } };
  await Promise.all(Object.entries(roles).map(([name, role]) => writeFile(
    join(rolesDir, `${name}.md`),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(role.description ?? `${name} role`)}\n---\n\n${role.system_prompt}\n`,
    "utf8"
  )));

  const workflows = options.workflows ?? {
    delivery: { nodes: [{ id: "dev", role: "dev", provider: "default" }] }
  };
  await Promise.all(Object.entries(workflows).map(([name, workflow]) => writeFile(
    join(workflowsDir, `${name}.json`),
    `${JSON.stringify({ name, ...workflow }, null, 2)}\n`,
    "utf8"
  )));

  const defaultTeamRole = Object.keys(roles)[0] ?? "dev";
  const teams = options.teams ?? {
    team: { nodes: [{ id: defaultTeamRole, role: defaultTeamRole, provider: "default" }] }
  };
  await Promise.all(Object.entries(teams).map(([name, team]) => writeFile(
    join(teamsDir, `${name}.json`),
    `${JSON.stringify({ name, ...team }, null, 2)}\n`,
    "utf8"
  )));
  return configDir;
}
