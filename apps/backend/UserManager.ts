import { uuid } from "uuidv4";
import WebSocket from "ws";
import { denyApprovals, listIntegrations, User } from "./User";
import { SessionModel, WorkspaceModel } from "db/client";
import type { AgentId, Message, Workspace } from "commons/types";
import { getAdapter, listAgents } from "./adapters";
import { getSettings, toClientSettings } from "./settings";

export class UserManager {
    private users: User[];
    private constructor() {
        this.users = [];
    }
    private static instance: UserManager;

    static getInstance(): UserManager {
        if (!UserManager.instance) {
            UserManager.instance = new UserManager();
        }
        return UserManager.instance;
    }

    async addUser(socket: WebSocket): Promise<void> {
        const user = new User(socket);
        this.users.push(user);

        // Register handlers before any await so early client messages aren't dropped
        socket.on("message", async (msg) => {
            let parsedMessage: any;
            try {
                parsedMessage = JSON.parse(msg.toString());
            } catch {
                user.sendMessage({
                    type: "error",
                    payload: { message: "Request wasn't valid JSON." },
                });
                return;
            }
            try {
                const responsePayload =
                    await user.handleIncomingMessage(parsedMessage);

                user.sendMessage(responsePayload);
            } catch (e) {
                console.error("Failed to handle message:", e);
                console.log(msg.toString());
                // sessionId lets the UI clear that session's "Working..." state
                const sessionId = parsedMessage?.payload?.sessionId;
                user.sendMessage({
                    type: "error",
                    payload: {
                        message: e instanceof Error ? e.message : String(e),
                        sessionId:
                            typeof sessionId === "string"
                                ? sessionId
                                : undefined,
                    },
                });
            }
        });

        socket.on("close", () => {
            denyApprovals(user.id);
            this.removeUser(user.id);
        });

        try {
            const workspaces = await WorkspaceModel.find();
            const sessions = await SessionModel.find();

            const response: Workspace[] = workspaces.map((w) => ({
                id: w._id.toString(),
                name: w.name,
                path: w.path,
                sessions: sessions
                    .filter((s) => s.workspace.equals(w._id))
                    .map((s) => ({
                        id: s._id.toString(),
                        agent: s.agent as AgentId,
                        name: s.name ?? undefined,
                        messages: s.conversation as Message[],
                        skills: s.skills,
                        integrations: s.integrations.map(String),
                    })),
            }));

            user.sendMessage({ type: "init", workspaces: response });
            user.sendMessage({
                type: "integrations",
                payload: { integrations: await listIntegrations() },
            });
            user.sendMessage({
                type: "settings",
                payload: { settings: toClientSettings(await getSettings()) },
            });
            const agents = await listAgents();
            user.sendMessage({ type: "agents", payload: { agents } });
            // After init, so a slow model lookup (~1s, first time only) doesn't delay the page
            for (const agent of agents.filter((a) => a.available)) {
                getAdapter(agent.id)
                    .listModels()
                    .then(
                        (models) =>
                            user.sendMessage({
                                type: "models",
                                payload: { agent: agent.id, models },
                            }),
                        (e) => {
                            console.error(
                                `Failed to load ${agent.name} models:`,
                                e,
                            );
                            user.sendMessage({
                                type: "error",
                                payload: {
                                    message: `Couldn't load ${agent.name}'s model list; its default model will be used.`,
                                },
                            });
                        },
                    );
            }
        } catch (e) {
            // e.g. MongoDB is down; without this the rejection goes unhandled
            console.error("Failed to load workspaces:", e);
            user.sendMessage({
                type: "error",
                payload: {
                    message:
                        "Couldn't load your workspaces. Check the database connection and reload.",
                },
            });
        }
    }

    removeUser(id: string): void {
        this.users = this.users.filter((user) => user.id !== id);
    }
}
