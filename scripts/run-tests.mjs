import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function collectTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(path));
    if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

const root = resolve("dist-test", "tests");
const files = await collectTests(root);
for (const file of files.sort()) {
  await import(pathToFileURL(file).href);
}
