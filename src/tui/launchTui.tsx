import React from "react";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink";
import { TuiApp } from "./TuiApp.js";

export async function launchTui(options: { cwd: string }): Promise<void> {
  const configPath = join(options.cwd, "agent-team.yaml");
  let initialError: string | undefined;
  try {
    await access(configPath);
  } catch {
    initialError = "Missing agent-team.yaml";
  }

  render(<TuiApp cwd={options.cwd} initialError={initialError} />);
}
