import type { HookRuntimeDiagnostic } from "../../hooks/runtime.js";
import type { InteractionChoice } from "../components/InteractionArea.js";

export function buildHooksEventChoice(input: { hooks: HookRuntimeDiagnostic[]; onSelect: (event: string) => void; onCancel: () => void }): InteractionChoice {
  const events = [...new Set(input.hooks.map((hook) => hook.event))].sort();
  const options = events.map((event) => ({ label: event, value: event, description: `${input.hooks.filter((hook) => hook.event === event).length} hooks` }));
  return hooksChoice("Hooks", input.hooks.length ? `${input.hooks.length} configured hooks` : "No hooks configured", options, input.onSelect, input.onCancel);
}

export function buildHooksMatcherChoice(input: { event: string; hooks: HookRuntimeDiagnostic[]; onSelect: (matcher: string) => void; onBack: () => void; onCancel: () => void }): InteractionChoice {
  const matchers = [...new Set(input.hooks.filter((hook) => hook.event === input.event).map((hook) => hook.matcher || "*"))].sort();
  const options = matchers.map((matcher) => ({ label: matcher, value: matcher, description: `${input.hooks.filter((hook) => hook.event === input.event && (hook.matcher || "*") === matcher).length} hooks` }));
  return hooksChoice(`Hooks: ${input.event}`, "Select matcher", options, input.onSelect, input.onBack);
}

export function buildHooksHookChoice(input: { event: string; matcher: string; hooks: HookRuntimeDiagnostic[]; onSelect: (id: string) => void; onBack: () => void; onCancel: () => void }): InteractionChoice {
  const hooks = input.hooks.filter((hook) => hook.event === input.event && (hook.matcher || "*") === input.matcher);
  const options = hooks.map((hook) => ({ label: hook.id, value: hook.id, description: [hook.type, hook.source, hook.wired ? "wired" : "not-wired", hook.disabled ? "disabled" : "enabled", hook.command].join(" · ") }));
  return hooksChoice(`Hooks: ${input.event} ${input.matcher}`, "Select hook", options, input.onSelect, input.onBack);
}

export function buildHooksHookDetailChoice(input: { hook: HookRuntimeDiagnostic; onBack: () => void; onCancel: () => void }): InteractionChoice {
  return {
    title: `Hook: ${input.hook.id}`,
    documentBlock: { text: hookDetailText(input.hook), maxLines: 18, scrollable: true },
    options: [{ label: "Back", value: "__back__" }],
    selectedValue: "__back__",
    footerActions: [{ label: "Esc Back", value: "__back__" }],
    onCancel: input.onBack,
    onSubmit: input.onBack
  };
}

function hooksChoice(title: string, detail: string, options: InteractionChoice["options"], onSelect: (value: string) => void, onCancel: () => void): InteractionChoice {
  const visibleOptions = options.length ? options : [{ label: "No hooks available", value: "__empty__", disabled: true }];
  return {
    title,
    detail,
    options: visibleOptions,
    selectedValue: visibleOptions[0]?.value ?? "__empty__",
    visibleOptionCount: 10,
    footerActions: [{ label: "Esc Back", value: "__cancel__" }],
    onCancel,
    onSubmit: (value) => {
      if (value === "__cancel__") onCancel();
      else if (value !== "__empty__") onSelect(value);
    }
  };
}

function hookDetailText(hook: HookRuntimeDiagnostic): string {
  return [
    `id: ${hook.id}`,
    `event: ${hook.event}`,
    `matcher: ${hook.matcher || "*"}`,
    `type: ${hook.type}`,
    `source: ${hook.source}`,
    `command: ${hook.command}`,
    `wired: ${hook.wired}`,
    `disabled: ${hook.disabled === true}`,
    hook.skillRoot ? `skillRoot: ${hook.skillRoot}` : undefined,
    hook.once !== undefined ? `once: ${hook.once}` : undefined,
    hook.lastExecution ? `lastExecution: ${hook.lastExecution.outcome} ${hook.lastExecution.error ?? ""}`.trim() : "lastExecution: none"
  ].filter(Boolean).join("\n");
}
