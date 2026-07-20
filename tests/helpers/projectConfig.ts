import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TestRole = {
  description?: string;
  system_prompt: string;
};

export type TestWorkflow = {
  description?: string;
  nodes: unknown[];
  workflow_permissions?: unknown;
};

export async function writeProjectConfig(
  cwd: string,
  options: {
    prompt?: string;
    roles?: Record<string, TestRole>;
    workflows?: Record<string, TestWorkflow>;
  } = {}
): Promise<string> {
  const configDir = join(cwd, "config");
  const rolesDir = join(configDir, "roles");
  const workflowsDir = join(configDir, "workflows");
  await Promise.all([
    mkdir(rolesDir, { recursive: true }),
    mkdir(workflowsDir, { recursive: true })
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
  return configDir;
}
