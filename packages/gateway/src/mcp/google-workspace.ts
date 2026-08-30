import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 50;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_CONTENT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";

export type GoogleWorkspaceAccountAlias = "work" | "personal";

export interface GoogleWorkspaceAccount {
  account: string;
  client?: string;
}

export interface GoogleWorkspaceRunOptions {
  resultsOnly?: boolean;
}

export interface GoogleWorkspaceRunner {
  run(
    account: GoogleWorkspaceAccountAlias,
    args: readonly string[],
    options?: GoogleWorkspaceRunOptions
  ): Promise<unknown>;
  readFile(
    account: GoogleWorkspaceAccountAlias,
    fileId: string,
    startChar: number,
    maxChars: number
  ): Promise<unknown>;
}

export interface GoogleWorkspaceToolOptions {
  runner: GoogleWorkspaceRunner;
  allowedAccounts: readonly GoogleWorkspaceAccountAlias[];
}

export type GogExecutor = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: true }
) => Promise<{ stdout: string; stderr?: string }>;

interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  size?: string;
}

export class GoogleWorkspaceReadError extends Error {
  readonly code: "oauth_reconnect_required" | "not_found_or_denied" | "too_large" | "read_failed";
  readonly reconnectRequired: boolean;

  constructor(
    message: string,
    code: "oauth_reconnect_required" | "not_found_or_denied" | "too_large" | "read_failed",
    reconnectRequired = false
  ) {
    super(message);
    this.code = code;
    this.reconnectRequired = reconnectRequired;
  }
}

export class GogGoogleWorkspaceRunner implements GoogleWorkspaceRunner {
  private readonly accounts: Readonly<Record<GoogleWorkspaceAccountAlias, GoogleWorkspaceAccount>>;
  private readonly binaryPath: string;
  private readonly pdfTextBinaryPath: string;
  private readonly timeoutMs: number;
  private readonly execute: GogExecutor;

  constructor(
    accounts: Readonly<Record<GoogleWorkspaceAccountAlias, GoogleWorkspaceAccount>>,
    binaryPath = "/usr/local/bin/gog",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execute: GogExecutor = execFileAsync as GogExecutor,
    pdfTextBinaryPath = "/usr/bin/pdftotext"
  ) {
    this.accounts = accounts;
    this.binaryPath = binaryPath;
    this.pdfTextBinaryPath = pdfTextBinaryPath;
    this.timeoutMs = timeoutMs;
    this.execute = execute;
  }

  async run(
    alias: GoogleWorkspaceAccountAlias,
    args: readonly string[],
    options: GoogleWorkspaceRunOptions = {}
  ): Promise<unknown> {
    const commandArgs = [
      ...args,
      "--json",
      ...(options.resultsOnly === false ? [] : ["--results-only"]),
      ...this.accountArgs(alias)
    ];
    try {
      const { stdout } = await this.execute(this.binaryPath, commandArgs, this.execOptions());
      return JSON.parse(stdout);
    } catch (error) {
      throw classifyReadError(error);
    }
  }

  async readFile(
    alias: GoogleWorkspaceAccountAlias,
    fileId: string,
    startChar: number,
    maxChars: number
  ): Promise<unknown> {
    const metadata = asDriveFileMetadata(await this.run(alias, ["drive", "get", fileId]));
    const source = sourceMetadata(alias, metadata);
    if (metadata.mimeType === GOOGLE_FOLDER_MIME) {
      return { ...source, content_type: "folder", content: null, use_tool: "google_drive_list" };
    }
    if (metadata.mimeType === GOOGLE_SHEET_MIME) {
      const sheet = asRecord(await this.run(
        alias,
        ["sheets", "metadata", fileId],
        { resultsOnly: false }
      ));
      return {
        ...source,
        content_type: "spreadsheet_metadata",
        content: {
          title: sheet.title,
          locale: sheet.locale,
          time_zone: sheet.timeZone,
          sheets: Array.isArray(sheet.sheets) ? sheet.sheets : []
        },
        use_tool: "google_sheets_read_range"
      };
    }
    if (metadata.mimeType === GOOGLE_DOC_MIME) {
      const document = await this.run(alias, ["docs", "cat", fileId]);
      const text = typeof document === "string" ? document : String(asRecord(document).text ?? "");
      return pagedContent(source, text, startChar, maxChars, "text/plain");
    }
    if (!isReadableDownload(metadata.mimeType)) {
      return {
        ...source,
        content_type: "unsupported_binary",
        content: null,
        limitation: "This file type is not exposed as text by the read-only connector."
      };
    }
    const declaredSize = Number(metadata.size ?? "0");
    if (Number.isFinite(declaredSize) && declaredSize > MAX_DOWNLOAD_BYTES) {
      throw new GoogleWorkspaceReadError("Google Drive file exceeds the read limit.", "too_large");
    }
    return this.readDownloadedFile(alias, metadata, startChar, maxChars, source);
  }

  private async readDownloadedFile(
    alias: GoogleWorkspaceAccountAlias,
    metadata: DriveFileMetadata,
    startChar: number,
    maxChars: number,
    source: ReturnType<typeof sourceMetadata>
  ): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), "agent-mesh-drive-read-"));
    const destination = join(directory, "content");
    try {
      await this.execute(
        this.binaryPath,
        ["drive", "download", metadata.id, "--out", destination, "--json", ...this.accountArgs(alias)],
        this.execOptions()
      );
      const text = metadata.mimeType === "application/pdf"
        ? (await this.execute(this.pdfTextBinaryPath, [destination, "-"], this.execOptions())).stdout
        : await readFile(destination, "utf8");
      return pagedContent(source, text, startChar, maxChars, metadata.mimeType);
    } catch (error) {
      throw classifyReadError(error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private accountArgs(alias: GoogleWorkspaceAccountAlias): string[] {
    const account = this.accounts[alias];
    if (account === undefined) {
      throw new GoogleWorkspaceReadError("Google Workspace account is not configured.", "read_failed");
    }
    return [
      "--no-input",
      "--account",
      account.account,
      ...(account.client === undefined ? [] : ["--client", account.client])
    ];
  }

  private execOptions() {
    return {
      encoding: "utf8" as const,
      timeout: this.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true as const
    };
  }
}

const accountSchema = z.enum(["work", "personal"]);
const maxResultsSchema = z.number().int().min(1).max(MAX_RESULTS).default(10);
const querySchema = z.string().min(1).max(1_000);
const idSchema = z.string().min(1).max(512);
const pageTokenSchema = z.string().max(4_096).optional();
const dateTimeSchema = z.string().datetime({ offset: true });

export function registerGoogleWorkspaceTools(
  server: McpServer,
  options: GoogleWorkspaceToolOptions
): void {
  const assertAccount = (account: GoogleWorkspaceAccountAlias) => {
    if (!options.allowedAccounts.includes(account)) {
      throw new GoogleWorkspaceReadError(
        "Google Workspace account is not allowed for this principal.",
        "not_found_or_denied"
      );
    }
  };

  server.registerTool(
    "google_drive_search",
    {
      title: "Search Google Drive",
      description: "Searches one allowed Drive and returns source metadata plus a continuation token.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({
        account: accountSchema,
        query: querySchema,
        max_results: maxResultsSchema,
        page_token: pageTokenSchema
      })
    },
    async ({ account, query, max_results, page_token }) => {
      try {
        assertAccount(account);
        const value = await options.runner.run(account, [
          "drive", "search", query, "--max", String(max_results),
          ...(page_token === undefined ? [] : ["--page", page_token])
        ], { resultsOnly: false });
        return result(normalizeDrivePage(account, value));
      } catch (error) {
        return errorResult(error, account);
      }
    }
  );

  server.registerTool(
    "google_drive_read",
    {
      title: "Read a Google Drive file",
      description: "Reads a selected file by ID. Supports Docs, Sheets metadata, PDFs, and text-compatible files.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({
        account: accountSchema,
        file_id: idSchema,
        start_char: z.number().int().min(0).default(0),
        max_chars: z.number().int().min(1_000).max(MAX_CONTENT_CHARS).default(30_000)
      })
    },
    async ({ account, file_id, start_char, max_chars }) => {
      try {
        assertAccount(account);
        return result(await options.runner.readFile(account, file_id, start_char, max_chars));
      } catch (error) {
        return errorResult(error, account);
      }
    }
  );

  server.registerTool(
    "google_drive_list",
    {
      title: "List a Google Drive folder",
      description: "Lists files and folders under a folder ID with bounded pagination.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({
        account: accountSchema,
        folder_id: idSchema.default("root"),
        max_results: maxResultsSchema,
        page_token: pageTokenSchema
      })
    },
    async ({ account, folder_id, max_results, page_token }) => {
      try {
        assertAccount(account);
        const value = await options.runner.run(account, [
          "drive", "ls", "--parent", folder_id, "--max", String(max_results),
          ...(page_token === undefined ? [] : ["--page", page_token])
        ], { resultsOnly: false });
        return result(normalizeDrivePage(account, value, folder_id));
      } catch (error) {
        return errorResult(error, account);
      }
    }
  );

  server.registerTool(
    "google_sheets_metadata",
    {
      title: "Read Google Sheets metadata",
      description: "Lists spreadsheet title, locale, timezone, sheet names, IDs, and grid sizes.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({ account: accountSchema, spreadsheet_id: idSchema })
    },
    async ({ account, spreadsheet_id }) => {
      try {
        assertAccount(account);
        return result(await options.runner.readFile(account, spreadsheet_id, 0, MAX_CONTENT_CHARS));
      } catch (error) {
        return errorResult(error, account);
      }
    }
  );

  server.registerTool(
    "google_sheets_read_range",
    {
      title: "Read a Google Sheets range",
      description: "Reads a bounded A1 range as formatted values, raw values, or formulas.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({
        account: accountSchema,
        spreadsheet_id: idSchema,
        range: z.string().min(1).max(512),
        render: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).default("FORMATTED_VALUE"),
        dimension: z.enum(["ROWS", "COLUMNS"]).default("ROWS")
      })
    },
    async ({ account, spreadsheet_id, range, render, dimension }) => {
      try {
        assertAccount(account);
        const source = asRecord(await options.runner.readFile(
          account,
          spreadsheet_id,
          0,
          MAX_CONTENT_CHARS
        ));
        const values = await options.runner.run(account, [
          "sheets", "get", spreadsheet_id, range, "--render", render, "--dimension", dimension
        ]);
        return result({
          ...source,
          content_type: "google_sheet_range",
          requested_range: range,
          render,
          content: values,
          interpretation_notice: temporalNotice
        });
      } catch (error) {
        return errorResult(error, account);
      }
    }
  );

  server.registerTool(
    "google_gmail_search",
    {
      title: "Search Gmail",
      description: "Searches Gmail threads in the selected account without changing messages or labels.",
      annotations: readOnlyAnnotations,
      inputSchema: z.object({ account: accountSchema, query: querySchema, max_results: maxResultsSchema })
    },
    async ({ account, query, max_results }) => {
      try {
        assertAccount(account);
        return result(await options.runner.run(account, ["gmail", "search", query, "--max", String(max_results)]));
      } catch (error) {
        return errorResult(error, account);
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
        return errorResult(error, account);
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

const temporalNotice =
  "The source modification time establishes when the file changed, not whether every claim is current. Treat dated statements as historical and label any inference explicitly.";

function sourceMetadata(account: GoogleWorkspaceAccountAlias, metadata: DriveFileMetadata) {
  return {
    account,
    source_id: metadata.id,
    source_name: metadata.name,
    source_mime_type: metadata.mimeType,
    modified_time: metadata.modifiedTime ?? null,
    source_link: metadata.webViewLink ?? null,
    parent_ids: metadata.parents ?? [],
    retrieved_at: new Date().toISOString(),
    data_status: "source_record",
    interpretation_notice: temporalNotice
  };
}

function pagedContent(
  source: ReturnType<typeof sourceMetadata>,
  text: string,
  startChar: number,
  maxChars: number,
  contentType: string
) {
  const content = text.slice(startChar, startChar + maxChars);
  const nextStartChar = startChar + content.length;
  return {
    ...source,
    content_type: contentType,
    start_char: startChar,
    end_char: nextStartChar,
    total_chars: text.length,
    has_more: nextStartChar < text.length,
    next_start_char: nextStartChar < text.length ? nextStartChar : null,
    content
  };
}

function normalizeDrivePage(
  account: GoogleWorkspaceAccountAlias,
  value: unknown,
  folderId?: string
) {
  const page = asRecord(value);
  const files = Array.isArray(page.files) ? page.files : [];
  return {
    account,
    ...(folderId === undefined ? {} : { folder_id: folderId }),
    retrieved_at: new Date().toISOString(),
    data_status: "source_metadata",
    files,
    next_page_token: typeof page.nextPageToken === "string" && page.nextPageToken.length > 0
      ? page.nextPageToken
      : null,
    interpretation_notice: temporalNotice
  };
}

function asDriveFileMetadata(value: unknown): DriveFileMetadata {
  const record = asRecord(value);
  if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.mimeType !== "string") {
    throw new GoogleWorkspaceReadError("Google Drive metadata is incomplete.", "read_failed");
  }
  return record as unknown as DriveFileMetadata;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GoogleWorkspaceReadError("Google Workspace returned an unexpected response.", "read_failed");
  }
  return value as Record<string, unknown>;
}

function isReadableDownload(mimeType: string): boolean {
  return mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    ["application/json", "application/xml", "application/csv", "application/rtf"].includes(mimeType);
}

function classifyReadError(error: unknown): GoogleWorkspaceReadError {
  if (error instanceof GoogleWorkspaceReadError) return error;
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const diagnostic = `${String(record.message ?? "")} ${String(record.stderr ?? "")}`.toLowerCase();
  if (/invalid_grant|invalid credentials|token.*expired|unauthorized|re.?auth/.test(diagnostic)) {
    return new GoogleWorkspaceReadError(
      "Google Workspace authorization expired; reconnect the affected account and retry.",
      "oauth_reconnect_required",
      true
    );
  }
  if (/not found|forbidden|permission|access denied|404|403/.test(diagnostic)) {
    return new GoogleWorkspaceReadError(
      "The file was not found in this account or the account is not allowed to read it.",
      "not_found_or_denied"
    );
  }
  return new GoogleWorkspaceReadError("Google Workspace read failed.", "read_failed");
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { results: value }
  };
}

function errorResult(error: unknown, account?: GoogleWorkspaceAccountAlias) {
  const classified = classifyReadError(error);
  const payload = {
    error: classified.message,
    code: classified.code,
    reconnect_required: classified.reconnectRequired,
    ...(account === undefined ? {} : { account })
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true
  };
}
