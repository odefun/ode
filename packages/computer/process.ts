import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function runCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs: number }
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${executable} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(new Error(`${executable} exited with ${exitCode}: ${(stderr || stdout).trim().slice(0, 4_000)}`));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}
export async function runJsonCommand<T extends Record<string, unknown>>(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs: number }
): Promise<T> {
  const result = await runCommand(executable, args, options);
  const text = result.stdout.trim();
  if (!text) throw new Error(`${executable} returned no JSON output`);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${executable} returned invalid JSON: ${String(error)}; output=${text.slice(0, 1_000)}`);
  }
}
