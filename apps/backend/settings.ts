import type {
    AgentId,
    ClientSettings,
    ProviderId,
    UpdateSettingsSchemaType,
} from "commons/types";
import { SettingsModel } from "db/client";

type Settings = Omit<ClientSettings, "providers"> & {
    apiKeys: Partial<Record<ProviderId, string>>;
};

type VerifyResult = { ok: boolean; message: string };

// Checks a key against the provider's model list: authenticated, but uses no tokens
async function verifyByListingModels(
    provider: string,
    url: string,
    headers: Record<string, string>,
): Promise<VerifyResult> {
    try {
        const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(10_000),
        });
        if (res.ok)
            return { ok: true, message: `${provider} accepted the key.` };
        if (res.status === 401 || res.status === 403)
            return {
                ok: false,
                message: `${provider} rejected the key (invalid or revoked).`,
            };
        return { ok: false, message: `${provider} answered ${res.status}.` };
    } catch (e) {
        return {
            ok: false,
            message: `Couldn't reach ${provider}: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
}

// Where each agent's credentials come from
export const PROVIDERS: Record<
    ProviderId,
    {
        name: string;
        agents: AgentId[];
        note: string;
        verifyKey?: (key: string) => Promise<VerifyResult>;
    }
> = {
    anthropic: {
        name: "Anthropic",
        agents: ["claude"],
        note: "Optional. Without a key, Claude uses your Claude Code login (e.g. a Claude subscription).",
        verifyKey: (key) =>
            verifyByListingModels(
                "Anthropic",
                "https://api.anthropic.com/v1/models?limit=1",
                { "x-api-key": key, "anthropic-version": "2023-06-01" },
            ),
    },
    openai: {
        name: "OpenAI",
        agents: ["codex"],
        note: "Used by Codex once its adapter is implemented.",
        verifyKey: (key) =>
            verifyByListingModels(
                "OpenAI",
                "https://api.openai.com/v1/models",
                {
                    Authorization: `Bearer ${key}`,
                },
            ),
    },
    cursor: {
        name: "Cursor",
        agents: ["cursor"],
        note: "Used by Cursor once its adapter is implemented. It can't be verified from here yet.",
    },
};

// Missing fields (older documents) get their defaults
function normalize(doc: any): Settings {
    return {
        profile: { name: doc?.profile?.name ?? "" },
        theme: doc?.theme ?? "system",
        defaults: {
            agent: doc?.defaults?.agent ?? "claude",
            mode: doc?.defaults?.mode ?? "default",
            models: doc?.defaults?.models ?? {},
        },
        limits: {
            maxTurns: doc?.limits?.maxTurns ?? null,
            maxBudgetUsd: doc?.limits?.maxBudgetUsd ?? null,
        },
        apiKeys: doc?.apiKeys ?? {},
    };
}

// Cached: read on every run and every connection. A failed read is retried next time.
let cache: Promise<Settings> | null = null;

export function getSettings(): Promise<Settings> {
    cache ??= SettingsModel.findOneAndUpdate(
        { _id: "app" },
        { $setOnInsert: { _id: "app" } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    )
        .lean()
        .then(normalize)
        .catch((e) => {
            cache = null;
            throw e;
        });
    return cache;
}

export async function getApiKey(
    provider: ProviderId,
): Promise<string | undefined> {
    return (await getSettings()).apiKeys[provider] || undefined;
}

// Applies a partial update: only the fields present change
export async function updateSettings(
    patch: UpdateSettingsSchemaType,
): Promise<Settings> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};
    if (patch.profile) $set["profile.name"] = patch.profile.name;
    if (patch.theme) $set.theme = patch.theme;
    if (patch.defaults?.agent) $set["defaults.agent"] = patch.defaults.agent;
    if (patch.defaults?.mode) $set["defaults.mode"] = patch.defaults.mode;
    for (const [agent, model] of Object.entries(patch.defaults?.models ?? {}))
        $set[`defaults.models.${agent}`] = model;
    if (patch.limits?.maxTurns !== undefined)
        $set["limits.maxTurns"] = patch.limits.maxTurns;
    if (patch.limits?.maxBudgetUsd !== undefined)
        $set["limits.maxBudgetUsd"] = patch.limits.maxBudgetUsd;
    for (const [provider, key] of Object.entries(patch.apiKeys ?? {})) {
        if (key === null) $unset[`apiKeys.${provider}`] = "";
        else $set[`apiKeys.${provider}`] = key;
    }

    const doc = await SettingsModel.findOneAndUpdate(
        { _id: "app" },
        { $set, $unset },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    const settings = normalize(doc);
    cache = Promise.resolve(settings);
    return settings;
}

export function toClientSettings(s: Settings): ClientSettings {
    const { apiKeys, ...rest } = s;
    return {
        ...rest,
        providers: (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
            const key = apiKeys[id];
            return {
                id,
                name: PROVIDERS[id].name,
                agents: PROVIDERS[id].agents,
                keySet: !!key,
                // Never the key itself: just enough to recognize which one is saved
                keyHint: key ? `…${key.slice(-4)}` : undefined,
                note: PROVIDERS[id].note,
            };
        }),
    };
}
