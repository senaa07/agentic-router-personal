import type {
    AgentId,
    IntegrationConfig,
    ModelOption,
    PermissionRequest,
    SkillInfo,
    ToolUse,
    Usage,
} from "commons/types";

// One interface for every coding agent (Claude, Codex, Cursor...). Everything an agent
// reports is normalized here, so User.ts and the UI never see an SDK's own event shapes.

export type EditMode = "default" | "acceptEdits" | "plan";

// An MCP server or plugin enabled for a session (agent-neutral; from the DB)
export type RunIntegration = {
    name: string;
    trusted: boolean;
    config: IntegrationConfig;
};

// A tool call in agent-neutral terms. Adapters map their own tools onto this
// (Claude "Edit" / Codex "apply_patch" -> kind "edit"; "Bash" / "shell" -> "command"),
// which is all the sandbox, edit-mode rules and approval cards need.
export type ToolCall = {
    name: string; // shown to the user, e.g. "Edit", "Bash", "mcp__github__create_issue"
    kind: "read" | "edit" | "command" | "mcp" | "plan" | "other";
    // Files/folders the call reads ("read") or writes ("edit"); checked against the workspace
    paths: string[];
    mcpServer?: string; // kind "mcp": which server, for the "trusted" check
} & Omit<PermissionRequest, "requestId" | "name">; // file + detail for the approval card

// allow: run it. deny: refuse (reason goes back to the agent).
// pass: no rule applies; the adapter uses its own default (e.g. read-only tools).
export type ToolDecision =
    | { decision: "allow" }
    | { decision: "deny"; reason: string }
    | { decision: "pass" };

export type RunContext = {
    prompt: string;
    cwd: string; // canonical workspace path = the sandbox root
    resume?: string; // agentSessionId from a previous run
    model?: string; // a value from listModels(); undefined = the agent's default
    mode: EditMode;
    skills?: string[]; // undefined = all
    integrations: RunIntegration[];
    // From Settings > Limits; undefined = no limit
    limits: { maxTurns?: number; maxBudgetUsd?: number };
    signal: AbortSignal; // the user pressed Stop: end the run as soon as possible

    // Persist the agent's session/thread id as soon as it's known, so even a run
    // stopped early can be resumed by the next message
    onSession(agentSessionId: string): void;
    onText(text: string): void; // streamed reply text
    onToolUse(tool: ToolUse): void;
    // Must be awaited before every tool call runs: sandbox, edit mode and user approval
    checkTool(call: ToolCall, signal: AbortSignal): Promise<ToolDecision>;
};

// "stopped": the user stopped it (User fills message with the text streamed so far)
export type RunResult = {
    type: "result" | "error" | "stopped";
    message: string;
    usage?: Usage;
};

export type Availability = { ok: true } | { ok: false; reason: string };

export interface AgentAdapter {
    id: AgentId;
    name: string;
    capabilities: {
        skills: boolean; // listCommands() returns its skills
        skillFilter: boolean; // RunContext.skills (a chosen subset) is honored
        integrations: boolean; // MCP servers from RunContext.integrations are used
        modes: EditMode[]; // edit modes run() supports
    };
    // Where "New skill" writes <name>'s SKILL.md, so this agent picks it up
    skillDir(cwd: string, name: string): string;
    available(): Promise<Availability>;
    // Never throws: failures come back as { type: "error" } so the UI can't hang
    run(ctx: RunContext): Promise<RunResult>;
    listModels(): Promise<ModelOption[]>;
    // Skills/slash commands the agent sees in this folder (with these plugins)
    listCommands(
        cwd: string,
        integrations: RunIntegration[],
    ): Promise<SkillInfo[]>;
    // Can this MCP server / plugin start? Used by Integrations > Test
    test(integration: RunIntegration): Promise<{
        ok: boolean;
        status: string;
        error?: string;
    }>;
    // How the agent is signed in right now (e.g. a CLI login), for Settings > Providers.
    // Optional: agents that only use an API key are verified with the key instead.
    account?(): Promise<{ ok: boolean; message: string }>;
    // Folders the agent may read (never write) outside the workspace, e.g. its skills
    readOnlyPaths(integrations: RunIntegration[]): string[];
}
