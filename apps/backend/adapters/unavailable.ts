import type { AgentId } from "commons/types";
import type { AgentAdapter } from "./types";

// An agent that's registered (so the picker can show it) but can't run yet.
// Every method refuses with the same reason instead of half-working.
export function unavailableAdapter(opts: {
    id: AgentId;
    name: string;
    cli: string; // binary the real adapter will drive
    install: string; // how to install it
}): AgentAdapter {
    const reason = () =>
        Bun.which(opts.cli)
            ? `${opts.name} support isn't implemented yet.`
            : `${opts.name} support isn't implemented yet (and the ${opts.cli} CLI isn't installed: ${opts.install}).`;
    return {
        id: opts.id,
        name: opts.name,
        capabilities: {
            skills: false,
            skillFilter: false,
            integrations: false,
            modes: [],
        },
        skillDir: () => {
            throw new Error(reason());
        },
        available: async () => ({ ok: false, reason: reason() }),
        run: async () => ({ type: "error", message: reason() }),
        listModels: async () => [],
        listCommands: async () => [],
        test: async () => ({
            ok: false,
            status: "unsupported",
            error: reason(),
        }),
        readOnlyPaths: () => [],
    };
}
