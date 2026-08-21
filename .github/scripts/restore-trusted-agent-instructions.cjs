"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function readNullSeparatedGitOutput(args) {
  const output = execFileSync("git", args);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function isAgentInstructionPath(filePath) {
  return path.posix.basename(filePath) === "AGENTS.md";
}

function gitObjectExists(objectName) {
  const result = spawnSync("git", ["cat-file", "-e", objectName], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 128) {
    return false;
  }
  throw new Error(
    `git cat-file failed for ${objectName}: ${result.stderr || result.error || "unknown error"}`,
  );
}

function restoreTrustedAgentInstructions({
  trustedSha = process.env.TRUSTED_WORKFLOW_SHA,
} = {}) {
  if (!trustedSha) {
    throw new Error("TRUSTED_WORKFLOW_SHA is required");
  }

  execFileSync("git", ["cat-file", "-e", `${trustedSha}^{commit}`]);
  const currentPaths = readNullSeparatedGitOutput(["ls-files", "-z"]);
  const trustedPaths = readNullSeparatedGitOutput([
    "ls-tree",
    "-rz",
    "--name-only",
    trustedSha,
  ]);
  const instructionPaths = new Set(
    [...currentPaths, ...trustedPaths].filter(isAgentInstructionPath),
  );

  for (const filePath of instructionPaths) {
    if (gitObjectExists(`${trustedSha}:${filePath}`)) {
      const content = execFileSync("git", ["show", `${trustedSha}:${filePath}`]);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }

  process.stdout.write(
    `Restored ${instructionPaths.size} trusted AGENTS.md file(s).\n`,
  );
}

if (require.main === module) {
  restoreTrustedAgentInstructions();
}

module.exports = {
  isAgentInstructionPath,
  restoreTrustedAgentInstructions,
};
