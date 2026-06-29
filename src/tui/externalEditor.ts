import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import instances from "../ink/instances.js";

export type ExternalEditorResult = {
  content: string | null;
  error?: string;
};

export type ExternalEditor = (filePath: string) => ExternalEditorResult | Promise<ExternalEditorResult>;
export type ExternalTextEditor = (text: string) => ExternalEditorResult | Promise<ExternalEditorResult>;

const editorOverrides: Record<string, string[]> = {
  code: ["code", "-w"],
  cursor: ["cursor", "-w"],
  windsurf: ["windsurf", "-w"],
  codium: ["codium", "-w"],
  subl: ["subl", "--wait"]
};

const guiEditors = new Set(["code", "cursor", "windsurf", "codium", "subl", "atom", "gedit"]);

export function editFileInExternalEditor(filePath: string): ExternalEditorResult {
  const editor = externalEditor();
  if (!editor || !existsSync(filePath)) return { content: null };

  const command = editorCommand(editor);
  const useAlternateScreen = !isGuiEditor(command[0] ?? "");
  const ink = instances.get(process.stdout);
  if (ink) {
    if (useAlternateScreen) ink.enterAlternateScreen();
    else {
      ink.pause();
      ink.suspendStdin();
    }
  }

  try {
    const [bin, ...args] = command;
    if (!bin) return { content: null };
    const result = spawnSync(bin, [...args, filePath], { stdio: "inherit" });
    if (result.status && result.status !== 0) {
      return { content: null, error: `${basename(bin)} exited with code ${result.status}` };
    }
    if (result.error) return { content: null, error: result.error.message };
    return { content: readFileSync(filePath, "utf8") };
  } finally {
    if (ink) {
      if (useAlternateScreen) ink.exitAlternateScreen();
      else {
        ink.resumeStdin();
        ink.resume();
      }
    }
  }
}

export function editTextInExternalEditor(text: string, cwd = process.cwd()): ExternalEditorResult {
  const tmpDir = join(cwd, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const filePath = join(tmpDir, `agent-team-editor-${randomUUID()}.md`);
  writeFileSync(filePath, text, "utf8");
  return editFileInExternalEditor(filePath);
}

function externalEditor(): string | undefined {
  return process.env.VISUAL || process.env.EDITOR;
}

export function externalEditorDisplayName(): string | undefined {
  const editor = externalEditor();
  return editor ? toEditorDisplayName(editor) : undefined;
}

function editorCommand(editor: string): string[] {
  const parts = editor.trim().split(/\s+/).filter(Boolean);
  const base = basename(parts[0] ?? "");
  return editorOverrides[base] ?? parts;
}

function toEditorDisplayName(editor: string): string {
  const normalized = editor.toLowerCase().trim();
  const exact = editorDisplayNames[normalized];
  if (exact) return exact;
  const command = normalized.split(/\s+/)[0] ?? "";
  const base = basename(command);
  return editorDisplayNames[base] ?? (base ? `${base.slice(0, 1).toUpperCase()}${base.slice(1)}` : "IDE");
}

function isGuiEditor(command: string): boolean {
  const base = basename(command);
  return guiEditors.has(base);
}

const editorDisplayNames: Record<string, string> = {
  code: "VS Code",
  cursor: "Cursor",
  windsurf: "Windsurf",
  antigravity: "Antigravity",
  vi: "Vim",
  vim: "Vim",
  nano: "nano",
  notepad: "Notepad",
  "start /wait notepad": "Notepad",
  emacs: "Emacs",
  subl: "Sublime Text",
  atom: "Atom"
};
