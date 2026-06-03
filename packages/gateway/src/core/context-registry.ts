import { readFile } from "fs/promises";
import { resolve } from "path";
import {
  validateMeshContextRecord,
  type MeshContextRecord
} from "../schema/context.js";

export class ContextRegistry {
  private readonly records: readonly MeshContextRecord[];

  constructor(records: readonly MeshContextRecord[] = []) {
    this.records = records;
  }

  static async fromFile(filePath = resolve("config", "contexts.json")): Promise<ContextRegistry> {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Context registry file must contain a JSON array: ${filePath}`);
    }

    const records = raw.map((record, index) => {
      const result = validateMeshContextRecord(record);
      if (!result.ok) {
        throw new Error(
          `Invalid context registry record at index ${index}: ${result.issues
            .map((issue) => `${issue.path} ${issue.message}`)
            .join("; ")}`
        );
      }
      return result.value!;
    });

    return new ContextRegistry(records);
  }

  list(): readonly MeshContextRecord[] {
    return this.records;
  }

  get(id: string): MeshContextRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  isActive(id: string): boolean {
    return this.get(id)?.status === "active";
  }
}
