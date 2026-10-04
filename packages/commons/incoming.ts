import z from "zod";

// Mongo ObjectId; checked here so a bad id gets a clear message instead of a Mongo CastError
const objectId = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

// Agent permission modes, and UI themes
export const EDIT_MODES = ["default", "acceptEdits", "plan"] as const;
export const THEMES = ["system", "light", "dark"] as const;

export const CreateWorkspaceSchema = z.object({
    path: z.string().trim().min(1, "Path is required"),
});

export type CreateWorkspaceSchemaType = z.infer<typeof CreateWorkspaceSchema>;

// Coding agents a session can run on. Each has an adapter in apps/backend/adapters
export const AGENT_IDS = ["claude", "codex", "cursor"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const CreateSessionSchema = z.object({
    workspaceId: objectId,
    // Fixed for the session's lifetime: its history can only be resumed by the same agent
    agent: z.enum(AGENT_IDS).default("claude"),
});

export type CreateSessionSchemaType = z.infer<typeof CreateSessionSchema>;

export const AddMessageSchema = z.object({
    sessionId: objectId,
    message: z.string().trim().min(1, "Message can't be empty"),
    // A ModelInfo.value from the "models" list; omitted = the SDK's default
    model: z.string().trim().min(1).max(100).optional(),
    // SDK permission mode. "default" asks before edits and commands; omitted = "default"
    mode: z.enum(EDIT_MODES).optional(),
});

export type AddMessageSchemaType = z.infer<typeof AddMessageSchema>;

export const DeleteWorkspaceSchema = z.object({
    workspaceId: objectId,
});

export type DeleteWorkspaceSchemaType = z.infer<typeof DeleteWorkspaceSchema>;

export const DeleteSessionSchema = z.object({
    sessionId: objectId,
});

export type DeleteSessionSchemaType = z.infer<typeof DeleteSessionSchema>;

export const RenameSessionSchema = z.object({
    sessionId: objectId,
    name: z
        .string()
        .trim()
        .min(1, "Name can't be empty")
        .max(100, "Name must be 100 characters or less"),
});

export type RenameSessionSchemaType = z.infer<typeof RenameSessionSchema>;

export const StopRunSchema = z.object({
    sessionId: objectId,
});

export type StopRunSchemaType = z.infer<typeof StopRunSchema>;

// The user's answer to a "permission-request"
export const PermissionResponseSchema = z.object({
    requestId: z.string().min(1),
    allow: z.boolean(),
});

export type PermissionResponseSchemaType = z.infer<
    typeof PermissionResponseSchema
>;

// Skills the agent can use in this session's workspace
export const ListSkillsSchema = z.object({
    sessionId: objectId,
});

export type ListSkillsSchemaType = z.infer<typeof ListSkillsSchema>;

export const UpdateSessionToolsSchema = z.object({
    sessionId: objectId,
    // Skill names to load; empty = all discovered skills (the SDK default)
    skills: z.array(z.string().min(1).max(200)).max(500),
    // Integration ids enabled for this session
    integrations: z.array(objectId).max(100),
});

export type UpdateSessionToolsSchemaType = z.infer<
    typeof UpdateSessionToolsSchema
>;

// Writes <workspace>/.claude/skills/<name>/SKILL.md
export const CreateSkillSchema = z.object({
    sessionId: objectId,
    name: z
        .string()
        .regex(
            /^[a-z0-9][a-z0-9-]{0,63}$/,
            "Skill name: lowercase letters, numbers and dashes",
        ),
    description: z.string().trim().min(1, "Description is required").max(500),
    body: z.string().trim().min(1, "Instructions are required").max(50_000),
});

export type CreateSkillSchemaType = z.infer<typeof CreateSkillSchema>;

// No underscores: MCP tools are named mcp__<server>__<tool>, so "__" would be ambiguous
const integrationName = z
    .string()
    .regex(
        /^[a-zA-Z0-9-]{1,40}$/,
        "Name: letters, numbers and dashes (max 40)",
    );
const stringRecord = z.record(z.string().min(1), z.string());

export const CreateIntegrationSchema = z.object({
    name: integrationName,
    // Trusted: its MCP tools run without asking, even in "Ask before edits"
    trusted: z.boolean(),
    config: z.discriminatedUnion("kind", [
        z.object({
            kind: z.literal("stdio"),
            command: z.string().trim().min(1, "Command is required"),
            args: z.array(z.string()),
            env: stringRecord,
        }),
        z.object({
            kind: z.enum(["http", "sse"]),
            url: z.url("Enter a valid URL"),
            headers: stringRecord,
        }),
        z.object({
            kind: z.literal("plugin"),
            path: z.string().trim().min(1, "Plugin folder is required"),
        }),
    ]),
});

export type CreateIntegrationSchemaType = z.infer<
    typeof CreateIntegrationSchema
>;
export type IntegrationConfig = CreateIntegrationSchemaType["config"];

export const IntegrationIdSchema = z.object({
    id: objectId,
});

export type IntegrationIdSchemaType = z.infer<typeof IntegrationIdSchema>;

// API-key providers. Each agent authenticates with one (claude -> anthropic, codex -> openai)
export const PROVIDER_IDS = ["anthropic", "openai", "cursor"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// A partial update: only the fields present change
export const UpdateSettingsSchema = z
    .object({
        profile: z
            .object({ name: z.string().trim().max(60, "Name is too long") })
            .optional(),
        theme: z.enum(THEMES).optional(),
        defaults: z
            .object({
                agent: z.enum(AGENT_IDS).optional(),
                mode: z.enum(EDIT_MODES).optional(),
                // Model per agent (a value from that agent's model list)
                models: z
                    .partialRecord(
                        z.enum(AGENT_IDS),
                        z.string().trim().min(1).max(100),
                    )
                    .optional(),
            })
            .optional(),
        // null = no limit
        limits: z
            .object({
                maxTurns: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .nullable()
                    .optional(),
                maxBudgetUsd: z
                    .number()
                    .positive()
                    .max(1000)
                    .nullable()
                    .optional(),
            })
            .optional(),
        // null removes the key (Claude then falls back to the Claude Code login)
        apiKeys: z
            .partialRecord(
                z.enum(PROVIDER_IDS),
                z
                    .string()
                    .trim()
                    .min(8, "That key looks too short")
                    .max(500)
                    .nullable(),
            )
            .optional(),
    })
    .strict();

export type UpdateSettingsSchemaType = z.infer<typeof UpdateSettingsSchema>;

export const VerifyProviderSchema = z.object({
    provider: z.enum(PROVIDER_IDS),
});

export type VerifyProviderSchemaType = z.infer<typeof VerifyProviderSchema>;

export type IncomingMessgageType =
    | {
          type: "create-workspace";
          payload: CreateWorkspaceSchemaType;
      }
    | {
          type: "create-session";
          payload: CreateSessionSchemaType;
      }
    | {
          type: "add-message";
          payload: AddMessageSchemaType;
      }
    | {
          type: "delete-workspace";
          payload: DeleteWorkspaceSchemaType;
      }
    | {
          type: "delete-session";
          payload: DeleteSessionSchemaType;
      }
    | {
          type: "rename-session";
          payload: RenameSessionSchemaType;
      }
    | {
          type: "stop-run";
          payload: StopRunSchemaType;
      }
    | {
          type: "permission-response";
          payload: PermissionResponseSchemaType;
      }
    | {
          type: "list-skills";
          payload: ListSkillsSchemaType;
      }
    | {
          type: "update-session-tools";
          payload: UpdateSessionToolsSchemaType;
      }
    | {
          type: "create-skill";
          payload: CreateSkillSchemaType;
      }
    | {
          type: "create-integration";
          payload: CreateIntegrationSchemaType;
      }
    | {
          type: "delete-integration";
          payload: IntegrationIdSchemaType;
      }
    | {
          type: "test-integration";
          payload: IntegrationIdSchemaType;
      }
    | {
          type: "update-settings";
          payload: UpdateSettingsSchemaType;
      }
    | {
          type: "verify-provider";
          payload: VerifyProviderSchemaType;
      };
