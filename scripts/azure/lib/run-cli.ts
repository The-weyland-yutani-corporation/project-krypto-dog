import { spawn } from "node:child_process";

export type CliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Runs a fixed, explicit argv array as a child process (`shell: false`).
 * Never constructs a shell command string and never evaluates
 * operator-controlled input -- `command` and `args` must always be
 * literal, code-controlled values (validated environment values are
 * passed as individual argv entries, never concatenated into a command
 * string).
 */
export function runCli(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code, stdout, stderr });
    });
  });
}
