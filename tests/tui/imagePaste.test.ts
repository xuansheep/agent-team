import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPastedImagePath, resolveImagePaste } from "../../src/tui/imagePaste.js";

describe("TUI image paste helpers", () => {
  it("extracts image data URLs from pasted text", async () => {
    const result = await resolveImagePaste("Use this data:image/png;base64,iVBORw0KGgo=", { cwd: resolve(".") });

    assert.equal(result.text, "Use this");
    assert.deepEqual(result.images, [{ type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }]);
  });

  it("reads quoted and escaped image file paths from the current cwd", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-image-paste-");
    await writeFile(join(cwd, "screen shot.png"), Buffer.from("iVBORw0KGgo=", "base64"));

    const result = await resolveImagePaste("\"screen\\ shot.png\"", { cwd });

    assert.equal(result.text, "");
    assert.deepEqual(result.images, [{ type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }]);
  });

  it("keeps non-image pasted lines as text while attaching image paths", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-image-paste-mixed-");
    await writeFile(join(cwd, "diagram.webp"), Buffer.from("RIFFxxxxWEBP", "ascii"));

    const result = await resolveImagePaste(`Please inspect\n${join(cwd, "diagram.webp")}`, { cwd });

    assert.equal(result.text, "Please inspect");
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0]?.media_type, "image/webp");
  });

  it("detects image-looking paths without reading files", () => {
    assert.equal(isPastedImagePath("\"/tmp/screenshot.jpeg\""), true);
    assert.equal(isPastedImagePath("/tmp/report.txt"), false);
  });
});

async function makeProjectTmpCwd(prefix: string): Promise<string> {
  const root = resolve(".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
