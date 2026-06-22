#!/usr/bin/env node
import { dispatchCli } from "./dispatch.js";

void dispatchCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
