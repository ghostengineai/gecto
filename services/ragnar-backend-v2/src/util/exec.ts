import { spawn } from "node:child_process";
import { log } from "./log";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const execFile = async (
  file: string,
  args: string[],
  opts?: {
    cwd?: string;
    timeoutMs?: number;
    inputText?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ExecResult> => {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      log.warn("exec timeout, killing process", { file, timeoutMs });
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    if (opts?.inputText) {
      child.stdin.write(opts.inputText);
    }
    child.stdin.end();
  });
};
