import { execFile } from "child_process";
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
  options: { env: Record<string, string | undefined> }
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
    const args = [
      "--agent",
      this.agentType,
      input.tmux_target,
      input.prompt,
      String(this.timeoutSeconds)
    ];
    const env: Record<string, string | undefined> = { ...processEnv };
    if (this.meshSocket !== undefined) {
      env.MESH_TMUX_SOCKET = this.meshSocket;
    }

    try {
      const result = await this.run(this.agentSendPath, args, { env });
      if (result.code === 0) {
        return { ok: true, reply: result.stdout.trim() };
      }
      const error = (result.stderr || `exit ${result.code}`).trim();
      return { ok: false, error };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined> }
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: options.env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          code,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : ""
        });
      }
    );
  });
}
