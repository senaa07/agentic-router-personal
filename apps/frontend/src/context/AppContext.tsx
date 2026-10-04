import type {
    AgentId,
    AgentInfo,
    ClientSettings,
    Integration,
    ModelOption,
    ProviderId,
    SkillInfo,
    UpdateSettingsSchemaType,
    Workspace,
} from "commons/types";
import { createContext } from "react";

// A provider's latest Verify result, or "pending" while it runs
export type ProviderCheck = { ok: boolean; message: string } | "pending";

export const AppContext = createContext<{
    workspaces: Workspace[];
    socket: WebSocket | null;
    setWorkspaces: any;
    integrations: Integration[];
    // Latest "skills" reply per session (undefined until loaded)
    skillLists: Record<string, SkillInfo[]>;
    agents: AgentInfo[]; // for the New session picker
    models: Partial<Record<AgentId, ModelOption[]>>;
    settings: ClientSettings | null;
    saveSettings: (
        patch: UpdateSettingsSchemaType,
        local?: (s: ClientSettings) => ClientSettings,
    ) => void;
    providerChecks: Partial<Record<ProviderId, ProviderCheck>>;
    setProviderChecks: (
        f: (
            c: Partial<Record<ProviderId, ProviderCheck>>,
        ) => Partial<Record<ProviderId, ProviderCheck>>,
    ) => void;
}>({
    workspaces: [],
    socket: null,
    setWorkspaces: () => {},
    integrations: [],
    skillLists: {},
    agents: [],
    models: {},
    settings: null,
    saveSettings: () => {},
    providerChecks: {},
    setProviderChecks: () => {},
});
