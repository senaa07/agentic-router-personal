import type { AgentId, AgentInfo } from "commons/types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import type { AgentAdapter } from "./types";

export type * from "./types";
export { createPolicy, realPath, unsafeWorkspace } from "./policy";

// Every agent a session can run on. Adding one = writing its adapter and listing it here.
const adapters: Record<AgentId, AgentAdapter> = {
    claude: claudeAdapter,
    codex: codexAdapter,
    cursor: cursorAdapter,
};

export function getAdapter(id: AgentId): AgentAdapter {
    return adapters[id];
}

// For the "New session" picker
export async function listAgents(): Promise<AgentInfo[]> {
    return Promise.all(
        Object.values(adapters).map(async (a) => {
            const availability = await a.available();
            return {
                id: a.id,
                name: a.name,
                available: availability.ok,
                reason: availability.ok ? undefined : availability.reason,
                capabilities: a.capabilities,
            };
        }),
    );
}

// Throws the adapter's reason if it can't run here
export async function requireAvailable(id: AgentId): Promise<AgentAdapter> {
    const adapter = getAdapter(id);
    const availability = await adapter.available();
    if (!availability.ok) throw new Error(availability.reason);
    return adapter;
}
