import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
    query,
    type McpServerConfig,
    type Options,
    type Query,
    type SdkPluginConfig,
    type SDKAssistantMessage,
    type SDKResultMessage,
    type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption, Usage } from "commons/types";
import { getApiKey } from "../settings";
import type {
    AgentAdapter,
    RunIntegration,
    RunResult,
    ToolCall,
} from "./types";

// Claude Code, via the Claude Agent SDK. The only file that calls query().

// Bash runs in the SDK's OS sandbox (Seatbelt on macOS): commands can only write inside
// the workspace, and can't read these credential folders
const SANDBOX = {
    enabled: true,
    // No sandbox on this machine -> the run fails, rather than running unconfined
    failIfUnavailable: true,
    // The agent can't ask to run a command outside the sandbox
    allowUnsandboxedCommands: false,
    filesystem: {
        denyRead: [
            "~/.ssh",
            "~/.aws",
            "~/.gnupg",
            "~/.kube",
            "~/.docker",
            "~/.config/gh",
        ],
    },
};

// The CLI's environment. With an Anthropic key in Settings it's used instead of the
// Claude Code login. `env` REPLACES the process environment, hence the spread.
async function claudeEnv(): Promise<Options["env"]> {
    const key = await getApiKey("anthropic");
    return key ? { ...process.env, ANTHROPIC_API_KEY: key } : undefined;
}

// Runs fn against a CLI session that never gets a prompt, so there's no API call:
// used to read models, skills, MCP status and the account. The session is always closed.
async function withIdleQuery<T>(
    options: Options,
    fn: (q: Query) => Promise<T>,
): Promise<T> {
    const idle: AsyncIterable<SDKUserMessage> = {
        async *[Symbol.asyncIterator]() {
            await new Promise(() => {});
        },
    };
    const q = query({
        prompt: idle,
        options: { env: await claudeEnv(), ...options },
    });
    try {
        return await fn(q);
    } finally {
        q.close();
    }
}

// SDK options for a session's integrations. They're added on top of the user's own
// ~/.claude servers and plugins (the SDK still loads settings files).
function toSdkOptions(integrations: RunIntegration[]) {
    const mcpServers: Record<string, McpServerConfig> = {};
    const plugins: SdkPluginConfig[] = [];
    for (const { name, config: c } of integrations) {
        if (c.kind === "plugin") {
            plugins.push({ type: "local", path: c.path });
        } else if (c.kind === "stdio") {
            mcpServers[name] = {
                type: "stdio",
                command: c.command,
                args: c.args,
                // ?? {}: records saved before the schema kept empty objects
                env: c.env ?? {},
            };
        } else {
            mcpServers[name] = {
                type: c.kind,
                url: c.url,
                headers: c.headers ?? {},
            };
        }
    }
    return { mcpServers, plugins };
}

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const READ_TOOLS = ["Read", "Glob", "Grep", "LS"];

// Claude's tool call -> the neutral ToolCall the policy and approval cards use
function toToolCall(name: string, input: Record<string, unknown>): ToolCall {
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const lines = (prefix: string, v: unknown) =>
        (str(v) ?? "")
            .split("\n")
            .map((l) => prefix + l)
            .join("\n");
    const truncate = (s?: string) =>
        s && s.length > 2000 ? s.slice(0, 2000) + "\n…" : s;

    // Paths it reads or writes. Glob's pattern can itself be absolute ("/etc/**").
    const paths = [
        str(input.file_path),
        str(input.notebook_path),
        str(input.path),
    ].filter((p): p is string => !!p);
    if (name === "Glob") {
        const pattern = str(input.pattern);
        // The fixed part of an absolute pattern: "/etc/**/*.conf" -> "/etc"
        if (pattern && /^[~/]/.test(pattern))
            paths.push(
                pattern.split(/[*?[{]/)[0]!.replace(/\/[^/]*$/, "") || "/",
            );
    }

    const base = { name, file: paths[0] };
    if (EDIT_TOOLS.includes(name))
        return {
            ...base,
            kind: "edit",
            paths,
            detail: truncate(
                name === "Edit"
                    ? `${lines("- ", input.old_string)}\n${lines("+ ", input.new_string)}`
                    : (str(input.content) ?? JSON.stringify(input, null, 2)),
            ),
        };
    if (READ_TOOLS.includes(name)) return { ...base, kind: "read", paths };
    if (name === "Bash")
        return {
            ...base,
            kind: "command",
            paths: [],
            detail: truncate(str(input.command)),
        };
    if (name === "ExitPlanMode")
        return {
            ...base,
            kind: "plan",
            paths: [],
            detail: truncate(str(input.plan)),
        };
    const detail = truncate(JSON.stringify(input, null, 2));
    // MCP tools are named mcp__<server>__<tool>
    if (name.startsWith("mcp__"))
        return {
            ...base,
            kind: "mcp",
            paths: [],
            mcpServer: name.slice(5).split("__")[0],
            detail,
        };
    return { ...base, kind: "other", paths: [], detail };
}

function toUsage(
    result: SDKResultMessage,
    lastCall: SDKAssistantMessage["message"] | undefined,
): Usage {
    const u = result.usage;
    // modelUsage is keyed by model; prefer the main thread's model, else the first entry
    const model = lastCall?.model;
    const modelInfo =
        (model && result.modelUsage[model]) ||
        Object.values(result.modelUsage)[0];
    const last = lastCall?.usage;
    return {
        durationMs: result.duration_ms,
        durationApiMs: result.duration_api_ms,
        numTurns: result.num_turns,
        costUsd: result.total_cost_usd,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        model,
        // Prompt size of the last call. Its output_tokens isn't used: the assistant event
        // carries the stream-start snapshot, where output is still ~1
        contextTokens: last
            ? last.input_tokens +
              (last.cache_creation_input_tokens ?? 0) +
              (last.cache_read_input_tokens ?? 0)
            : undefined,
        contextWindow: modelInfo?.contextWindow,
    };
}

// The SDK's model list. Fetched once and cached; a failed fetch is retried on the next call.
// Keyed by the API key in use: which models are offered depends on the account.
let modelsPromise: Promise<ModelOption[]> | null = null;
let modelsForKey: string | undefined;

export const claudeAdapter: AgentAdapter = {
    id: "claude",
    name: "Claude Code",
    capabilities: {
        skills: true,
        skillFilter: true,
        integrations: true,
        modes: ["default", "acceptEdits", "plan"],
    },
    skillDir: (cwd, name) => join(cwd, ".claude", "skills", name),

    // The SDK ships its own CLI binary, so there's nothing to install
    available: async () => ({ ok: true }),

    async listModels() {
        const key = await getApiKey("anthropic");
        if (key !== modelsForKey) {
            modelsPromise = null;
            modelsForKey = key;
        }
        modelsPromise ??= withIdleQuery({}, async (q) => {
            const models = await q.supportedModels();
            return models.map(({ value, displayName, description }) => ({
                value,
                displayName,
                description,
            }));
        }).catch((e) => {
            modelsPromise = null;
            throw e;
        });
        return modelsPromise;
    },

    // Skills (not built-in commands) visible in this folder, incl. enabled plugins' skills
    async listCommands(cwd, integrations) {
        const commands = await withIdleQuery(
            { cwd, plugins: toSdkOptions(integrations).plugins },
            (q) => q.supportedCommands(),
        );
        return commands
            .filter((c) => !c.builtin)
            .map(({ name, description }) => ({ name, description }))
            .sort((a, b) => a.name.localeCompare(b.name));
    },

    async test(integration) {
        const c = integration.config;
        if (c.kind === "plugin") {
            // A plugin is a folder with .claude-plugin/plugin.json
            const manifest = join(c.path, ".claude-plugin", "plugin.json");
            const ok = !!(await stat(manifest).catch(() => null));
            return {
                ok,
                status: ok ? "found" : "failed",
                error: ok ? undefined : `No plugin manifest at ${manifest}`,
            };
        }
        // The SDK's own message for a missing command is misleading ("Executable not found: stdio")
        if (c.kind === "stdio" && !Bun.which(c.command)) {
            return {
                ok: false,
                status: "failed",
                error: `Command not found: ${c.command}`,
            };
        }
        // Start just this server and ask the SDK how it went
        const status = await withIdleQuery(
            { mcpServers: toSdkOptions([integration]).mcpServers },
            async (q) => {
                for (let i = 0; i < 30; i++) {
                    const s = (await q.mcpServerStatus()).find(
                        (s) => s.name === integration.name,
                    );
                    if (s && s.status !== "pending") return s;
                    await new Promise((r) => setTimeout(r, 500));
                }
                return { status: "failed", error: "Timed out connecting" };
            },
        );
        return {
            ok: status.status === "connected",
            status: status.status,
            error: status.error,
        };
    },

    async account() {
        const info = await withIdleQuery({}, (q) => q.accountInfo());
        if (info.apiKeySource && info.apiKeySource !== "none")
            return {
                ok: true,
                message: `Using an API key (${info.apiKeySource}).`,
            };
        if (info.email || info.subscriptionType)
            return {
                ok: true,
                message: `Signed in with Claude Code${info.email ? ` as ${info.email}` : ""}${info.subscriptionType ? ` (${info.subscriptionType})` : ""}.`,
            };
        return {
            ok: false,
            message:
                "Not signed in. Add an Anthropic API key, or run `claude` in a terminal and /login.",
        };
    },

    // Skill/plugin folders: their instructions often point at files bundled next to them
    readOnlyPaths: (integrations) => [
        "~/.claude/skills",
        "~/.claude/plugins",
        ...toSdkOptions(integrations).plugins.map((p) => p.path),
    ],

    async run(ctx): Promise<RunResult> {
        // The latest API call; its usage is the context size, since result.usage sums all turns
        let lastCall: SDKAssistantMessage["message"] | undefined;
        let wroteText = false;
        const { mcpServers, plugins } = toSdkOptions(ctx.integrations);

        // ctx.signal is the user's Stop. It isn't passed to the SDK: the SDK's own abort
        // shuts down gracefully (~2s, the stream keeps going). interrupt() cancels the
        // in-flight API call at once; abort stays as the fallback if the CLI doesn't answer.
        const sdkAbort = new AbortController();
        const q = query({
            prompt: ctx.prompt,
            options: {
                cwd: ctx.cwd,
                // Run without asking. Read-only only: anything listed here skips the
                // permission flow, so Edit/Write/Bash must not be, or they'd never ask
                allowedTools: ["Read", "Glob", "Grep"],
                resume: ctx.resume,
                model: ctx.model,
                maxTurns: ctx.limits.maxTurns,
                maxBudgetUsd: ctx.limits.maxBudgetUsd,
                env: await claudeEnv(),
                permissionMode: ctx.mode,
                skills: ctx.skills,
                mcpServers,
                plugins,
                // Every tool call goes through the shared policy in a PreToolUse hook, not
                // canUseTool: allow rules in the user's ~/.claude/settings.json (e.g. "Write",
                // "Bash(*)") approve tools before canUseTool is asked, but hooks run first
                hooks: {
                    PreToolUse: [
                        {
                            hooks: [
                                async (input, _id, { signal }) => {
                                    if (input.hook_event_name !== "PreToolUse")
                                        return {};
                                    const result = await ctx.checkTool(
                                        toToolCall(
                                            input.tool_name,
                                            (input.tool_input ?? {}) as Record<
                                                string,
                                                unknown
                                            >,
                                        ),
                                        signal,
                                    );
                                    if (result.decision === "pass") return {};
                                    return {
                                        hookSpecificOutput: {
                                            hookEventName: "PreToolUse",
                                            permissionDecision: result.decision,
                                            permissionDecisionReason:
                                                result.decision === "deny"
                                                    ? result.reason
                                                    : undefined,
                                        },
                                    };
                                },
                            ],
                        },
                    ],
                },
                abortController: sdkAbort,
                sandbox: SANDBOX,
                // Emits the API's raw SSE events as "stream_event", for live text
                includePartialMessages: true,
            },
        });
        let fallback: ReturnType<typeof setTimeout> | undefined;
        ctx.signal.addEventListener(
            "abort",
            () => {
                q.interrupt().catch(() => sdkAbort.abort());
                fallback = setTimeout(() => sdkAbort.abort(), 3000);
            },
            { once: true },
        );
        const stopped: RunResult = { type: "stopped", message: "" };

        try {
            for await (const event of q) {
                if (event.type === "system" && event.subtype === "init") {
                    if (!ctx.resume) ctx.onSession(event.session_id);
                } else if (
                    event.type === "stream_event" &&
                    !event.parent_tool_use_id // subagents' text isn't part of the reply
                ) {
                    const e = event.event;
                    // A later turn's text block: separate it from the previous turn's text
                    if (
                        e.type === "content_block_start" &&
                        e.content_block.type === "text" &&
                        wroteText
                    ) {
                        ctx.onText("\n\n");
                    } else if (
                        e.type === "content_block_delta" &&
                        e.delta.type === "text_delta"
                    ) {
                        wroteText = true;
                        ctx.onText(e.delta.text);
                    }
                } else if (
                    event.type === "assistant" &&
                    event.message?.content
                ) {
                    // Subagent calls have their own context; only track the main thread's
                    if (!event.parent_tool_use_id) lastCall = event.message;
                    for (const block of event.message.content) {
                        if (block.type === "tool_use") {
                            const call = toToolCall(
                                block.name,
                                block.input as Record<string, unknown>,
                            );
                            ctx.onToolUse({ name: call.name, file: call.file });
                        }
                    }
                } else if (event.type === "result") {
                    const usage = toUsage(event, lastCall);
                    if (ctx.signal.aborted) return { ...stopped, usage };
                    if (event.subtype === "success") {
                        // is_error: the turn ended on an API error (e.g. bad key); result holds its text
                        return event.is_error
                            ? {
                                  type: "error",
                                  message:
                                      event.result ||
                                      "The agent hit an API error.",
                                  usage,
                              }
                            : { type: "result", message: event.result, usage };
                    }
                    const reasons: Record<typeof event.subtype, string> = {
                        error_max_turns:
                            "The agent hit its turn limit before finishing.",
                        error_max_budget_usd:
                            "The agent hit its budget limit before finishing.",
                        error_during_execution:
                            "The agent failed while running.",
                        error_max_structured_output_retries:
                            "The agent couldn't produce a valid response.",
                    };
                    const details = event.errors?.join("\n");
                    return {
                        type: "error",
                        message: details
                            ? `${reasons[event.subtype]}\n\n${details}`
                            : reasons[event.subtype],
                        usage,
                    };
                }
            }
            if (ctx.signal.aborted) return stopped;
            return {
                type: "error",
                message: "The agent stopped without a result.",
            };
        } catch (e) {
            // An interrupted/aborted run makes the SDK throw: that's the user's stop, not a crash
            if (ctx.signal.aborted) return stopped;
            console.error("Claude run failed:", e);
            // First line only; the full error (often with a stack dump) is in the server log
            const reason = (e instanceof Error ? e.message : String(e)).split(
                "\n",
            )[0];
            return { type: "error", message: `The agent crashed: ${reason}` };
        } finally {
            clearTimeout(fallback);
        }
    },
};
