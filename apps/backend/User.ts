import WebSocket from "ws";
import { uuid } from "uuidv4";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    AddMessageSchema,
    CreateSessionSchema,
    CreateWorkspaceSchema,
    DeleteSessionSchema,
    DeleteWorkspaceSchema,
    RenameSessionSchema,
    StopRunSchema,
    PermissionResponseSchema,
    ListSkillsSchema,
    UpdateSessionToolsSchema,
    CreateSkillSchema,
    CreateIntegrationSchema,
    IntegrationIdSchema,
    UpdateSettingsSchema,
    VerifyProviderSchema,
    type AgentId,
    type Integration,
    type IntegrationConfig,
    type SkillInfo,
    type IncomingMessgageType,
    type Message,
    type OutgoingMessageType,
    type ToolUse,
} from "commons/types";
import { IntegrationModel, SessionModel, WorkspaceModel } from "db/client";
import {
    createPolicy,
    getAdapter,
    realPath,
    requireAvailable,
    unsafeWorkspace,
    type AgentAdapter,
    type EditMode,
    type RunIntegration,
    type RunResult,
    type ToolCall,
} from "./adapters";
import {
    getSettings,
    PROVIDERS,
    toClientSettings,
    updateSettings,
} from "./settings";

type IntegrationDoc = {
    _id: unknown;
    name: string;
    trusted: boolean;
    config: unknown;
};

const toRunIntegration = (i: IntegrationDoc): RunIntegration => ({
    name: i.name,
    trusted: i.trusted,
    config: i.config as IntegrationConfig,
});

// What the browser sees: never the env/header values, which are usually API keys
function toClientIntegration(i: IntegrationDoc): Integration {
    const c = i.config as IntegrationConfig;
    return {
        id: String(i._id),
        name: i.name,
        kind: c.kind,
        trusted: i.trusted,
        summary:
            c.kind === "stdio"
                ? [c.command, ...c.args].join(" ")
                : c.kind === "plugin"
                  ? c.path
                  : c.url,
        // ?? {}: records saved before the schema kept empty objects have no env/headers
        secretKeys: Object.keys(
            (c.kind === "stdio"
                ? c.env
                : c.kind === "plugin"
                  ? {}
                  : c.headers) ?? {},
        ),
    };
}

export async function listIntegrations(): Promise<Integration[]> {
    const all = await IntegrationModel.find().sort({ createdAt: 1 });
    return all.map(toClientIntegration);
}

// Skills the session's agent sees in its workspace, including enabled plugins' skills
async function loadSkills(sessionId: string): Promise<SkillInfo[]> {
    const session = await SessionModel.findById(sessionId);
    if (!session)
        throw new Error("Session not found. It may have been deleted.");
    const workspace = await WorkspaceModel.findById(session.workspace);
    if (!workspace)
        throw new Error("This session's workspace no longer exists.");
    const adapter = getAdapter(session.agent as AgentId);
    if (!adapter.capabilities.skills) return [];
    const integrations = await IntegrationModel.find({
        _id: { $in: session.integrations },
    });
    return adapter.listCommands(
        workspace.path,
        integrations.map(toRunIntegration),
    );
}

// Sessions with an agent run in progress -> the controller that stops it. Shared across connections.
// ponytail: in-memory, so it only works with a single backend process
const runningSessions = new Map<string, AbortController>();

// Tool calls waiting for the user's approve/deny, by requestId
const pendingApprovals = new Map<
    string,
    { userId: string; sessionId: string; answer: (allow: boolean) => void }
>();

// The user's socket closed: nobody can answer their requests, so deny them
// rather than leave those runs paused forever
export function denyApprovals(userId: string) {
    for (const p of pendingApprovals.values()) {
        if (p.userId === userId) p.answer(false);
    }
}

// First validation issue as a readable sentence, e.g. "Invalid add-message request: Message can't be empty"
function invalid(type: string, error: { issues: { message: string }[] }) {
    return new Error(
        `Invalid ${type} request: ${error.issues[0]?.message ?? "bad payload"}`,
    );
}

export class User {
    public id: string;
    private socket: WebSocket;

    constructor(socket: WebSocket) {
        this.id = uuid();
        this.socket = socket;
    }

    async sendMessage(payload: OutgoingMessageType) {
        // The client may disconnect mid agent run; the result is still saved to the db
        if (this.socket.readyState !== WebSocket.OPEN) return;
        this.socket.send(JSON.stringify(payload));
    }

    async handleIncomingMessage(
        msg: IncomingMessgageType,
    ): Promise<OutgoingMessageType> {
        if (msg.type === "create-workspace") {
            const { success, data, error } = CreateWorkspaceSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            // Normalizes trailing slashes and ".." so the same folder can't be added twice
            const info = await stat(resolve(data.path)).catch(() => null);
            if (!info?.isDirectory()) {
                throw new Error(`Folder not found: ${resolve(data.path)}`);
            }
            const unsafe = await unsafeWorkspace(data.path);
            if (unsafe) throw new Error(unsafe);
            // Canonical path (symlinks, case, "..", trailing slash), so the sandbox root
            // and the duplicate check can't be fooled by another spelling
            const path = await realPath(data.path);
            if (await WorkspaceModel.exists({ path })) {
                throw new Error(`Workspace already added: ${path}`);
            }

            // Last folder name; resolve() already stripped any trailing slash
            const name = path.split("/").pop();
            if (!name) {
                throw new Error(`Can't use the root folder as a workspace`);
            }

            const workspace = await WorkspaceModel.create({
                path,
                name,
                createdAt: new Date(),
            });

            return {
                type: "workspace-created",
                payload: {
                    id: workspace._id.toString(),
                    path: workspace.path,
                    name: workspace.name,
                },
            };
        } else if (msg.type === "create-session") {
            const { success, data, error } = CreateSessionSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            if (!(await WorkspaceModel.exists({ _id: data.workspaceId }))) {
                throw new Error(
                    "Workspace not found. It may have been deleted.",
                );
            }
            // Throws e.g. "Codex support isn't implemented yet." for agents that can't run
            await requireAvailable(data.agent);

            const session = await SessionModel.create({
                workspace: data.workspaceId,
                agent: data.agent,
                conversation: [],
            });

            return {
                type: "session-created",
                payload: {
                    id: session._id.toString(),
                    workspaceId: data.workspaceId,
                    agent: data.agent,
                },
            };
        } else if (msg.type === "add-message") {
            const { success, data, error } = AddMessageSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            if (runningSessions.has(data.sessionId)) {
                throw new Error(
                    "The agent is still working on this session. Wait for it to finish.",
                );
            }

            const session = await SessionModel.findById(data.sessionId);
            if (!session) {
                throw new Error("Session not found. It may have been deleted.");
            }

            // Re-checked per message: the agent may have been uninstalled since
            const adapter = await requireAvailable(session.agent as AgentId);

            const workspace = await WorkspaceModel.findById(session.workspace);
            if (!workspace) {
                throw new Error("This session's workspace no longer exists.");
            }
            // Without this agents fail with misleading errors (Claude: "binary failed to launch (ENOENT)")
            const folder = await stat(workspace.path).catch(() => null);
            if (!folder?.isDirectory()) {
                throw new Error(
                    `The workspace folder no longer exists: ${workspace.path}`,
                );
            }
            // Also re-checked here: workspaces added before the sandbox existed (e.g. a home folder)
            const unsafe = await unsafeWorkspace(workspace.path);
            if (unsafe) {
                throw new Error(
                    `${unsafe} Remove this workspace and add a project folder.`,
                );
            }

            const message = {
                id: crypto.randomUUID(),
                role: "user" as const,
                payload: { message: data.message },
            };
            await SessionModel.updateOne(
                { _id: data.sessionId },
                { $push: { conversation: message } },
            );
            // Ack the user message now, so it shows before the agent's reply
            this.sendMessage({
                type: "message-added",
                payload: { sessionId: data.sessionId, message },
            });

            const controller = new AbortController();
            runningSessions.set(data.sessionId, controller);
            let reply: Message;
            try {
                const integrations = await IntegrationModel.find({
                    _id: { $in: session.integrations },
                });
                const settings = await getSettings();
                reply = await this.runAgent(
                    adapter,
                    data.sessionId,
                    {
                        prompt: data.message,
                        cwd: workspace.path,
                        resume: session.agentSessionId ?? undefined,
                        model: data.model,
                        mode: data.mode ?? "default",
                        // empty = every discovered skill (the agent's default)
                        skills: session.skills.length
                            ? session.skills
                            : undefined,
                        integrations: adapter.capabilities.integrations
                            ? integrations.map(toRunIntegration)
                            : [],
                        limits: {
                            maxTurns: settings.limits.maxTurns ?? undefined,
                            maxBudgetUsd:
                                settings.limits.maxBudgetUsd ?? undefined,
                        },
                    },
                    controller,
                );
            } finally {
                runningSessions.delete(data.sessionId);
            }

            // matchedCount is 0 if the session was deleted mid-run; nothing to save then
            await SessionModel.updateOne(
                { _id: data.sessionId },
                { $push: { conversation: reply } },
            );

            return {
                type: "assistant-message",
                payload: { sessionId: data.sessionId, message: reply },
            };
        } else if (msg.type === "delete-workspace") {
            const { success, data, error } = DeleteWorkspaceSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const sessionIds = await SessionModel.distinct("_id", {
                workspace: data.workspaceId,
            });
            if (sessionIds.some((id) => runningSessions.has(String(id)))) {
                throw new Error(
                    "The agent is still working in this workspace. Wait for it to finish before deleting.",
                );
            }

            const result = await WorkspaceModel.deleteOne({
                _id: data.workspaceId,
            });
            if (result.deletedCount === 0) {
                throw new Error(
                    "Workspace not found. It may have been deleted.",
                );
            }
            // A session can't exist without its workspace
            await SessionModel.deleteMany({ workspace: data.workspaceId });

            return {
                type: "workspace-deleted",
                payload: { id: data.workspaceId },
            };
        } else if (msg.type === "delete-session") {
            const { success, data, error } = DeleteSessionSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            if (runningSessions.has(data.sessionId)) {
                throw new Error(
                    "The agent is still working on this session. Wait for it to finish before deleting.",
                );
            }

            const result = await SessionModel.deleteOne({
                _id: data.sessionId,
            });
            if (result.deletedCount === 0) {
                throw new Error("Session not found. It may have been deleted.");
            }

            return {
                type: "session-deleted",
                payload: { id: data.sessionId },
            };
        } else if (msg.type === "rename-session") {
            const { success, data, error } = RenameSessionSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const result = await SessionModel.updateOne(
                { _id: data.sessionId },
                { name: data.name },
            );
            if (result.matchedCount === 0) {
                throw new Error("Session not found. It may have been deleted.");
            }

            return {
                type: "session-renamed",
                payload: { id: data.sessionId, name: data.name },
            };
        } else if (msg.type === "permission-response") {
            const { success, data, error } = PermissionResponseSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const pending = pendingApprovals.get(data.requestId);
            if (!pending) {
                throw new Error(
                    "This request was already answered or the run has ended.",
                );
            }
            pending.answer(data.allow); // resumes the paused run
            return {
                type: "permission-resolved",
                payload: {
                    sessionId: pending.sessionId,
                    requestId: data.requestId,
                },
            };
        } else if (msg.type === "stop-run") {
            const { success, data, error } = StopRunSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const controller = runningSessions.get(data.sessionId);
            if (!controller) {
                throw new Error("The agent isn't running on this session.");
            }
            // The run's own add-message handler then saves and sends the "stopped" reply
            controller.abort();

            return {
                type: "stop-requested",
                payload: { sessionId: data.sessionId },
            };
        } else if (msg.type === "list-skills") {
            const { success, data, error } = ListSkillsSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            return {
                type: "skills",
                payload: {
                    sessionId: data.sessionId,
                    skills: await loadSkills(data.sessionId),
                },
            };
        } else if (msg.type === "update-session-tools") {
            const { success, data, error } = UpdateSessionToolsSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            // Drop ids of integrations that were deleted meanwhile
            const existing = await IntegrationModel.distinct("_id", {
                _id: { $in: data.integrations },
            });
            const skills = [...new Set(data.skills)];
            const integrations = existing.map(String);
            const result = await SessionModel.updateOne(
                { _id: data.sessionId },
                { skills, integrations },
            );
            if (result.matchedCount === 0) {
                throw new Error("Session not found. It may have been deleted.");
            }

            return {
                type: "session-tools-updated",
                payload: { id: data.sessionId, skills, integrations },
            };
        } else if (msg.type === "create-skill") {
            const { success, data, error } = CreateSkillSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const session = await SessionModel.findById(data.sessionId);
            if (!session) {
                throw new Error("Session not found. It may have been deleted.");
            }
            const workspace = await WorkspaceModel.findById(session.workspace);
            if (!workspace) {
                throw new Error("This session's workspace no longer exists.");
            }

            // The session's agent's own project-skill folder (Claude: .claude/skills,
            // Codex: .agents/skills), so it also works in that agent's own CLI
            const adapter = getAdapter(session.agent as AgentId);
            if (!adapter.capabilities.skills) {
                throw new Error(`${adapter.name} doesn't support skills.`);
            }
            const dir = adapter.skillDir(workspace.path, data.name);
            const file = join(dir, "SKILL.md");
            if (await stat(file).catch(() => null)) {
                throw new Error(
                    `A skill named "${data.name}" already exists in this workspace.`,
                );
            }
            await mkdir(dir, { recursive: true });
            // JSON strings are valid YAML, so the description can't break the frontmatter
            await writeFile(
                file,
                `---\nname: ${data.name}\ndescription: ${JSON.stringify(data.description)}\n---\n\n${data.body}\n`,
            );

            return {
                type: "skills",
                payload: {
                    sessionId: data.sessionId,
                    skills: await loadSkills(data.sessionId),
                },
            };
        } else if (msg.type === "create-integration") {
            const { success, data, error } = CreateIntegrationSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            let config = data.config;
            if (config.kind === "plugin") {
                const path = resolve(config.path);
                const info = await stat(path).catch(() => null);
                if (!info?.isDirectory()) {
                    throw new Error(`Plugin folder not found: ${path}`);
                }
                config = { ...config, path };
            }
            if (await IntegrationModel.exists({ name: data.name })) {
                throw new Error(
                    `An integration named "${data.name}" already exists.`,
                );
            }
            await IntegrationModel.create({
                name: data.name,
                trusted: data.trusted,
                config,
                createdAt: new Date(),
            });

            return {
                type: "integrations",
                payload: { integrations: await listIntegrations() },
            };
        } else if (msg.type === "delete-integration") {
            const { success, data, error } = IntegrationIdSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const result = await IntegrationModel.deleteOne({ _id: data.id });
            if (result.deletedCount === 0) {
                throw new Error(
                    "Integration not found. It may have been deleted.",
                );
            }
            await SessionModel.updateMany(
                {},
                { $pull: { integrations: data.id } },
            );

            return {
                type: "integrations",
                payload: { integrations: await listIntegrations() },
            };
        } else if (msg.type === "test-integration") {
            const { success, data, error } = IntegrationIdSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const integration = await IntegrationModel.findById(data.id);
            if (!integration) {
                throw new Error(
                    "Integration not found. It may have been deleted.",
                );
            }
            // Integrations are global, so they're tested with Claude, the agent that
            // supports them today; a per-agent test can use getAdapter(id).test() the same way
            const result = await getAdapter("claude").test(
                toRunIntegration(integration),
            );
            return {
                type: "integration-tested",
                payload: { id: data.id, name: integration.name, ...result },
            };
        } else if (msg.type === "update-settings") {
            const { success, data, error } = UpdateSettingsSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            return {
                type: "settings",
                payload: {
                    settings: toClientSettings(await updateSettings(data)),
                },
            };
        } else if (msg.type === "verify-provider") {
            const { success, data, error } = VerifyProviderSchema.safeParse(
                msg.payload,
            );
            if (!success) {
                throw invalid(msg.type, error);
            }

            const provider = PROVIDERS[data.provider];
            const key = (await getSettings()).apiKeys[data.provider];
            let result: { ok: boolean; message: string };
            if (key && provider.verifyKey) {
                result = await provider.verifyKey(key);
            } else if (key) {
                result = {
                    ok: true,
                    message: `Key saved. ${provider.name} keys can't be verified from here yet.`,
                };
            } else {
                // No key: report how the provider's agent is signed in instead (e.g. Claude Code login)
                const account = getAdapter(provider.agents[0]!).account;
                result = account
                    ? await account()
                    : {
                          ok: false,
                          message: `No ${provider.name} API key set.`,
                      };
            }

            return {
                type: "provider-verified",
                payload: { provider: data.provider, ...result },
            };
        } else {
            throw new Error(`Unknown message type: ${(msg as any).type}`);
        }
    }

    // Pauses the run until the user approves or denies this tool call (an approval card).
    // Stop, or the agent cancelling the call, denies it so the run can end.
    private askUser(
        sessionId: string,
        call: ToolCall,
        signal: AbortSignal,
        stop: AbortSignal,
    ): Promise<boolean> {
        const requestId = crypto.randomUUID();
        return new Promise<boolean>((resolve) => {
            const answer = (allow: boolean) => {
                if (!pendingApprovals.delete(requestId)) return; // already answered
                resolve(allow);
            };
            pendingApprovals.set(requestId, {
                userId: this.id,
                sessionId,
                answer,
            });
            signal.addEventListener("abort", () => answer(false), {
                once: true,
            });
            stop.addEventListener("abort", () => answer(false), { once: true });
            this.sendMessage({
                type: "permission-request",
                payload: {
                    sessionId,
                    request: {
                        requestId,
                        name: call.name,
                        file: call.file,
                        detail: call.detail,
                    },
                },
            });
        });
    }

    // Runs any agent through its adapter and always resolves to a message: the reply, or
    // an error saying why the run failed. Never throws, so the UI never hangs on "Working...".
    // Agent-neutral: the adapter reports text / tool use / its session id through the
    // context, and every tool call goes through the shared policy (sandbox + edit mode).
    private async runAgent(
        adapter: AgentAdapter,
        sessionId: string,
        opts: {
            prompt: string;
            cwd: string;
            resume?: string;
            model?: string;
            mode: EditMode;
            skills?: string[];
            integrations: RunIntegration[];
            limits: { maxTurns?: number; maxBudgetUsd?: number };
        },
        controller: AbortController,
    ): Promise<Message> {
        const tools: ToolUse[] = [];
        // Everything streamed to the client; kept as the reply if the user stops the run
        let streamed = "";
        const root = await realPath(opts.cwd);
        const readOnlyRoots = await Promise.all(
            adapter.readOnlyPaths(opts.integrations).map(realPath),
        );
        const checkTool = createPolicy({
            root,
            readOnlyRoots,
            mode: opts.mode,
            trustedServers: new Set(
                opts.integrations.filter((i) => i.trusted).map((i) => i.name),
            ),
            ask: (call, signal) =>
                this.askUser(sessionId, call, signal, controller.signal),
        });

        let result: RunResult;
        try {
            result = await adapter.run({
                ...opts,
                cwd: root,
                signal: controller.signal,
                onSession: (agentSessionId) => {
                    // updateOne, not session.save(): save() throws if the session was deleted mid-run
                    SessionModel.updateOne(
                        { _id: sessionId },
                        { agentSessionId },
                    ).catch((e) =>
                        console.error("Couldn't save agentSessionId:", e),
                    );
                },
                onText: (text) => {
                    if (controller.signal.aborted) return; // nothing more shows after Stop
                    streamed += text;
                    this.sendMessage({
                        type: "text-delta",
                        payload: { sessionId, text },
                    });
                },
                onToolUse: (tool) => {
                    tools.push(tool);
                    this.sendMessage({
                        type: "tool-use",
                        payload: { sessionId, tool },
                    });
                },
                checkTool,
            });
        } catch (e) {
            // Adapters shouldn't throw; this keeps a buggy one from hanging the UI
            console.error(`${adapter.name} adapter threw:`, e);
            const reason = (e instanceof Error ? e.message : String(e)).split(
                "\n",
            )[0];
            result = { type: "error", message: `The agent crashed: ${reason}` };
        }

        return {
            id: crypto.randomUUID(),
            role: "assistant",
            payload: {
                type: result.type,
                message: result.type === "stopped" ? streamed : result.message,
                tools,
                usage: result.usage,
            },
        };
    }
}
