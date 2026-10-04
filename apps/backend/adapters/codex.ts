import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    Codex,
    type CodexOptions,
    type ThreadEvent,
    type ThreadItem,
    type ThreadOptions,
    type Usage as CodexUsage,
} from "@openai/codex-sdk";
import type { ModelOption, SkillInfo, Usage } from "commons/types";
import { getApiKey } from "../settings";
import { isInside, realPath } from "./policy";
import type { AgentAdapter, RunIntegration, RunResult } from "./types";

// OpenAI Codex, via @openai/codex-sdk (which drives the bundled `codex exec` CLI).
//
// How it differs from Claude, and what that means here:
//  - No per-tool approval: `codex exec` can't ask, and commands/file changes are only
//    reported as events (a file_change after it's applied). So ctx.checkTool can't gate
//    them; safety comes from Codex's own sandbox instead:
//      "acceptEdits" -> sandbox "workspace-write" (writes confined to the workspace)
//      "plan"        -> sandbox "read-only"
//      "default" (ask before each change) is not supported -> capabilities.modes
//    approvalPolicy "never": a command asking to run outside the sandbox is refused, not run.
//  - MCP tools also run without asking, so only integrations marked trusted are passed.
//  - Text arrives per message (item.updated/completed), not token by token.
//  - Usage has tokens but no cost; no turn/budget limits in the SDK.

// ---- The bundled CLI (for models / skills / login status; runs use the SDK) -----------

const PLATFORM_PACKAGES: Record<string, [string, string]> = {
    "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
    "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
    "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
    "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
};

// Same lookup the SDK does: @openai/codex-sdk -> @openai/codex -> its platform package
function findCodexBinary(): string | undefined {
    const platform = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
    if (!platform) return undefined;
    try {
        // The SDK only has an ESM "import" export, so resolve it the ESM way
        const sdk = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
        const codexPkg = createRequire(sdk).resolve(
            "@openai/codex/package.json",
        );
        const platformPkg = createRequire(codexPkg).resolve(
            `${platform[0]}/package.json`,
        );
        const bin = join(
            dirname(platformPkg),
            "vendor",
            platform[1],
            "bin",
            "codex",
        );
        return Bun.file(bin).size > 0 ? bin : undefined;
    } catch {
        return undefined;
    }
}
const CODEX_BIN = findCodexBinary();

// Runs the CLI with the app's OpenAI key (if any) and returns stdout
async function codexCli(args: string[], cwd?: string): Promise<string> {
    if (!CODEX_BIN) throw new Error("The Codex CLI isn't installed.");
    const key = await getApiKey("openai");
    const proc = Bun.spawn([CODEX_BIN, ...args], {
        cwd,
        env: key ? { ...process.env, CODEX_API_KEY: key } : process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0)
        throw new Error(
            `codex ${args[0]} failed: ${err.trim() || `exit ${code}`}`,
        );
    return out;
}

// Stop: the SDK only SIGTERMs `codex`, which exits without killing the commands it
// started (they'd keep running, orphaned). So first kill this run's codex process tree:
// find the codex child of this backend started for `cwd`, then every descendant (PTY
// shells keep codex as their parent). Deepest first, so nothing is left to respawn.
async function killCodexTree(cwd: string) {
    const ps = await Bun.$`ps -Ao pid=,ppid=,command=`.quiet().nothrow();
    const procs = ps.stdout
        .toString()
        .split("\n")
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }));
    const roots = procs.filter(
        (p) =>
            p.ppid === process.pid &&
            !!CODEX_BIN &&
            p.cmd.startsWith(CODEX_BIN) &&
            p.cmd.includes(`--cd ${cwd}`),
    );
    const tree: number[] = [];
    const visit = (pid: number) => {
        for (const child of procs.filter((p) => p.ppid === pid))
            visit(child.pid);
        tree.push(pid);
    };
    roots.forEach((r) => visit(r.pid));
    for (const pid of tree) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {} // already gone
    }
}

// Signed in = an OpenAI key in Settings, or the CLI's own `codex login`
async function signedIn(): Promise<{ ok: boolean; message: string }> {
    if (await getApiKey("openai"))
        return { ok: true, message: "Using the OpenAI API key from Settings." };
    const status = (
        await codexCli(["login", "status"]).catch((e) => String(e))
    ).trim();
    return /logged in/i.test(status) && !/not logged in/i.test(status)
        ? { ok: true, message: `Codex CLI: ${status}` }
        : {
              ok: false,
              message:
                  "Not signed in to Codex. Add an OpenAI API key in Settings, or run `codex login` in a terminal.",
          };
}

// ---- Models (from the CLI's catalog) --------------------------------------------------

type CatalogModel = {
    slug: string;
    display_name?: string;
    description?: string;
    visibility?: string;
    priority?: number;
    context_window?: number;
};
let catalog: Promise<CatalogModel[]> | null = null;
let catalogForKey: string | undefined;

async function loadCatalog(): Promise<CatalogModel[]> {
    const key = await getApiKey("openai");
    if (key !== catalogForKey) {
        catalog = null;
        catalogForKey = key;
    }
    catalog ??= codexCli(["debug", "models"])
        .then((out) => (JSON.parse(out).models ?? []) as CatalogModel[])
        .catch((e) => {
            catalog = null;
            throw e;
        });
    return catalog;
}

// ---- MCP servers -> Codex config ----------------------------------------------------

// Codex reads MCP servers from config (`mcp_servers.<name>`). It can't ask before an MCP
// tool runs, so only servers the user marked trusted are passed; plugins are Claude-only.
function toCodexMcp(integrations: RunIntegration[]) {
    const servers: NonNullable<CodexOptions["config"]> = {};
    const skipped: string[] = [];
    for (const { name, trusted, config: c } of integrations) {
        if (c.kind === "plugin") continue;
        if (!trusted) {
            skipped.push(name);
            continue;
        }
        servers[name] =
            c.kind === "stdio"
                ? { command: c.command, args: c.args, env: c.env ?? {} }
                : { url: c.url, http_headers: c.headers ?? {} };
    }
    return { servers, skipped };
}

// ---- Usage -----------------------------------------------------------------------------

function toUsage(
    u: CodexUsage,
    model: CatalogModel | undefined,
    durationMs: number,
): Usage {
    return {
        durationMs,
        durationApiMs: durationMs, // the SDK doesn't separate API time
        numTurns: 1, // one Codex turn per message
        // input_tokens includes cached/cache-write tokens; ours is the uncached part
        inputTokens: Math.max(
            0,
            u.input_tokens -
                u.cached_input_tokens -
                (u.cache_write_input_tokens ?? 0),
        ),
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cached_input_tokens,
        cacheCreationTokens: u.cache_write_input_tokens ?? 0,
        model: model?.slug,
        contextWindow: model?.context_window,
        // costUsd / contextTokens: not reported by Codex
    };
}

const MODES: AgentAdapter["capabilities"]["modes"] = ["acceptEdits", "plan"];
const byPriority = (a: CatalogModel, b: CatalogModel) =>
    (a.priority ?? 99) - (b.priority ?? 99);

export const codexAdapter: AgentAdapter = {
    id: "codex",
    name: "Codex",
    capabilities: {
        skills: true,
        skillFilter: false, // Codex always loads all discovered skills
        integrations: true,
        modes: MODES,
    },
    // Codex reads skills from <repo>/.agents/skills (also .codex/skills and $CODEX_HOME/skills)
    skillDir: (cwd, name) => join(cwd, ".agents", "skills", name),

    async available() {
        if (!CODEX_BIN)
            return {
                ok: false,
                reason: "The Codex CLI isn't installed (bun add @openai/codex-sdk in apps/backend).",
            };
        const auth = await signedIn();
        return auth.ok ? { ok: true } : { ok: false, reason: auth.message };
    },

    account: signedIn,

    async listModels(): Promise<ModelOption[]> {
        return (await loadCatalog())
            .filter((m) => m.visibility === "list")
            .sort(byPriority)
            .map((m) => ({
                value: m.slug,
                displayName: m.display_name ?? m.slug,
                description: m.description ?? "",
            }));
    },

    // What Codex lists to the model as available skills, for this folder
    async listCommands(cwd): Promise<SkillInfo[]> {
        const out = await codexCli(
            ["debug", "prompt-input", "list skills"],
            cwd,
        );
        // The dump is the model's input as JSON; the skills are one text block in it
        const texts: string[] = [];
        const walk = (v: unknown) => {
            if (typeof v === "string") texts.push(v);
            else if (v && typeof v === "object") Object.values(v).forEach(walk);
        };
        walk(JSON.parse(out));
        const text = texts.find((t) => t.includes("<skills_instructions>"));
        if (!text) return [];
        const block = text.slice(
            text.indexOf("<skills_instructions>"),
            text.indexOf("</skills_instructions>"),
        );
        // Lines like: "- name: description (file: r0/name/SKILL.md)"
        return block
            .split("\n")
            .map((l) =>
                /^- ([^:]+): (.*?)(?: \(file: [^)]*\))?$/.exec(l.trim()),
            )
            .filter((m): m is RegExpExecArray => !!m)
            .map((m) => ({ name: m[1]!.trim(), description: m[2]!.trim() }))
            .sort((a, b) => a.name.localeCompare(b.name));
    },

    // Codex has no "test this server" API. A stdio server needs its command; URLs are probed.
    async test(integration) {
        const c = integration.config;
        if (c.kind === "plugin")
            return {
                ok: false,
                status: "unsupported",
                error: "Plugins are Claude-only.",
            };
        if (c.kind === "stdio")
            return Bun.which(c.command)
                ? { ok: true, status: "command found" }
                : {
                      ok: false,
                      status: "failed",
                      error: `Command not found: ${c.command}`,
                  };
        try {
            const res = await fetch(c.url, {
                headers: c.headers,
                signal: AbortSignal.timeout(8000),
            });
            return {
                ok: res.status < 500,
                status: `reachable (HTTP ${res.status})`,
            };
        } catch (e) {
            return {
                ok: false,
                status: "failed",
                error: e instanceof Error ? e.message : String(e),
            };
        }
    },

    readOnlyPaths: () => [],

    async run(ctx): Promise<RunResult> {
        const started = Date.now();
        if (!MODES.includes(ctx.mode)) {
            return {
                type: "error",
                message:
                    "Codex can't ask before each change. Switch the edit mode to Auto-accept edits (sandboxed to the workspace) or Plan only (read-only).",
            };
        }
        const { servers, skipped } = toCodexMcp(ctx.integrations);
        const apiKey = await getApiKey("openai");
        const codex = new Codex({
            apiKey, // undefined -> the CLI's own `codex login`
            // OPENAI_BASE_URL lets tests and proxies point Codex elsewhere
            baseUrl: process.env.OPENAI_BASE_URL,
            config: Object.keys(servers).length
                ? { mcp_servers: servers }
                : undefined,
        });
        const options: ThreadOptions = {
            model: ctx.model,
            workingDirectory: ctx.cwd,
            // Workspaces needn't be git repos; the sandbox below is what keeps them safe
            skipGitRepoCheck: true,
            sandboxMode: ctx.mode === "plan" ? "read-only" : "workspace-write",
            approvalPolicy: "never",
        };
        const thread = ctx.resume
            ? codex.resumeThread(ctx.resume, options)
            : codex.startThread(options);

        // Text per agent_message item; item.updated may resend a growing text, so only the
        // new part is streamed
        const reported = new Set<string>(); // item ids already shown as tool use
        const sentLength = new Map<string, number>();
        let finalText = "";
        let wrote = false;
        let usage: CodexUsage | null = null;
        let failure: string | undefined;
        const warnings: string[] = [];
        const notes = skipped.length
            ? `_Skipped MCP servers not marked trusted (Codex can't ask before using them): ${skipped.join(", ")}._\n\n`
            : "";
        if (notes) ctx.onText(notes);

        const onItem = async (
            item: ThreadItem,
            phase: "started" | "updated" | "completed",
        ) => {
            switch (item.type) {
                case "agent_message": {
                    const already = sentLength.get(item.id);
                    if (already === undefined && wrote) ctx.onText("\n\n"); // a new message
                    const from = already ?? 0;
                    if (item.text.length > from) {
                        ctx.onText(item.text.slice(from));
                        wrote = true;
                    }
                    sentLength.set(item.id, item.text.length);
                    if (phase === "completed") finalText = item.text; // the last one is the reply
                    break;
                }
                case "command_execution":
                    if (phase === "started")
                        ctx.onToolUse({ name: "Shell", file: item.command });
                    break;
                case "file_change":
                    // Codex sends it on item.started and again on item.completed: report once
                    if (!reported.has(item.id)) {
                        reported.add(item.id);
                        for (const change of item.changes)
                            ctx.onToolUse({
                                name:
                                    change.kind === "add"
                                        ? "Write"
                                        : change.kind === "delete"
                                          ? "Delete"
                                          : "Edit",
                                file: change.path,
                            });
                    }
                    // Once applied: the sandbox confines writes to the workspace; this re-checks
                    // it, so an escape would at least be caught and the run stopped
                    if (phase === "completed")
                        for (const change of item.changes) {
                            const real = await realPath(
                                resolve(ctx.cwd, change.path),
                            );
                            if (!isInside(ctx.cwd, real))
                                failure = `Codex changed a file outside the workspace (${real}); the run was stopped.`;
                        }
                    break;
                case "mcp_tool_call":
                    if (phase === "started")
                        ctx.onToolUse({
                            name: `mcp__${item.server}__${item.tool}`,
                        });
                    break;
                case "web_search":
                    if (phase === "started")
                        ctx.onToolUse({ name: "WebSearch", file: item.query });
                    break;
                case "error":
                    if (phase === "completed") warnings.push(item.message);
                    break;
                // reasoning, todo_list: progress detail, not part of the reply
            }
        };

        try {
            // The SDK gets its own signal, aborted only after the process tree is killed
            const sdkAbort = new AbortController();
            ctx.signal.addEventListener(
                "abort",
                () => {
                    killCodexTree(ctx.cwd)
                        .catch((e) =>
                            console.error(
                                "Couldn't kill Codex's processes:",
                                e,
                            ),
                        )
                        .finally(() => sdkAbort.abort());
                },
                { once: true },
            );
            const { events } = await thread.runStreamed(ctx.prompt, {
                signal: sdkAbort.signal,
            });
            for await (const event of events as AsyncGenerator<ThreadEvent>) {
                if (event.type === "thread.started") {
                    if (!ctx.resume) ctx.onSession(event.thread_id);
                } else if (
                    event.type === "item.started" ||
                    event.type === "item.updated" ||
                    event.type === "item.completed"
                ) {
                    await onItem(
                        event.item,
                        event.type.slice(5) as
                            "started" | "updated" | "completed",
                    );
                    if (failure) break;
                } else if (event.type === "turn.completed") {
                    usage = event.usage;
                } else if (event.type === "turn.failed") {
                    failure = event.error.message;
                } else if (event.type === "error") {
                    // Not fatal by itself (e.g. "Reconnecting... 2/5"); turn.failed is
                    warnings.push(event.message);
                }
            }
        } catch (e) {
            if (ctx.signal.aborted) return { type: "stopped", message: "" };
            console.error("Codex run failed:", e);
            const reason = (e instanceof Error ? e.message : String(e)).split(
                "\n",
            )[0];
            return { type: "error", message: `Codex crashed: ${reason}` };
        }
        if (ctx.signal.aborted) return { type: "stopped", message: "" };

        // The model used: the chosen one, else Codex's default (the catalog's first)
        const models = await loadCatalog().catch(() => [] as CatalogModel[]);
        const model =
            models.find((m) => m.slug === ctx.model) ??
            [...models].sort(byPriority)[0];
        const u = usage
            ? toUsage(usage, model, Date.now() - started)
            : undefined;
        if (failure) {
            const extra = warnings.length ? `\n\n${warnings.at(-1)}` : "";
            return { type: "error", message: `${failure}${extra}`, usage: u };
        }
        if (!finalText)
            return {
                type: "error",
                message: warnings.at(-1) ?? "Codex finished without a reply.",
                usage: u,
            };
        return { type: "result", message: notes + finalText, usage: u };
    },
};
