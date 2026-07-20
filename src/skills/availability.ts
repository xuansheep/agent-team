import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { defaultUserSettingsPath, updateUserSettingsFile } from "../settings/loadSettings.js";
import { currentProjectKey, currentProjectState } from "../settings/projectState.js";
import { settingsSchema } from "../settings/types.js";

export type SkillAvailabilityOptions = {
  cwd: string;
  userSettingsPath?: string;
};

export async function loadDisabledSkillNames(options: SkillAvailabilityOptions): Promise<string[]> {
  const path = options.userSettingsPath ?? defaultUserSettingsPath();
  const settings = settingsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return normalizeNames(currentProjectState(settings, options.cwd)?.disabledSkills ?? []);
}

export async function setSkillDisabledState(options: SkillAvailabilityOptions, skillName: string, disabled: boolean): Promise<void> {
  const normalizedName = skillName.trim();
  if (!normalizedName) throw new Error("Skill name is required");
  const path = options.userSettingsPath ?? defaultUserSettingsPath();
  await updateUserSettingsFile(path, (settings) => {
    const projectKey = currentProjectKey(settings, options.cwd);
    const project = settings.projects?.[projectKey] ?? {};
    return {
      ...settings,
      projects: {
        ...(settings.projects ?? {}),
        [projectKey]: {
          ...project,
          disabledSkills: toggleMembership(project.disabledSkills ?? [], normalizedName, disabled)
        }
      }
    };
  });
}

export function watchDisabledSkillNames(
  options: SkillAvailabilityOptions,
  callbacks: { onChange: (disabledSkillNames: string[]) => void; onError?: (error: Error) => void },
  debounceMs = 100
): () => void {
  const path = options.userSettingsPath ?? defaultUserSettingsPath();
  let watcher: FSWatcher;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let generation = 0;
  let lastSignature: string | undefined;

  const reload = async () => {
    const currentGeneration = ++generation;
    try {
      const names = await loadDisabledSkillNames(options);
      if (closed || currentGeneration !== generation) return;
      const signature = JSON.stringify(names);
      if (signature === lastSignature) return;
      lastSignature = signature;
      callbacks.onChange(names);
    } catch (error) {
      if (!closed && currentGeneration === generation) callbacks.onError?.(asError(error));
    }
  };
  const scheduleReload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void reload(); }, debounceMs);
  };

  watcher = watch(dirname(path), (_eventType, filename) => {
    if (filename && filename.toString() !== basename(path)) return;
    scheduleReload();
  });
  watcher.on("error", (error) => callbacks.onError?.(asError(error)));

  return () => {
    closed = true;
    generation += 1;
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

function toggleMembership(values: string[], name: string, present: boolean): string[] {
  const unique = normalizeNames(values);
  if (unique.includes(name) === present) return unique;
  return present ? [...unique, name].sort() : unique.filter((value) => value !== name);
}

function normalizeNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
