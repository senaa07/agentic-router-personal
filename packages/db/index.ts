import mongoose from "mongoose";
export const Workspace = new mongoose.Schema({
    path: { type: String, required: true },
    name: { type: String, required: true },
    createdAt: { type: Date, required: true },
});

export const Session = new mongoose.Schema({
    conversation: [mongoose.Schema.Types.Mixed],
    workspace: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Workspace",
        required: true,
    },
    // Which coding agent runs this session (same list as AGENT_IDS in commons)
    agent: {
        type: String,
        enum: ["claude", "codex", "cursor"],
        required: true,
        default: "claude",
    },
    // The agent's own session/thread id, used to resume its history (was anthropicSessionId)
    agentSessionId: { type: String, required: false },
    name: { type: String, required: false },
    // Skill names to load; empty = all discovered skills
    skills: { type: [String], default: [] },
    integrations: [
        { type: mongoose.Schema.Types.ObjectId, ref: "Integration" },
    ],
});

// An MCP server or local plugin the user can enable per session.
// config holds the SDK settings (command/args/env, url/headers, or path), incl. secrets
export const Integration = new mongoose.Schema(
    {
        name: { type: String, required: true, unique: true },
        trusted: { type: Boolean, required: true, default: false },
        config: { type: mongoose.Schema.Types.Mixed, required: true },
        createdAt: { type: Date, required: true },
    },
    // Keep empty env/headers objects; by default Mongoose drops them on save
    { minimize: false },
);

// App-wide settings: one document, _id "app" (the app has a single local user).
// apiKeys holds provider secrets; they're never sent to the browser.
export const Settings = new mongoose.Schema(
    {
        _id: { type: String, default: "app" },
        profile: { name: { type: String, default: "" } },
        theme: {
            type: String,
            enum: ["system", "light", "dark"],
            default: "system",
        },
        defaults: {
            agent: { type: String, default: "claude" },
            mode: { type: String, default: "default" },
            models: { type: mongoose.Schema.Types.Mixed, default: {} }, // agent -> model
        },
        limits: {
            maxTurns: { type: Number, default: null },
            maxBudgetUsd: { type: Number, default: null },
        },
        apiKeys: { type: mongoose.Schema.Types.Mixed, default: {} }, // provider -> key
    },
    { minimize: false },
);

export const SessionModel = mongoose.model("Session", Session);
export const SettingsModel = mongoose.model("Settings", Settings);
export const WorkspaceModel = mongoose.model("Workspace", Workspace);
export const IntegrationModel = mongoose.model("Integration", Integration);

// One-off data migrations, safe to run on every start (each only touches old documents).
// Uses the raw collection: anthropicSessionId is no longer in the schema, so Mongoose
// would strip it from a normal update.
export async function migrate() {
    const sessions = SessionModel.collection;
    const renamed = await sessions.updateMany(
        { anthropicSessionId: { $exists: true } },
        { $rename: { anthropicSessionId: "agentSessionId" } },
    );
    // Sessions from before multi-agent all ran on Claude
    const agentSet = await sessions.updateMany(
        { agent: { $exists: false } },
        { $set: { agent: "claude" } },
    );
    return {
        renamedSessionIds: renamed.modifiedCount,
        agentSet: agentSet.modifiedCount,
    };
}
