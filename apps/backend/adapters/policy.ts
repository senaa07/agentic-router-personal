import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { EditMode, ToolCall, ToolDecision } from "./types";

// Agent-neutral rules every tool call goes through, whichever agent made it:
//  1. sandbox: files outside the workspace can't be changed (or read, except readOnlyRoots)
//  2. edit mode + approvals: what may run on its own and what asks the user first
// Commands (Bash/shell) can't be path-checked; each adapter must also run them in an
// OS sandbox limited to the workspace (Claude: the SDK's `sandbox` option).

// Canonical real path: resolves ~, "..", symlinks and (on macOS) letter case, so none
// of them can be used to escape. A path that doesn't exist yet (a file about to be
// written) is resolved through its nearest existing parent.
export async function realPath(p: string): Promise<string> {
    const abs = resolve(p.replace(/^~(?=$|\/)/, homedir()));
    try {
        return await realpath(abs);
    } catch {
        const parent = dirname(abs);
        return parent === abs
            ? abs
            : join(await realPath(parent), basename(abs));
    }
}

export const isInside = (root: string, p: string) =>
    p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// Folders that must never be a workspace: the agent could change anything below them
export async function unsafeWorkspace(
    path: string,
): Promise<string | undefined> {
    const real = await realPath(path);
    const home = await realPath(homedir());
    if (real === sep) return "The root folder can't be a workspace.";
    if (real === home)
        return "Your home folder can't be a workspace; pick a project folder inside it.";
    if (isInside(home, real) && real.slice(home.length + 1).startsWith("."))
        return "Hidden folders in your home directory (like ~/.ssh or ~/.config) can't be workspaces.";
    if (
        !isInside(home, real) &&
        !real.startsWith("/private/tmp/") &&
        !real.startsWith("/tmp/") &&
        !real.startsWith("/Volumes/")
    )
        return `Workspaces must be inside your home folder (got ${real}).`;
    return undefined;
}

// The checkTool() an adapter's RunContext gets. `ask` shows an approval card and
// resolves to the user's answer.
export function createPolicy(opts: {
    root: string; // canonical workspace path
    readOnlyRoots: string[]; // canonical; readable but never writable
    mode: EditMode;
    trustedServers: Set<string>; // MCP servers whose tools run without asking
    ask(call: ToolCall, signal: AbortSignal): Promise<boolean>;
}) {
    let mode = opts.mode; // a plan approved in "plan" mode switches to "default"
    const deny = (reason: string): ToolDecision => ({
        decision: "deny",
        reason,
    });
    const allow: ToolDecision = { decision: "allow" };
    const askUser = async (call: ToolCall, signal: AbortSignal) =>
        (await opts.ask(call, signal)) ? allow : deny("The user denied this.");

    return async (
        call: ToolCall,
        signal: AbortSignal,
    ): Promise<ToolDecision> => {
        // 1. Sandbox, first: applies in every mode, even to trusted or approved tools
        const writes = call.kind === "edit";
        for (const p of call.paths) {
            // Relative paths are relative to the workspace (the agent's cwd)
            const real = await realPath(
                resolve(opts.root, p.replace(/^~(?=$|\/)/, homedir())),
            );
            if (isInside(opts.root, real)) continue;
            if (!writes && opts.readOnlyRoots.some((r) => isInside(r, real)))
                continue;
            return deny(
                `Blocked: ${real} is outside the workspace (${opts.root}). The agent can only ${writes ? "change" : "read"} files inside it.`,
            );
        }

        // 2. Edit mode
        switch (call.kind) {
            // MCP tools can do anything (send email, write a DB...): ask unless trusted
            case "mcp":
                return opts.trustedServers.has(call.mcpServer ?? "")
                    ? allow
                    : askUser(call, signal);
            case "plan": {
                const decision = await askUser(call, signal);
                // Plan approved: the agent now implements it, asking before each change
                if (decision.decision === "allow") mode = "default";
                return decision;
            }
            case "edit":
                if (mode === "plan")
                    return deny(
                        "Plan mode: no changes until the user approves a plan.",
                    );
                return mode === "acceptEdits" ? allow : askUser(call, signal);
            case "command":
                if (mode === "plan")
                    return deny(
                        "Plan mode: no commands until the user approves a plan.",
                    );
                return askUser(call, signal);
            default:
                return { decision: "pass" };
        }
    };
}
