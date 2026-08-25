"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function readNullSeparatedGitOutput(args, cwd) {
  const output = execFileSync("git", args, { cwd });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function isAgentInstructionPath(filePath) {
  return path.posix.basename(filePath) === "AGENTS.md";
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function resolveRepositoryPath(repositoryRoot, filePath) {
  const normalized = path.posix.normalize(filePath);
  if (
    !filePath ||
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    normalized !== filePath ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe agent instruction path: ${filePath}`);
  }

  const absolutePath = path.resolve(
    repositoryRoot,
    ...normalized.split("/"),
  );
  const relativePath = path.relative(repositoryRoot, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Agent instruction path escapes the repository: ${filePath}`,
    );
  }
  return absolutePath;
}

function parseRootInstructionPaths(value) {
  if (!value) {
    return [];
  }

  const filePaths = value.split(/\s+/).filter(Boolean);
  for (const filePath of filePaths) {
    if (
      filePath.includes("\\") ||
      filePath !== path.posix.basename(filePath) ||
      [".", ".."].includes(filePath)
    ) {
      throw new Error(`Unsafe root agent instruction path: ${filePath}`);
    }
  }
  return filePaths;
}

function ensureSafeParentDirectories(
  repositoryRoot,
  absolutePath,
  { create },
) {
  const relativeParent = path.relative(
    repositoryRoot,
    path.dirname(absolutePath),
  );
  let current = repositoryRoot;

  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatIfExists(current);
    if (!stat) {
      if (!create) {
        return false;
      }
      fs.mkdirSync(current);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Refusing to restore through unsafe parent path: ${current}`,
      );
    }
  }
  return true;
}

function readTrustedEntry(repositoryRoot, trustedSha, filePath) {
  const output = execFileSync(
    "git",
    ["ls-tree", "-z", trustedSha, "--", filePath],
    { cwd: repositoryRoot },
  );
  if (output.length === 0) {
    return null;
  }

  const tab = output.indexOf(0x09);
  const nul = output.indexOf(0x00);
  if (tab < 0 || nul < tab) {
    throw new Error(`Malformed trusted git entry for ${filePath}`);
  }

  const [mode, type, objectId] = output
    .subarray(0, tab)
    .toString("utf8")
    .split(" ");
  const entryPath = output.subarray(tab + 1, nul).toString("utf8");
  if (
    entryPath !== filePath ||
    type !== "blob" ||
    !["100644", "100755"].includes(mode) ||
    !objectId
  ) {
    throw new Error(`Unsafe trusted git entry for ${filePath}`);
  }

  return {
    content: execFileSync("git", ["cat-file", "blob", objectId], {
      cwd: repositoryRoot,
    }),
    mode,
    objectId,
  };
}

function removeExistingInstruction(absolutePath) {
  const stat = lstatIfExists(absolutePath);
  if (!stat) {
    return;
  }
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    throw new Error(
      `Refusing to replace non-file agent instruction: ${absolutePath}`,
    );
  }
  fs.unlinkSync(absolutePath);
}

function writeTrustedInstruction(
  repositoryRoot,
  filePath,
  absolutePath,
  entry,
) {
  ensureSafeParentDirectories(repositoryRoot, absolutePath, { create: true });
  removeExistingInstruction(absolutePath);

  const fileMode = entry.mode === "100755" ? 0o755 : 0o644;
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.trusted-${process.pid}-${Date.now()}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", fileMode);
    fs.writeFileSync(descriptor, entry.content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, absolutePath);
    fs.chmodSync(absolutePath, fileMode);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }

  const restored = fs.lstatSync(absolutePath);
  if (restored.isSymbolicLink() || !restored.isFile()) {
    throw new Error(`Restored instruction is not a regular file: ${filePath}`);
  }
  if (!fs.readFileSync(absolutePath).equals(entry.content)) {
    throw new Error(`Restored instruction content mismatch: ${filePath}`);
  }

  const restoredObjectId = execFileSync(
    "git",
    ["hash-object", "--", filePath],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();
  if (restoredObjectId !== entry.objectId) {
    throw new Error(`Restored instruction hash mismatch: ${filePath}`);
  }
  if (process.platform !== "win32") {
    const expectedExecutable = entry.mode === "100755";
    const restoredExecutable = (restored.mode & 0o111) !== 0;
    if (restoredExecutable !== expectedExecutable) {
      throw new Error(`Restored instruction mode mismatch: ${filePath}`);
    }
  }
}

function removeUntrustedInstruction(
  repositoryRoot,
  absolutePath,
  filePath,
) {
  if (
    !ensureSafeParentDirectories(repositoryRoot, absolutePath, {
      create: false,
    })
  ) {
    return;
  }
  removeExistingInstruction(absolutePath);
  if (lstatIfExists(absolutePath)) {
    throw new Error(`Failed to remove untrusted instruction: ${filePath}`);
  }
}

function restoreTrustedAgentInstructions({
  trustedSha = process.env.TRUSTED_WORKFLOW_SHA,
  rootInstructionPaths = process.env.GH_AW_AGENT_FILES,
} = {}) {
  if (!trustedSha) {
    throw new Error("TRUSTED_WORKFLOW_SHA is required");
  }

  const repositoryRoot = fs.realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  );
  execFileSync("git", ["cat-file", "-e", `${trustedSha}^{commit}`], {
    cwd: repositoryRoot,
  });
  const currentPaths = readNullSeparatedGitOutput(
    ["ls-files", "-z"],
    repositoryRoot,
  );
  const trustedPaths = readNullSeparatedGitOutput(
    ["ls-tree", "-rz", "--name-only", trustedSha],
    repositoryRoot,
  );
  const instructionPaths = new Set(
    [
      ...parseRootInstructionPaths(rootInstructionPaths),
      ...[...currentPaths, ...trustedPaths].filter(isAgentInstructionPath),
    ],
  );

  for (const filePath of instructionPaths) {
    const absolutePath = resolveRepositoryPath(repositoryRoot, filePath);
    const trustedEntry = readTrustedEntry(
      repositoryRoot,
      trustedSha,
      filePath,
    );
    if (trustedEntry) {
      writeTrustedInstruction(
        repositoryRoot,
        filePath,
        absolutePath,
        trustedEntry,
      );
    } else {
      removeUntrustedInstruction(repositoryRoot, absolutePath, filePath);
    }
  }

  process.stdout.write(
    `Restored ${instructionPaths.size} trusted agent instruction file(s).\n`,
  );
}

if (require.main === module) {
  restoreTrustedAgentInstructions();
}

module.exports = {
  isAgentInstructionPath,
  parseRootInstructionPaths,
  restoreTrustedAgentInstructions,
};
