import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const script = path.join(
  root,
  ".github/scripts/restore-trusted-agent-instructions.cjs",
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("trusted agent instruction restoration", () => {
  let repository: string;

  beforeEach(() => {
    repository = fs.mkdtempSync(
      path.join(os.tmpdir(), "trusted-agent-instructions-"),
    );
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.name", "Agent Test");
    git(repository, "config", "user.email", "agent@example.com");
    fs.mkdirSync(path.join(repository, "src/agent"), { recursive: true });
    fs.writeFileSync(
      path.join(repository, "src/agent/AGENTS.md"),
      "trusted instructions\n",
    );
    fs.writeFileSync(path.join(repository, "README.md"), "trusted readme\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "trusted base");
  });

  afterEach(() => {
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it("restores trusted files and removes pull-request-added instructions", () => {
    const trustedSha = git(repository, "rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(repository, "src/agent/AGENTS.md"),
      "malicious instructions\n",
    );
    fs.mkdirSync(path.join(repository, "src/new"), { recursive: true });
    fs.writeFileSync(
      path.join(repository, "src/new/AGENTS.md"),
      "new malicious instructions\n",
    );
    fs.writeFileSync(path.join(repository, "README.md"), "pull request readme\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "untrusted changes");

    execFileSync("node", [script], {
      cwd: repository,
      env: {
        ...process.env,
        TRUSTED_WORKFLOW_SHA: trustedSha,
      },
    });

    expect(
      fs.readFileSync(
        path.join(repository, "src/agent/AGENTS.md"),
        "utf8",
      ),
    ).toBe("trusted instructions\n");
    expect(fs.existsSync(path.join(repository, "src/new/AGENTS.md"))).toBe(false);
    expect(
      fs.readFileSync(path.join(repository, "README.md"), "utf8"),
    ).toBe("pull request readme\n");
  });
});
