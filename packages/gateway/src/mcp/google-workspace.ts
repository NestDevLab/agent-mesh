import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 50;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export type GoogleWorkspaceAccountAlias = "work" | "personal";

export interface GoogleWorkspaceAccount {
  account: string;
  client?: string;
}

export interface GoogleWorkspaceRunner {
  run(account: GoogleWorkspaceAccountAlias, args: readonly string[]): Promise<unknown>;
}

export interface GoogleWorkspaceToolOptions {
  runner: GoogleWorkspaceRunner;
  allowedAccounts: readonly GoogleWorkspaceAccountAlias[];
}

export type GogExecutor = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: true }
) => Promise<{ stdout: string }>;

export class GogGoogleWorkspaceRunner implements GoogleWorkspaceRunner {
  private readonly accounts: Readonly<Record<GoogleWorkspaceAccountAlias, GoogleWorkspaceAccount>>;
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private readonly execute: GogExecutor;

  constructor(
    accounts: Readonly<Record<GoogleWorkspaceAccountAlias, GoogleWorkspaceAccount>>,
    binaryPath = "/usr/local/bin/gog",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execute: GogExecutor = execFileAsync as GogExecutor
  ) {
    this.accounts = accounts;
    this.binaryPath = binaryPath;
    this.timeoutMs = timeoutMs;
    this.execute = execute;
  }

  async run(alias: GoogleWorkspaceAccountAlias, args: readonly string[]): Promise<unknown> {
    const account = this.accounts[alias];
    if (account === undefined) throw new Error("Google Workspace account is not configured.");
    const commandArgs = [
      ...args,
      "--json",
      "--results-only",
      "--no-input",
      "--account",
      account.account,
      ...(account.client === undefined ? [] : ["--client", account.client])
    ];
    try {
      const { stdout } = await this.execute(this.binaryPath, commandArgs, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true
      });
      return JSON.parse(stdout);
    } catch {
      throw new Error("Google Workspace read failed.");
    }
  }
}

const accountSchema = z.enum(["work", "personal"]);
const maxResultsSchema = z.number().int().min(1).max(MAX_RESULTS).default(10);
const querySchema = z.string().min(1).max(1_000);
const dateTimeSchema = z.string().datetime({ offset: true });

export function registerGoogleWorkspaceTools(
  server: McpServer,
  options: GoogleWorkspaceToolOptions
): void {
  const assertAccount = (account: GoogleWorkspaceAccountAlias) => {
    if (!options.allowedAccounts.includes(account)) {
      throw new Error("Google Workspace account is not allowed for this principal.");
    }
  };

  server.registerTool(
    "google_drive_search",
    {
      title: "Search Google Drive",
      description: "Searches the selected Google Drive account without changing files.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({
        account: accountSchema,
        query: querySchema,
        max_results: maxResultsSchema
      })
    },
    async ({ account, query, max_results }) => {
      try {
        assertAccount(account);
        return result(await options.runner.run(account, ["drive", "search", query, "--max", String(max_results)]));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "google_gmail_search",
    {
      title: "Search Gmail",
      description: "Searches Gmail threads in the selected account without changing messages or labels.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({
        account: accountSchema,
        query: querySchema,
        max_results: maxResultsSchema
      })
    },
    async ({ account, query, max_results }) => {
      try {
        assertAccount(account);
        return result(await options.runner.run(account, ["gmail", "search", query, "--max", String(max_results)]));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "google_calendar_events",
    {
      title: "Read Google Calendar events",
      description: "Lists events in a bounded time range without changing calendars.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({
        account: accountSchema,
        calendar_id: z.string().min(1).max(512).default("primary"),
        from: dateTimeSchema,
        to: dateTimeSchema,
        max_results: maxResultsSchema
      })
    },
    async ({ account, calendar_id, from, to, max_results }) => {
      try {
        assertAccount(account);
        if (Date.parse(from) >= Date.parse(to)) throw new Error("Calendar 'from' must be before 'to'.");
        return result(await options.runner.run(account, [
          "calendar", "events", calendar_id, "--from", from, "--to", to, "--max", String(max_results)
        ]));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { results: value }
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "Google Workspace read failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
