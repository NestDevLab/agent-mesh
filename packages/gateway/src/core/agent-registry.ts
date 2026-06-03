import { readFile } from "fs/promises";
import { resolve } from "path";
import { validateMeshAgentRecord, type MeshAgentRecord } from "../schema/agent.js";

export class AgentRegistry {
  private readonly records: readonly MeshAgentRecord[];

  constructor(records: readonly MeshAgentRecord[] = []) {
    this.records = records;
  }

  static async fromFile(filePath = resolve("config", "agents.json")): Promise<AgentRegistry> {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Agent registry file must contain a JSON array: ${filePath}`);
    }

    const records = raw.map((record, index) => {
      const result = validateMeshAgentRecord(record);
      if (!result.ok) {
        throw new Error(
          `Invalid agent registry record at index ${index}: ${result.issues
            .map((issue) => `${issue.path} ${issue.message}`)
            .join("; ")}`
        );
      }
      return result.value!;
    });

    return new AgentRegistry(records);
  }

  list(): readonly MeshAgentRecord[] {
    return this.records;
  }

  get(id: string): MeshAgentRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  isPhase1Enabled(id: string): boolean {
    const agent = this.get(id);
    return agent !== undefined && agent.phase_1_active && agent.status !== "offline";
  }

  isEnabledForContext(id: string, contextId: string, workspaceId: string): boolean {
    const agent = this.get(id);
    if (agent === undefined || agent.enabled_contexts === undefined) {
      return true;
    }

    return (
      agent.enabled_contexts.includes(contextId) ||
      agent.enabled_contexts.includes(workspaceId)
    );
  }
}
