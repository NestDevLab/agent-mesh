import { execFile } from "child_process";
import { createHash } from "crypto";
import { env as processEnv } from "process";
import type {
  TmuxSendInput,
  TmuxSendResult,
  TmuxSessionSender
} from "./tmux-transport-adapter.js";

export interface ShellRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ShellRun = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; timeoutMs?: number }
) => Promise<ShellRunResult>;

export interface ShellTmuxSenderOptions {
  /** Absolute path to packages/tmux-bridge/bin/agent-send.sh */
  agentSendPath: string;
  /** The --agent value for the bridge (e.g. "codex", "claude"). */
  agentType: string;
  /** Per-send timeout in seconds (default 120). */
  timeoutSeconds?: number;
  /** Dedicated tmux socket; forwarded as MESH_TMUX_SOCKET. */
  meshSocket?: string;
  /** Injected runner (tests provide a fake; defaults to execFile). */
  run?: ShellRun;
}

/**
 * Concrete, host-side TmuxSessionSender that drives the tmux bridge by spawning
 * agent-send.sh. This is the only place the gateway actually shells out, and it
 * is opt-in: the host constructs it and injects it into TmuxTransportAdapter.
 * The adapter itself stays pure.
 */
export class ShellTmuxSender implements TmuxSessionSender {
  private readonly agentSendPath: string;
  private readonly agentType: string;
  private readonly timeoutSeconds: number;
  private readonly meshSocket?: string;
  private readonly run: ShellRun;

  constructor(options: ShellTmuxSenderOptions) {
    this.agentSendPath = options.agentSendPath;
    this.agentType = options.agentType;
    this.timeoutSeconds = options.timeoutSeconds ?? 120;
    this.meshSocket = options.meshSocket;
    this.run = options.run ?? defaultRun;
  }

  async send(input: TmuxSendInput): Promise<TmuxSendResult> {
    const resultToken = input.correlation_id === undefined
      ? undefined
      : createHash("sha256").update(input.correlation_id).digest("hex").slice(0, 16);
    const args = [
      "--agent",
      this.agentType,
      ...(input.correlation_id === undefined ? [] : ["--correlation-id", input.correlation_id]),
      ...(resultToken === undefined ? [] : ["--result-token", resultToken]),
      input.tmux_target,
      input.prompt,
      String(this.timeoutSeconds)
    ];
    const env: Record<string, string | undefined> = { ...processEnv };
    if (this.meshSocket !== undefined) {
      env.MESH_TMUX_SOCKET = this.meshSocket;
    }

    // Hard wall-clock ceiling for the child, slightly above the bridge's own
    // timeout, so a wedged agent-send.sh cannot hang the host indefinitely.
    const timeoutMs = (this.timeoutSeconds + 15) * 1000;

    try {
      const result = await this.run(this.agentSendPath, args, { env, timeoutMs });
      if (result.code === 0) {
        const reply = result.stdout.trim();
        return reply.length === 0
          ? { ok: true, result_error_code: "result_no_output", error: "Agent produced no textual result." }
          : { ok: true, reply };
      }
      const error = (result.stderr || `exit ${result.code}`).trim();
      const resultErrorCode = resultCodeForExit(result.code);
      if (resultErrorCode !== undefined) {
        return { ok: true, result_error_code: resultErrorCode, error };
      }
      return { ok: false, error };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function resultCodeForExit(code: number): TmuxSendResult["result_error_code"] | undefined {
  if (code === 4 || code === 124) return "result_timeout";
  if (code === 65) return "result_no_output";
  if (code === 66) return "result_uncorrelated";
  if (code === 67) return "result_parsing_failure";
  return undefined;
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; timeoutMs?: number }
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: options.env,
        maxBuffer: 10 * 1024 * 1024,
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {})
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        const errorMessage = error instanceof Error ? error.message : "";
        const stderrText = typeof stderr === "string" ? stderr : "";
        resolve({
          code,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: stderrText || errorMessage
        });
      }
    );
  });
}
