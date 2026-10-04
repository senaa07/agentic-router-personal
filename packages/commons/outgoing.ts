import z from "zod";
import {
    AGENT_IDS,
    type AgentId,
    type EDIT_MODES,
    type ProviderId,
    type THEMES,
} from "./incoming";

export const WorkspaceCreatedSchema = z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
});

export type WorkspaceCreatedSchemaType = z.infer<typeof WorkspaceCreatedSchema>;

export const SessionCreatedSchema = z.object({
    id: z.string(),
    workspaceId: z.string(),
    agent: z.enum(AGENT_IDS),
});

export type SessionCreatedSchemaType = z.infer<typeof SessionCreatedSchema>;

export const MessageAddedSchema = z.object({
    sessionId: z.string(),
    message: z.object({
        id: z.string(),
        role: z.literal("user"),
        payload: z.object({ message: z.string() }),
    }),
});

export type MessageAddedSchemaType = z.infer<typeof MessageAddedSchema>;

export type AssistantMessageAddedType = {
    sessionId: string;
    message: Message;
};

export type OutgoingMessageType =
    | {
          type: "workspace-created";
          payload: WorkspaceCreatedSchemaType;
      }
    | {
          type: "session-created";
          payload: SessionCreatedSchemaType;
      }
    | {
          type: "message-added";
          payload: MessageAddedSchemaType;
      }
    | {
          type: "init";
          workspaces: Workspace[];
      }
    | {
          type: "assistant-message";
          payload: AssistantMessageAddedType;
      }
    | {
          // Streamed live while the agent runs, one per tool call
          type: "tool-use";
          payload: { sessionId: string; tool: ToolUse };
      }
    | {
          type: "workspace-deleted";
          payload: { id: string };
      }
    | {
          type: "session-deleted";
          payload: { id: string };
      }
    | {
          type: "session-renamed";
          payload: { id: string; name: string };
      }
    | {
          // Any failed request. sessionId is set when the request was about a session
          type: "error";
          payload: { message: string; sessionId?: string };
      }
    | {
          // Sent once per connection, when the SDK's model list is ready
          type: "models";
          payload: { agent: AgentId; models: ModelOption[] };
      }
    | {
          // Sent on connect: which agents exist and which can run here
          type: "agents";
          payload: { agents: AgentInfo[] };
      }
    | {
          // Streamed live: a chunk of the agent's reply text, from the API's text_delta events
          type: "text-delta";
          payload: { sessionId: string; text: string };
      }
    | {
          // Ack for stop-run; the run then ends with an assistant-message of type "stopped"
          type: "stop-requested";
          payload: { sessionId: string };
      }
    | {
          // The agent is paused until the user approves or denies this tool call
          type: "permission-request";
          payload: { sessionId: string; request: PermissionRequest };
      }
    | {
          // The request was answered (by the user, or denied because the run stopped)
          type: "permission-resolved";
          payload: { sessionId: string; requestId: string };
      }
    | {
          // Sent on connect and after any change: the full list
          type: "integrations";
          payload: { integrations: Integration[] };
      }
    | {
          // Reply to list-skills / create-skill
          type: "skills";
          payload: { sessionId: string; skills: SkillInfo[] };
      }
    | {
          type: "session-tools-updated";
          payload: { id: string; skills: string[]; integrations: string[] };
      }
    | {
          // Sent on connect and after every update
          type: "settings";
          payload: { settings: ClientSettings };
      }
    | {
          type: "provider-verified";
          payload: { provider: ProviderId; ok: boolean; message: string };
      }
    | {
          type: "integration-tested";
          payload: {
              id: string;
              name: string;
              ok: boolean;
              status: string; // e.g. "connected", "failed", "needs-auth"
              error?: string;
          };
      };

export type SkillInfo = { name: string; description: string };

// An MCP server or plugin, as the browser sees it. Env and header values are never
// sent (they're usually API keys); only their names are.
export type Integration = {
    id: string;
    name: string;
    kind: "stdio" | "http" | "sse" | "plugin";
    trusted: boolean;
    summary: string; // command line, URL or plugin folder
    secretKeys: string[];
};

export type PermissionRequest = {
    requestId: string;
    name: string; // tool name, e.g. "Edit", "Bash", "ExitPlanMode"
    file?: string;
    detail?: string; // what it will do: the diff, command or plan (truncated)
};

// From the SDK's supportedModels(); `value` is what add-message's `model` takes
export type ModelOption = {
    value: string;
    displayName: string;
    description: string;
};

export type Workspace = {
    id: string;
    name: string;
    path: string;
    sessions: Session[];
};

export type AgentInfo = {
    id: AgentId;
    name: string; // e.g. "Claude Code"
    available: boolean;
    reason?: string; // why it isn't available (not installed, not implemented...)
    // What the UI may offer for this agent's sessions
    capabilities: {
        skills: boolean; // lists skills
        skillFilter: boolean; // can load just a chosen subset
        integrations: boolean; // MCP servers
        modes: (typeof EDIT_MODES)[number][]; // edit modes it supports
    };
};

export type Session = {
    id: string;
    agent: AgentId;
    name?: string;
    messages: Message[];
    skills?: string[]; // empty/absent = all skills
    integrations?: string[]; // enabled Integration ids
};

export type Message =
    | {
          id: string;
          role: "user";
          payload: {
              message: string;
          };
      }
    | {
          id: string;
          role: "assistant";
          // "error" = the agent run failed; message holds the reason.
          // "stopped" = the user stopped it; message holds the text streamed until then
          payload: {
              type?: "result" | "error" | "stopped";
              message: string;
              tools?: ToolUse[];
              // Absent if the run crashed before the SDK reported a result
              usage?: Usage;
          };
      };

export type ToolUse = { name: string; file?: string };

// One agent run, from the SDK's result message. Token counts are summed over all its turns.
export type Usage = {
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    costUsd?: number; // absent when the agent doesn't report cost (Codex)
    inputTokens: number; // uncached input
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    model?: string;
    // Context in use: the last API call's prompt size (input + cache read + cache write) vs the model's window
    contextTokens?: number;
    contextWindow?: number;
};

export type ConnectionResponse = {
    workspaces: Workspace[];
};

// App settings as the browser sees them. API keys are never sent: only whether one is set
// and its last 4 characters.
export type ClientSettings = {
    profile: { name: string };
    theme: (typeof THEMES)[number];
    defaults: {
        agent: AgentId;
        mode: (typeof EDIT_MODES)[number];
        models: Partial<Record<AgentId, string>>;
    };
    limits: { maxTurns: number | null; maxBudgetUsd: number | null };
    providers: {
        id: ProviderId;
        name: string; // "Anthropic"
        agents: AgentId[]; // which agents use it
        keySet: boolean;
        keyHint?: string; // "…1234"
        note: string; // e.g. "Leave empty to use your Claude Code login."
    }[];
};
