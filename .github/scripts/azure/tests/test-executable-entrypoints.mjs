import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const records = execFileSync("git", [
  "ls-files", "--stage", "-z", "--", ".github/scripts/azure",
], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
let checked = 0;
for (const record of records) {
  const match = /^([0-7]{6}) [0-9a-f]+ ([0-3])\t(.+)$/.exec(record);
  assert(match, "Unable to read a committed Azure helper's index metadata.");
  const [, mode, stage, path] = match;
  if (!path.endsWith(".sh") &&
      !path.endsWith("/render-bicepparam.mjs") &&
      !path.endsWith("/fixtures/model-quota/bin/az")) continue;
  assert.equal(stage, "0", `${path}: unresolved index entry.`);
  assert.equal(mode, "100755", `${path}: the Git index must retain its executable bit.`);
  if (process.platform !== "win32") accessSync(join(root, path), constants.X_OK);
  checked += 1;
}
assert(checked > 0, "The executable Azure entrypoint inventory is empty.");
console.log(`Verified ${checked} executable Azure entrypoints in the Git index${
  process.platform === "win32" ? " (native executable checks require Linux)." : " and native checkout."
}`);
