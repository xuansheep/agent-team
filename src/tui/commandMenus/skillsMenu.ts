import type { SkillRuntimeDiagnostic } from "../../skills/runtime.js";
import type { InteractionChoice } from "../components/InteractionArea.js";

export function buildSkillsListChoice(input: { skills: SkillRuntimeDiagnostic[]; onSelect: (name: string) => void; onCancel: () => void }): InteractionChoice {
  const options = input.skills.map((skill) => ({
    label: skill.name,
    value: skill.name,
    description: [skill.source, skill.mode, skill.hasHooks ? "hooks" : "no-hooks", skill.path].join(" · ")
  }));
  return {
    title: "Skills",
    detail: input.skills.length ? `${input.skills.length} available skills` : "No skills available",
    options: options.length ? options : [{ label: "No skills available", value: "__empty__", description: "Create or install skills to see them here", disabled: true }],
    selectedValue: options[0]?.value ?? "__empty__",
    visibleOptionCount: 10,
    footerActions: [{ label: "Esc Back", value: "__cancel__" }],
    onCancel: input.onCancel,
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
    `source: ${skill.source}`,
    `mode: ${skill.mode}`,
    `path: ${skill.path}`,
    `hasHooks: ${skill.hasHooks}`,
    skill.allowedTools?.length ? `allowedTools: ${skill.allowedTools.join(", ")}` : "allowedTools: none",
    skill.description ? `description: ${skill.description}` : undefined,
    skill.whenToUse ? `whenToUse: ${skill.whenToUse}` : undefined
  ].filter(Boolean).join("\n");
}
