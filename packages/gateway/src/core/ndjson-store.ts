import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const SCHEMA_VERSION = "agent-mesh.store-event.v1";

export interface StoreClock {
  now(): Date;
}

export interface StoreEventEnvelope<T extends Record<string, unknown>> {
  event_id: string;
  event_type: string;
  schema_version: string;
  created_at: string;
  data: T;
}

export interface ReplayWarning {
  file_path: string;
  line_number: number;
  reason: "corrupt_ndjson_line";
  quarantined_path?: string;
  ignored: true;
}

export interface ReplayResult<T extends Record<string, unknown>> {
  records: StoreEventEnvelope<T>[];
  warnings: ReplayWarning[];
}

export function defaultAgentMeshStateDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), "..", "..", "var", "agent-mesh");
}

export function stateFilePath(fileName: string, stateDir = defaultAgentMeshStateDir()): string {
  return join(stateDir, fileName);
}

export function newEventId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function isoNow(clock?: StoreClock): string {
  return (clock?.now() ?? new Date()).toISOString();
}

export async function appendStoreEvent<T extends Record<string, unknown>>(
  filePath: string,
  eventType: string,
  data: T,
  options: { eventId?: string; clock?: StoreClock } = {}
): Promise<StoreEventEnvelope<T>> {
  const event: StoreEventEnvelope<T> = {
    event_id: options.eventId ?? newEventId("evt"),
    event_type: eventType,
    schema_version: SCHEMA_VERSION,
    created_at: isoNow(options.clock),
    data
  };

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  return event;
}

export async function replayStoreEvents<T extends Record<string, unknown>>(
  filePath: string,
  options: { quarantineCorruptFinalLine?: boolean } = {}
): Promise<ReplayResult<T>> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return { records: [], warnings: [] };
    }
    throw error;
  }

  if (raw.length === 0) {
    return { records: [], warnings: [] };
  }

  const lines = raw.split("\n");
  const hasTrailingNewline = raw.endsWith("\n");
  const parseableLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
  const records: StoreEventEnvelope<T>[] = [];
  const warnings: ReplayWarning[] = [];

  for (let index = 0; index < parseableLines.length; index += 1) {
    const line = parseableLines[index];
    if (line.trim().length === 0) {
      continue;
    }

    try {
      records.push(JSON.parse(line) as StoreEventEnvelope<T>);
    } catch {
      const isFinalLine = index === parseableLines.length - 1;
      const warning: ReplayWarning = {
        file_path: filePath,
        line_number: index + 1,
        reason: "corrupt_ndjson_line",
        ignored: true
      };

      if (isFinalLine && options.quarantineCorruptFinalLine) {
        const quarantinePath = `${filePath}.corrupt-final-line`;
        const cleanContent = `${parseableLines.slice(0, index).join("\n")}\n`;
        await writeFile(quarantinePath, line, "utf8");
        await writeFile(filePath, cleanContent, "utf8");
        warning.quarantined_path = quarantinePath;
      }

      warnings.push(warning);
    }
  }

  return { records, warnings };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function canonicalInputHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function moveFileIfExists(from: string, to: string): Promise<boolean> {
  try {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = sortForCanonicalJson(record[key]);
      return accumulator;
    }, {});
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
