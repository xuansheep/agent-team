import type { SkillRuntimeDiagnostic } from "../../skills/runtime.js";
import type { InteractionChoice } from "../components/InteractionArea.js";

export function buildSkillsListChoice(input: {
  skills: SkillRuntimeDiagnostic[];
  pendingSkillNames?: string[];
  onSelect: (name: string) => void;
  onToggle?: (name: string, disabled: boolean) => void;
  onCancel: () => void;
}): InteractionChoice {
  const pendingNames = new Set(input.pendingSkillNames ?? []);
  const options = input.skills.map((skill) => {
    const pending = pendingNames.has(skill.name);
    const status = skill.error ? "invalid" : pending ? "saving" : skill.disabled ? "disabled" : "enabled";
    return {
      label: skill.name,
      value: skill.name,
      prefix: skill.error ? "[!]" : skill.disabled ? "[ ]" : "[✓]",
      description: [status, skill.source, skill.mode, skill.path].filter(Boolean).join(" · ")
    };
  });
  return {
    title: "Skills",
    detail: input.skills.length ? `${input.skills.length} discovered skills · Space toggle · Enter details` : "No skills available",
    options: options.length ? options : [{ label: "No skills available", value: "__empty__", description: "Create or install skills to see them here", disabled: true }],
    selectedValue: options[0]?.value ?? "__empty__",
    visibleOptionCount: 10,
    footerActions: [{ label: "Esc Back", value: "__cancel__" }],
    onCancel: input.onCancel,
    onToggle: (value) => {
      const skill = input.skills.find((candidate) => candidate.name === value);
      if (!skill || skill.error || pendingNames.has(skill.name)) return;
      input.onToggle?.(skill.name, skill.disabled !== true);
    },
    onSubmit: (value) => {
      if (value === "__cancel__") input.onCancel();
      else if (value !== "__empty__") input.onSelect(value);
    }
  };
}

export function buildSkillsDetailChoice(input: { skill: SkillRuntimeDiagnostic; onBack: () => void; onCancel: () => void }): InteractionChoice {
  return {
    title: `Skill: ${input.skill.name}`,
    documentBlock: { text: skillDetailText(input.skill), maxLines: 18, scrollable: true },
    options: [{ label: "Back", value: "__back__" }],
    selectedValue: "__back__",
    footerActions: [{ label: "Esc Back", value: "__back__" }],
    onCancel: input.onBack,
    onSubmit: input.onBack
  };
}

function skillDetailText(skill: SkillRuntimeDiagnostic): string {
  return [
    `name: ${skill.name}`,
    `status: ${skill.error ? "invalid" : skill.disabled ? "disabled" : "enabled"}`,
    `source: ${skill.source}`,
    `mode: ${skill.mode}`,
    `path: ${skill.path}`,
    skill.error ? `error: ${skill.error}` : undefined,
    skill.version ? `version: ${skill.version}` : undefined,
    skill.argumentHint ? `argumentHint: ${skill.argumentHint}` : undefined,
    skill.userInvocable !== undefined ? `userInvocable: ${skill.userInvocable}` : undefined,
    skill.disableModelInvocation !== undefined ? `disableModelInvocation: ${skill.disableModelInvocation}` : undefined,
    skill.paths?.length ? `paths: ${skill.paths.join(", ")}` : undefined,
    skill.allowedTools?.length ? `allowedTools: ${skill.allowedTools.join(", ")}` : "allowedTools: none",
    skill.description ? `description: ${skill.description}` : undefined,
    skill.whenToUse ? `whenToUse: ${skill.whenToUse}` : undefined
  ].filter(Boolean).join("\n");
}
