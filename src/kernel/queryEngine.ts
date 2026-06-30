import type { ModelProvider, ModelToolCall } from "../providers/types.js";
import { PermissionKernel } from "./permissions/permissionKernel.js";
import type { KernelSession } from "./session.js";
import { reduceKernelSession } from "./session.js";
import type { KernelToolRegistry } from "./tools/registry.js";

const maxToolIterations = 20;

export type QueryEngineInput = {
  session: KernelSession;
  provider: ModelProvider;
  model: string;
  tools: KernelToolRegistry;
};

export type QueryEngineResult = {
  session: KernelSession;
};

export class QueryEngine {
  private readonly permissions = new PermissionKernel();

  async run(input: QueryEngineInput): Promise<QueryEngineResult> {
    let session = reduceKernelSession(input.session, {
      type: "status_set",
      status: input.session.toolPermissionContext.mode === "plan" ? "planning" : "running_query"
    });
    const messages = session.messages.slice();

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const response = await input.provider.generate({
        model: input.model,
        messages,
        tools: input.tools.visibleTools(session.toolPermissionContext).map((tool) => tool.legacyTool),
        context: {
          runId: session.workflowBinding?.runId ?? session.id,
          nodeId: "kernel",
          attempt: iteration + 1,
          sessionId: session.id,
          threadId: session.id,
          turnId: `${session.id}:${iteration + 1}`,
          promptCacheKey: session.id
        }
      });

      if (!response.tool_calls?.length) {
        return {
          session: {
            ...session,
            messages: response.content === undefined ? messages : [...messages, { role: "assistant", content: response.content }],
            status: "idle_input"
          }
        };
      }

      const calls = await callsUntilUserInteraction(response.tool_calls, input.tools, session);
      messages.push({ role: "assistant", content: response.content ?? "", tool_calls: calls });

      for (const call of calls) {
        const tool = input.tools.get(call.name);
        const permission = await this.permissions.check(tool, call.input, { ...session.toolPermissionContext, cwd: session.cwd });
        if (permission.decision === "ask") {
          return {
            session: reduceKernelSession({ ...session, messages }, {
              type: "pending_interaction_set",
              interaction: {
                type: "tool_permission",
                id: call.id,
                sessionId: session.id,
                tool: call.name,
                input: call.input,
                reason: permission.reason,
                rule: permission.rule
              }
            })
          };
        }
        if (permission.decision === "deny") {
          return {
            session: {
              ...session,
              messages: [...messages, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: permission.reason ?? "Permission denied" }) }],
              status: "idle_input"
            }
          };
        }
      }

      for (const call of calls) {
        const tool = input.tools.get(call.name);
        const context = { cwd: session.cwd, sessionId: session.id, planState: session.planState ?? undefined };
        const interaction = await tool.requiresUserInteraction(call.input, context);
        const result = await tool.execute(call.input, context);
        if (interaction?.type === "ask_user_question") {
          return {
            session: reduceKernelSession({ ...session, messages }, {
              type: "pending_interaction_set",
              interaction: {
                type: "ask_user_question",
                id: call.id,
                sessionId: session.id,
                toolCallId: call.id,
                questions: interaction.questions ?? questionsFromResult(result)
              }
            })
          };
        }
        if (interaction?.type === "plan_approval") {
          return {
            session: reduceKernelSession({ ...session, messages }, {
              type: "pending_interaction_set",
              interaction: planApprovalFromResult(call.id, session.id, result, session.planState?.planFilePath ?? "")
            })
          };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(tool.mapToolResultToModelResult(result, context)) });
      }
    }

    return { session: { ...session, messages, status: "idle_input" } };
  }
}

async function callsUntilUserInteraction(
  calls: ModelToolCall[],
  tools: KernelToolRegistry,
  session: KernelSession
): Promise<ModelToolCall[]> {
  for (let index = 0; index < calls.length; index += 1) {
    if (await tools.get(calls[index].name).requiresUserInteraction(calls[index].input, {
      cwd: session.cwd,
      sessionId: session.id,
      planState: session.planState ?? undefined
    })) {
      return calls.slice(0, index + 1);
    }
  }
  return calls;
}

function questionsFromResult(result: { data?: unknown }): unknown[] {
  const data = result.data as { questions?: unknown } | undefined;
  return Array.isArray(data?.questions) ? data.questions : [];
}

function planApprovalFromResult(id: string, sessionId: string, result: { data?: unknown }, fallbackPath: string) {
  const data = result.data as { plan?: { document?: string; planFilePath?: string; empty?: boolean } } | undefined;
  return {
    type: "plan_approval" as const,
    id,
    sessionId,
    document: data?.plan?.document ?? "",
    planFilePath: data?.plan?.planFilePath ?? fallbackPath,
    empty: data?.plan?.empty
  };
}
