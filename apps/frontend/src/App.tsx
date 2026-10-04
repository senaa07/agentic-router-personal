import { useSocket } from "./hooks/useSocket";
import { AppContext, type ProviderCheck } from "./context/AppContext";
import type {
    IncomingMessgageType,
    OutgoingMessageType,
    Session,
    SkillInfo,
    ToolUse,
    Integration,
    AgentId,
    AgentInfo,
    ClientSettings,
    ProviderId,
    UpdateSettingsSchemaType,
    ModelOption,
    PermissionRequest,
    Usage,
    Workspace,
} from "commons/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "@/components/ui/accordion";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
    Bot,
    ChevronsUpDown,
    CircleAlert,
    CircleCheck,
    Gauge,
    KeyRound,
    Monitor,
    Palette,
    Settings as SettingsIcon,
    ShieldCheck,
    SlidersHorizontal,
    UserRound,
    Clock,
    FileText,
    Folder,
    GripVertical,
    Loader2,
    MessageSquare,
    MessageSquareQuote,
    Moon,
    MoreHorizontal,
    Pencil,
    Plug,
    Plus,
    Sparkles,
    Square,
    Sun,
    Trash2,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./index.css";
import { useContext, useEffect, useRef, useState } from "react";

export function App() {
    const { socket, status } = useSocket();
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    // In-progress agent runs (streamed text + tools so far), keyed by sessionId
    const [liveRuns, setLiveRuns] = useState<Record<string, LiveRun>>({});
    const updateRun = (sessionId: string, f: (run: LiveRun) => LiveRun) =>
        setLiveRuns((runs) => ({
            ...runs,
            [sessionId]: f(runs[sessionId] ?? NEW_RUN),
        }));
    const endRun = (sessionId: string) =>
        setLiveRuns(({ [sessionId]: _, ...rest }) => rest);
    // Model list per agent, and which agents exist / can run (for the New session picker)
    const [models, setModels] = useState<
        Partial<Record<AgentId, ModelOption[]>>
    >({});
    const [agents, setAgents] = useState<AgentInfo[]>([]);
    const activeAgent = agents.find(
        (a) =>
            a.id ===
            workspaces
                .flatMap((w) => w.sessions)
                .find((s) => s.id === activeSessionId)?.agent,
    );
    const [integrations, setIntegrations] = useState<Integration[]>([]);
    const [skillLists, setSkillLists] = useState<Record<string, SkillInfo[]>>(
        {},
    );
    // App settings (stored on the server). null until the first "settings" message.
    const [settings, setSettings] = useState<ClientSettings | null>(null);
    // Latest Verify result per provider; "pending" while waiting
    const [providerChecks, setProviderChecks] = useState<
        Partial<Record<ProviderId, ProviderCheck>>
    >({});
    // Saves a partial update. `local` applies it right away; the server's reply then confirms it.
    const saveSettings = (
        patch: UpdateSettingsSchemaType,
        local?: (s: ClientSettings) => ClientSettings,
    ) => {
        if (send(socket, { type: "update-settings", payload: patch }) && local)
            setSettings((s) => s && local(s));
    };
    const mode = settings?.defaults.mode ?? "default";
    const setMode = (mode: EditMode) =>
        saveSettings({ defaults: { mode } }, (s) => ({
            ...s,
            defaults: { ...s.defaults, mode },
        }));
    const setModel = (agent: AgentId, model: string) =>
        saveSettings({ defaults: { models: { [agent]: model } } }, (s) => ({
            ...s,
            defaults: {
                ...s.defaults,
                models: { ...s.defaults.models, [agent]: model },
            },
        }));

    // Theme: "system" follows the OS, live
    const [systemDark, setSystemDark] = useState(
        () => matchMedia("(prefers-color-scheme: dark)").matches,
    );
    useEffect(() => {
        const media = matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => setSystemDark(media.matches);
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, []);
    const theme = settings?.theme ?? "system";
    const dark = theme === "dark" || (theme === "system" && systemDark);
    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
    }, [dark]);

    useEffect(() => {
        if (socket) {
            socket.onmessage = (event) => {
                let data: OutgoingMessageType;
                try {
                    data = JSON.parse(event.data);
                } catch {
                    console.error(
                        "Unparseable message from server:",
                        event.data,
                    );
                    return;
                }
                if (data.type === "init") {
                    // Newest first, so a just-added workspace shows at the top
                    setWorkspaces([...data.workspaces].reverse());
                    // Fresh connection: events from runs on the old one are lost, and
                    // their results are already in `workspaces` if they finished
                    setLiveRuns({});
                }
                if (data.type === "integrations") {
                    setIntegrations(data.payload.integrations);
                }
                if (data.type === "skills") {
                    const { sessionId, skills } = data.payload;
                    setSkillLists((lists) => ({
                        ...lists,
                        [sessionId]: skills,
                    }));
                }
                if (data.type === "session-tools-updated") {
                    const { id, skills, integrations } = data.payload;
                    setWorkspaces((workspaces) =>
                        workspaces.map((w) => ({
                            ...w,
                            sessions: w.sessions.map((s) =>
                                s.id === id
                                    ? { ...s, skills, integrations }
                                    : s,
                            ),
                        })),
                    );
                    toast.success("Session skills & tools saved");
                }
                if (data.type === "integration-tested") {
                    const { id, name, ok, status, error } = data.payload;
                    // Same id as the "Testing..." toast, so it replaces it
                    const opts = { id: `test-${id}` };
                    if (ok) toast.success(`${name}: ${status}`, opts);
                    else
                        toast.error(
                            `${name}: ${status}${error ? ` - ${error}` : ""}`,
                            opts,
                        );
                }
                if (data.type === "settings") {
                    setSettings(data.payload.settings);
                }
                if (data.type === "provider-verified") {
                    const { provider, ok, message } = data.payload;
                    setProviderChecks((c) => ({
                        ...c,
                        [provider]: { ok, message },
                    }));
                }
                if (data.type === "error") {
                    // A failed Verify still has to stop its spinner
                    setProviderChecks((c) =>
                        Object.fromEntries(
                            Object.entries(c).filter(
                                ([, v]) => v !== "pending",
                            ),
                        ),
                    );
                }
                if (data.type === "agents") {
                    setAgents(data.payload.agents);
                }
                if (data.type === "models") {
                    const { agent, models } = data.payload;
                    setModels((all) => ({ ...all, [agent]: models }));
                }
                if (data.type === "error") {
                    toast.error(data.payload.message);
                    const { sessionId } = data.payload;
                    if (sessionId) endRun(sessionId);
                }
                if (data.type === "workspace-created") {
                    setWorkspaces((workspaces) => [
                        { ...data.payload, sessions: [] },
                        ...workspaces,
                    ]);
                }
                if (data.type === "session-created") {
                    const { id, workspaceId, agent } = data.payload;
                    setWorkspaces((workspaces) =>
                        workspaces.map((w) =>
                            w.id === workspaceId
                                ? {
                                      ...w,
                                      sessions: [
                                          ...w.sessions,
                                          { id, agent, messages: [] },
                                      ],
                                  }
                                : w,
                        ),
                    );
                    setActiveSessionId(id);
                }
                if (
                    data.type === "message-added" ||
                    data.type === "assistant-message"
                ) {
                    const { sessionId, message } = data.payload;
                    setWorkspaces((workspaces) =>
                        workspaces.map((w) => ({
                            ...w,
                            sessions: w.sessions.map((s) =>
                                s.id === sessionId
                                    ? {
                                          ...s,
                                          messages: [...s.messages, message],
                                      }
                                    : s,
                            ),
                        })),
                    );
                    // User message starts a live run; the final reply ends it
                    if (data.type === "message-added") {
                        updateRun(sessionId, () => NEW_RUN);
                    } else {
                        endRun(sessionId);
                    }
                }
                if (data.type === "workspace-deleted") {
                    // Conversation falls back to "Select a session" if the active one was inside
                    setWorkspaces((workspaces) =>
                        workspaces.filter((w) => w.id !== data.payload.id),
                    );
                }
                if (data.type === "session-deleted") {
                    const { id } = data.payload;
                    setWorkspaces((workspaces) =>
                        workspaces.map((w) => ({
                            ...w,
                            sessions: w.sessions.filter((s) => s.id !== id),
                        })),
                    );
                    setActiveSessionId((active) =>
                        active === id ? null : active,
                    );
                    endRun(id);
                }
                if (data.type === "session-renamed") {
                    const { id, name } = data.payload;
                    setWorkspaces((workspaces) =>
                        workspaces.map((w) => ({
                            ...w,
                            sessions: w.sessions.map((s) =>
                                s.id === id ? { ...s, name } : s,
                            ),
                        })),
                    );
                }
                if (data.type === "tool-use") {
                    const { sessionId, tool } = data.payload;
                    updateRun(sessionId, (run) => ({
                        ...run,
                        tools: [...run.tools, tool],
                    }));
                }
                if (data.type === "text-delta") {
                    const { sessionId, text } = data.payload;
                    updateRun(sessionId, (run) => ({
                        ...run,
                        text: run.text + text,
                    }));
                }
                if (data.type === "permission-request") {
                    const { sessionId, request } = data.payload;
                    updateRun(sessionId, (run) => ({
                        ...run,
                        approvals: [...run.approvals, request],
                    }));
                }
                if (data.type === "permission-resolved") {
                    const { sessionId, requestId } = data.payload;
                    updateRun(sessionId, (run) => ({
                        ...run,
                        approvals: run.approvals.filter(
                            (a) => a.requestId !== requestId,
                        ),
                    }));
                }
                if (data.type === "stop-requested") {
                    updateRun(data.payload.sessionId, (run) => ({
                        ...run,
                        stopping: true,
                    }));
                }
            };
        }
    }, [socket]);

    return (
        <AppContext.Provider
            value={{
                workspaces,
                socket,
                setWorkspaces,
                integrations,
                skillLists,
                agents,
                models,
                settings,
                saveSettings,
                providerChecks,
                setProviderChecks,
            }}
        >
            {/* Top: at the default bottom-right, toasts cover the Send button */}
            <Toaster
                theme={dark ? "dark" : "light"}
                position="top-center"
                richColors
                closeButton
            />
            <div className="flex h-screen flex-col">
                {status !== "open" && (
                    <div
                        role="status"
                        className={cn(
                            "flex items-center justify-center gap-2 px-3 py-1.5 text-sm",
                            status === "closed"
                                ? "bg-destructive text-white"
                                : "bg-muted text-muted-foreground",
                        )}
                    >
                        <Loader2 className="size-3.5 animate-spin" />
                        {status === "connecting"
                            ? "Connecting to server..."
                            : "Disconnected from server. Reconnecting..."}
                    </div>
                )}
                <div className="flex min-h-0 flex-1">
                    <aside className="flex w-72 shrink-0 flex-col border-r">
                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
                            <Sidebar
                                activeSessionId={activeSessionId}
                                setActiveSessionId={setActiveSessionId}
                            />
                        </div>
                        <ProfileMenu />
                    </aside>
                    <main className="flex min-w-0 flex-1 flex-col">
                        <header className="flex items-center justify-end gap-1 border-b p-2">
                            {activeAgent && (
                                <span className="mr-auto flex items-center gap-1.5 px-2 text-sm text-muted-foreground">
                                    <Bot className="size-4" />
                                    {activeAgent.name}
                                </span>
                            )}
                            <IntegrationsDialog />
                            <PromptsDialog />
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Toggle dark mode"
                                onClick={() => {
                                    const next = dark ? "light" : "dark";
                                    saveSettings({ theme: next }, (s) => ({
                                        ...s,
                                        theme: next,
                                    }));
                                }}
                            >
                                {dark ? <Sun /> : <Moon />}
                            </Button>
                        </header>
                        <Conversation
                            sessionId={activeSessionId}
                            liveRun={
                                activeSessionId
                                    ? liveRuns[activeSessionId]
                                    : undefined
                            }
                            models={models}
                            modelFor={settings?.defaults.models ?? {}}
                            setModel={setModel}
                            mode={mode}
                            setMode={setMode}
                        />
                    </main>
                </div>
            </div>
        </AppContext.Provider>
    );
}

function Sidebar({
    activeSessionId,
    setActiveSessionId,
}: {
    activeSessionId: string | null;
    setActiveSessionId: (id: string) => void;
}) {
    const { workspaces, socket, agents, settings } = useContext(AppContext);
    const defaultAgent = settings?.defaults.agent ?? "claude";
    // The default agent (Settings > Defaults) first
    const pickerAgents = [...agents].sort(
        (a, b) => Number(b.id === defaultAgent) - Number(a.id === defaultAgent),
    );
    const [path, setPath] = useState("");
    // Clear the path box once a workspace is actually added
    const workspaceCount = useRef(workspaces.length);
    useEffect(() => {
        if (workspaces.length > workspaceCount.current) setPath("");
        workspaceCount.current = workspaces.length;
    }, [workspaces.length]);
    // `open` is separate from the target so dialog text doesn't blank out during the close animation
    const [renaming, setRenaming] = useState<{
        id: string;
        name: string;
        open: boolean;
    } | null>(null);
    const [deleting, setDeleting] = useState<{
        kind: "workspace" | "session";
        id: string;
        label: string;
        open: boolean;
    } | null>(null);
    // Session whose "Skills & tools" dialog is open
    const [toolsFor, setToolsFor] = useState<string | null>(null);
    const toolsSession =
        workspaces.flatMap((w) => w.sessions).find((s) => s.id === toolsFor) ??
        null;
    const { openAfterMenu, runAfterMenu } = useAfterMenu();
    return (
        <>
            <form
                className="flex gap-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!path.trim()) return;
                    // Not cleared here: if the server rejects the path, the user can fix the typo
                    send(socket, {
                        type: "create-workspace",
                        payload: { path },
                    });
                }}
            >
                <Input
                    placeholder="Enter a path..."
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                />
                <Button
                    type="submit"
                    size="icon"
                    aria-label="Add workspace"
                    disabled={!path.trim()}
                >
                    <Plus />
                </Button>
            </form>

            <Accordion type="multiple" className="space-y-2">
                {workspaces.map((w) => (
                    <AccordionItem
                        key={w.id}
                        value={w.id}
                        className="rounded-lg border bg-card px-3 shadow-xs last:border-b"
                    >
                        <div className="flex items-center gap-1">
                            {/* Menu sits beside the trigger: a button can't be nested inside another button */}
                            <div className="min-w-0 flex-1">
                                <AccordionTrigger className="min-w-0 items-center py-3 hover:no-underline">
                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <div className="truncate font-medium">
                                                {w.name}
                                            </div>
                                            <div className="truncate text-xs font-normal text-muted-foreground">
                                                {w.path}
                                            </div>
                                        </div>
                                        <Badge
                                            variant="secondary"
                                            className="ml-auto"
                                        >
                                            {w.sessions.length}
                                        </Badge>
                                    </div>
                                </AccordionTrigger>
                            </div>
                            <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Options for ${w.name}`}
                                    >
                                        <MoreHorizontal />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    onCloseAutoFocus={runAfterMenu}
                                >
                                    <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={() =>
                                            openAfterMenu(() =>
                                                setDeleting({
                                                    kind: "workspace",
                                                    id: w.id,
                                                    label: w.name,
                                                    open: true,
                                                }),
                                            )
                                        }
                                    >
                                        <Trash2 /> Delete workspace
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                        <AccordionContent className="space-y-1">
                            {w.sessions.map((s) => (
                                <ContextMenu key={s.id} modal={false}>
                                    <ContextMenuTrigger asChild>
                                        <button
                                            onClick={() =>
                                                setActiveSessionId(s.id)
                                            }
                                            className={cn(
                                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent data-[state=open]:bg-accent",
                                                s.id === activeSessionId &&
                                                    "bg-accent",
                                            )}
                                        >
                                            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                                            <span className="truncate">
                                                {sessionLabel(s)}
                                            </span>
                                            <Badge
                                                variant="outline"
                                                className="ml-auto"
                                            >
                                                {s.messages.length}
                                            </Badge>
                                        </button>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent
                                        onCloseAutoFocus={runAfterMenu}
                                    >
                                        <ContextMenuItem
                                            onSelect={() =>
                                                openAfterMenu(() =>
                                                    setRenaming({
                                                        id: s.id,
                                                        name: sessionLabel(s),
                                                        open: true,
                                                    }),
                                                )
                                            }
                                        >
                                            <Pencil /> Rename
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            onSelect={() =>
                                                openAfterMenu(() =>
                                                    setToolsFor(s.id),
                                                )
                                            }
                                        >
                                            <Sparkles /> Skills & tools
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem
                                            variant="destructive"
                                            onSelect={() =>
                                                openAfterMenu(() =>
                                                    setDeleting({
                                                        kind: "session",
                                                        id: s.id,
                                                        label: sessionLabel(s),
                                                        open: true,
                                                    }),
                                                )
                                            }
                                        >
                                            <Trash2 /> Delete
                                        </ContextMenuItem>
                                    </ContextMenuContent>
                                </ContextMenu>
                            ))}
                            {/* Pick the agent up front: a session stays on one agent, since
                                only that agent can resume its history */}
                            <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="w-full justify-start text-muted-foreground"
                                    >
                                        <Plus /> New session
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="start"
                                    className="w-64"
                                >
                                    <DropdownMenuLabel>
                                        Run with
                                    </DropdownMenuLabel>
                                    {agents.length === 0 && (
                                        <DropdownMenuItem disabled>
                                            Loading agents...
                                        </DropdownMenuItem>
                                    )}
                                    {pickerAgents.map((a) => (
                                        <DropdownMenuItem
                                            key={a.id}
                                            disabled={!a.available}
                                            onSelect={() =>
                                                send(socket, {
                                                    type: "create-session",
                                                    payload: {
                                                        workspaceId: w.id,
                                                        agent: a.id,
                                                    },
                                                })
                                            }
                                            className="items-start"
                                        >
                                            <Bot className="mt-0.5" />
                                            <span className="flex flex-col">
                                                <span>
                                                    {a.name}
                                                    {a.id === defaultAgent && (
                                                        <span className="ml-1.5 text-xs text-muted-foreground">
                                                            default
                                                        </span>
                                                    )}
                                                </span>
                                                {!a.available && (
                                                    <span className="text-xs text-muted-foreground">
                                                        {a.reason}
                                                    </span>
                                                )}
                                            </span>
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </AccordionContent>
                    </AccordionItem>
                ))}
            </Accordion>

            <SessionToolsDialog
                session={toolsSession}
                onClose={() => setToolsFor(null)}
            />

            <Dialog
                open={!!renaming?.open}
                onOpenChange={(open) =>
                    !open && setRenaming((r) => r && { ...r, open: false })
                }
            >
                <DialogContent aria-describedby={undefined}>
                    <form
                        className="space-y-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!renaming || !renaming.name.trim()) return;
                            // Stays open if not sent, so the typed name isn't lost
                            const sent = send(socket, {
                                type: "rename-session",
                                payload: {
                                    sessionId: renaming.id,
                                    name: renaming.name,
                                },
                            });
                            if (sent) setRenaming({ ...renaming, open: false });
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>Rename session</DialogTitle>
                        </DialogHeader>
                        <Input
                            autoFocus
                            maxLength={100}
                            value={renaming?.name ?? ""}
                            onChange={(e) =>
                                setRenaming(
                                    (r) => r && { ...r, name: e.target.value },
                                )
                            }
                        />
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button type="button" variant="outline">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button
                                type="submit"
                                disabled={!renaming?.name.trim()}
                            >
                                Save
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <AlertDialog
                open={!!deleting?.open}
                onOpenChange={(open) =>
                    !open && setDeleting((d) => d && { ...d, open: false })
                }
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Delete {deleting?.kind}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            "{deleting?.label}"
                            {deleting?.kind === "workspace"
                                ? " and all of its sessions"
                                : " and its messages"}{" "}
                            will be permanently deleted. This can't be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={() =>
                                deleting &&
                                send(
                                    socket,
                                    deleting.kind === "workspace"
                                        ? {
                                              type: "delete-workspace",
                                              payload: {
                                                  workspaceId: deleting.id,
                                              },
                                          }
                                        : {
                                              type: "delete-session",
                                              payload: {
                                                  sessionId: deleting.id,
                                              },
                                          },
                                )
                            }
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

function sessionLabel(s: Session) {
    if (s.name) return s.name;
    return s.messages[0]?.role === "user"
        ? s.messages[0].payload.message
        : "New session";
}

// Typed send. When disconnected it tells the user instead of throwing; returns whether it was sent
function send(socket: WebSocket | null, msg: IncomingMessgageType): boolean {
    if (socket?.readyState !== WebSocket.OPEN) {
        toast.error(
            "Not connected to the server. Try again once it reconnects.",
        );
        return false;
    }
    socket.send(JSON.stringify(msg));
    return true;
}

const compact = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
});
const fmtTokens = (n: number) => compact.format(n);
const fmtDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    return s < 60
        ? `${s.toFixed(1)}s`
        : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
};
const fmtCost = (usd: number) =>
    usd === 0 ? "$0" : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
// Everything sent to the model: uncached input + cache read + cache write
const inputTotal = (u: Usage) =>
    u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
const inputBreakdown = (u: Usage) =>
    `${u.inputTokens.toLocaleString()} new · ${u.cacheReadTokens.toLocaleString()} cache read · ${u.cacheCreationTokens.toLocaleString()} cache write`;

function MessageStats({ usage: u }: { usage: Usage }) {
    return (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-xs text-muted-foreground">
            <span
                className="flex items-center gap-1"
                title={`Total ${fmtDuration(u.durationMs)}, of which API ${fmtDuration(u.durationApiMs)}`}
            >
                <Clock className="size-3" />
                {fmtDuration(u.durationMs)}
            </span>
            <span>
                {u.numTurns} {u.numTurns === 1 ? "turn" : "turns"}
            </span>
            <span title={inputBreakdown(u)}>
                {fmtTokens(inputTotal(u))} in
                {u.cacheReadTokens > 0 &&
                    ` (${fmtTokens(u.cacheReadTokens)} cached)`}
            </span>
            <span>{fmtTokens(u.outputTokens)} out</span>
            {/* Not every agent reports cost (Codex doesn't) */}
            {u.costUsd !== undefined && (
                <span title="Estimated cost from the SDK">
                    {fmtCost(u.costUsd)}
                </span>
            )}
            {u.model && <span>{u.model}</span>}
        </div>
    );
}

// Totals across every response in the session, plus how full the context is now
function SessionStats({ session }: { session: Session }) {
    const runs = session.messages.flatMap((m) =>
        m.role === "assistant" && m.payload.usage ? [m.payload.usage] : [],
    );
    if (!runs.length) return null;
    const sum = (f: (u: Usage) => number) => runs.reduce((a, u) => a + f(u), 0);
    // Context only grows within a session, so the latest run's size is the current one
    const ctx = runs.findLast(
        (u) => u.contextTokens != null && u.contextWindow,
    );
    const pct = ctx ? (ctx.contextTokens! / ctx.contextWindow!) * 100 : 0;

    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Session total</span>
            <span>
                {runs.length} {runs.length === 1 ? "response" : "responses"}
            </span>
            <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {fmtDuration(sum((u) => u.durationMs))}
            </span>
            <span title="Uncached input + cache read + cache write">
                {fmtTokens(sum(inputTotal))} in
            </span>
            <span>{fmtTokens(sum((u) => u.outputTokens))} out</span>
            {/* Sum only runs that reported a cost; hidden if none did */}
            {runs.some((u) => u.costUsd !== undefined) && (
                <span title="Estimated cost from the SDK">
                    {fmtCost(sum((u) => u.costUsd ?? 0))}
                </span>
            )}
            {ctx && (
                <span
                    className="ml-auto flex items-center gap-2"
                    title={`${ctx.contextTokens!.toLocaleString()} of ${ctx.contextWindow!.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
                >
                    Context {fmtTokens(ctx.contextTokens!)} /{" "}
                    {fmtTokens(ctx.contextWindow!)}
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                        <span
                            className={cn(
                                "block h-full rounded-full",
                                pct >= 90
                                    ? "bg-destructive"
                                    : pct >= 70
                                      ? "bg-amber-500"
                                      : "bg-primary",
                            )}
                            // At least a sliver, so a small context still shows
                            style={{ width: `${Math.max(pct, 1)}%` }}
                        />
                    </span>
                </span>
            )}
        </div>
    );
}

type LiveRun = {
    tools: ToolUse[];
    text: string;
    stopping: boolean;
    approvals: PermissionRequest[]; // tool calls waiting for Approve/Deny
};
const NEW_RUN: LiveRun = {
    tools: [],
    text: "",
    stopping: false,
    approvals: [],
};

type EditMode = "default" | "acceptEdits" | "plan";
// What the modes mean for an agent that can't ask before each change (Codex's sandbox modes)
const NO_ASK_MODE_DESCRIPTIONS: Record<EditMode, string> = {
    default: "",
    acceptEdits:
        "Changes and commands run without asking, sandboxed to the workspace",
    plan: "Read-only: can look around and plan, can't change anything",
};
const EDIT_MODES: { value: EditMode; label: string; description: string }[] = [
    {
        value: "default",
        label: "Ask before edits",
        description: "Approve each file change and command",
    },
    {
        value: "acceptEdits",
        label: "Auto-accept edits",
        description: "File changes run; commands still ask",
    },
    {
        value: "plan",
        label: "Plan only",
        description: "No changes; approve the plan to start",
    },
];

// A menu keeps focus until its close animation ends; a dialog opened before that loses
// focus to <body>. So menu items queue the dialog (openAfterMenu), and it opens once the
// menu is gone (runAfterMenu, as the menu content's onCloseAutoFocus).
function useAfterMenu() {
    const afterMenu = useRef<(() => void) | null>(null);
    return {
        openAfterMenu: (open: () => void) => {
            afterMenu.current = open;
        },
        runAfterMenu: (e: Event) => {
            e.preventDefault(); // don't refocus the trigger
            afterMenu.current?.();
            afterMenu.current = null;
        },
    };
}

// useState that survives reloads. Storage can be blocked (private mode), so it falls back silently.
function useStored<T>(key: string, initial: T) {
    const [value, setValue] = useState<T>(() => {
        try {
            const saved = localStorage.getItem(key);
            return saved === null ? initial : (JSON.parse(saved) as T);
        } catch {
            return initial;
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {}
    }, [key, value]);
    return [value, setValue] as const;
}

type Prompt = { id: string; name: string; body: string };
const PROMPT_TEMPLATE = `## Task
What should the agent do?

## Context
- Relevant files:
- Background:

## Requirements
-

## Done when
- `;

// Saved prompt templates. Not modal (no overlay), so a prompt can be dragged
// from here and dropped into the message box behind it.
function PromptsDialog() {
    const [prompts, setPrompts] = useStored<Prompt[]>("prompts", []);
    const [draft, setDraft] = useState<Prompt | null>(null); // being added or edited
    const save = () => {
        if (!draft || !draft.name.trim() || !draft.body.trim()) return;
        setPrompts((ps) =>
            ps.some((p) => p.id === draft.id)
                ? ps.map((p) => (p.id === draft.id ? draft : p))
                : [...ps, draft],
        );
        setDraft(null);
    };

    return (
        <Dialog modal={false} onOpenChange={() => setDraft(null)}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="sm">
                    <FileText /> Custom prompts
                </Button>
            </DialogTrigger>
            {/* Stays open while dropping into the message box (that's a click outside) */}
            <DialogContent
                aria-describedby={undefined}
                className="flex max-h-[80vh] flex-col sm:max-w-lg"
                onInteractOutside={(e) => e.preventDefault()}
            >
                <DialogHeader>
                    <DialogTitle>Custom prompts</DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        Drag a prompt into the message box to use it.
                    </p>
                </DialogHeader>

                {draft ? (
                    <div className="flex min-h-0 flex-col gap-2">
                        <Input
                            autoFocus
                            placeholder="Name"
                            value={draft.name}
                            onChange={(e) =>
                                setDraft({ ...draft, name: e.target.value })
                            }
                        />
                        <Textarea
                            className="min-h-60 font-mono text-sm"
                            placeholder="Write the prompt in Markdown"
                            value={draft.body}
                            onChange={(e) =>
                                setDraft({ ...draft, body: e.target.value })
                            }
                        />
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setDraft(null)}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={save}
                                disabled={
                                    !draft.name.trim() || !draft.body.trim()
                                }
                            >
                                Save
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="min-h-0 space-y-2 overflow-y-auto">
                            {prompts.length === 0 && (
                                <p className="py-6 text-center text-sm text-muted-foreground">
                                    No prompts yet.
                                </p>
                            )}
                            {prompts.map((p) => (
                                <div
                                    key={p.id}
                                    draggable
                                    onDragStart={(e) => {
                                        // Plain text: the textarea inserts it at the drop point natively
                                        e.dataTransfer.setData(
                                            "text/plain",
                                            p.body,
                                        );
                                        e.dataTransfer.effectAllowed = "copy";
                                    }}
                                    className="flex cursor-grab items-center gap-2 rounded-md border bg-card p-2 active:cursor-grabbing"
                                >
                                    <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium">
                                            {p.name}
                                        </div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {p.body.split("\n").find(Boolean)}
                                        </div>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Edit ${p.name}`}
                                        onClick={() => setDraft(p)}
                                    >
                                        <Pencil />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Delete ${p.name}`}
                                        onClick={() =>
                                            setPrompts((ps) =>
                                                ps.filter((x) => x.id !== p.id),
                                            )
                                        }
                                    >
                                        <Trash2 />
                                    </Button>
                                </div>
                            ))}
                        </div>
                        <Button
                            variant="outline"
                            onClick={() =>
                                setDraft({
                                    id: crypto.randomUUID(),
                                    name: "",
                                    body: PROMPT_TEMPLATE,
                                })
                            }
                        >
                            <Plus /> New prompt
                        </Button>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

const SKILL_TEMPLATE = `# Instructions
What should the agent do when this skill applies?

## Steps
1.

## Notes
- `;

// Right-click a session -> pick its skills and enable MCP servers / plugins.
// `session` null = closed.
function SessionToolsDialog({
    session,
    onClose,
}: {
    session: Session | null;
    onClose: () => void;
}) {
    const { socket, integrations, skillLists } = useContext(AppContext);
    // Keep showing the last session while the dialog animates closed
    const last = useRef(session);
    if (session) last.current = session;
    const shown = last.current;
    const skills = shown ? skillLists[shown.id] : undefined;

    const [allSkills, setAllSkills] = useState(true);
    const [picked, setPicked] = useState<string[]>([]);
    const [enabled, setEnabled] = useState<string[]>([]);
    const [search, setSearch] = useState("");
    const [draft, setDraft] = useState<{
        name: string;
        description: string;
        body: string;
        submitted: boolean;
    } | null>(null);

    // Each time it opens: start from the session's saved choice and refresh the skill list
    useEffect(() => {
        if (!session) return;
        setAllSkills(!session.skills?.length);
        setPicked(session.skills ?? []);
        setEnabled(session.integrations ?? []);
        setSearch("");
        setDraft(null);
        send(socket, {
            type: "list-skills",
            payload: { sessionId: session.id },
        });
    }, [session?.id]);

    // A created skill shows up in the refreshed list: close the form and select it
    useEffect(() => {
        if (draft?.submitted && skills?.some((s) => s.name === draft.name)) {
            setPicked((p) => [...new Set([...p, draft.name])]);
            setDraft(null);
        }
    }, [skills]);

    const toggle = (list: string[], value: string) =>
        list.includes(value)
            ? list.filter((v) => v !== value)
            : [...list, value];
    const q = search.trim().toLowerCase();
    const visible = (skills ?? [])
        .filter(
            (s) =>
                !q ||
                s.name.toLowerCase().includes(q) ||
                s.description.toLowerCase().includes(q),
        )
        // Selected first, so a new or picked skill isn't buried in a long list
        .sort(
            (a, b) =>
                Number(picked.includes(b.name)) -
                Number(picked.includes(a.name)),
        );
    // Agents that can't load a subset (Codex) always use all skills
    const { agents } = useContext(AppContext);
    const agentInfo = agents.find((a) => a.id === shown?.agent);
    const canFilter = agentInfo?.capabilities.skillFilter ?? true;
    const canSave = !canFilter || allSkills || picked.length > 0;

    return (
        <Dialog open={!!session} onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                aria-describedby={undefined}
                className="flex max-h-[85vh] flex-col sm:max-w-lg"
            >
                <DialogHeader>
                    <DialogTitle>Skills & tools</DialogTitle>
                    <p className="truncate text-sm text-muted-foreground">
                        For "{shown ? sessionLabel(shown) : ""}"
                    </p>
                </DialogHeader>

                {draft ? (
                    <div className="flex min-h-0 flex-col gap-2">
                        <Input
                            autoFocus
                            placeholder="skill-name (lowercase, dashes)"
                            value={draft.name}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    name: e.target.value,
                                    submitted: false,
                                })
                            }
                        />
                        <Input
                            placeholder="When should the agent use it?"
                            value={draft.description}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    description: e.target.value,
                                })
                            }
                        />
                        <Textarea
                            className="min-h-48 font-mono text-sm"
                            value={draft.body}
                            onChange={(e) =>
                                setDraft({ ...draft, body: e.target.value })
                            }
                        />
                        <p className="text-xs text-muted-foreground">
                            Saved to .claude/skills/{draft.name || "<name>"}
                            /SKILL.md in this workspace.
                        </p>
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setDraft(null)}
                            >
                                Cancel
                            </Button>
                            <Button
                                disabled={
                                    draft.submitted ||
                                    !draft.name.trim() ||
                                    !draft.description.trim()
                                }
                                onClick={() => {
                                    if (!shown) return;
                                    const sent = send(socket, {
                                        type: "create-skill",
                                        payload: {
                                            sessionId: shown.id,
                                            name: draft.name.trim(),
                                            description: draft.description,
                                            body: draft.body,
                                        },
                                    });
                                    // On error the server's toast explains; the form stays open
                                    if (sent)
                                        setDraft({ ...draft, submitted: true });
                                }}
                            >
                                {draft.submitted
                                    ? "Creating..."
                                    : "Create skill"}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex min-h-0 flex-col gap-2">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">
                                    Skills
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        setDraft({
                                            name: "",
                                            description: "",
                                            body: SKILL_TEMPLATE,
                                            submitted: false,
                                        })
                                    }
                                >
                                    <Plus /> New skill
                                </Button>
                            </div>
                            {!canFilter ? (
                                <>
                                    <p className="text-sm text-muted-foreground">
                                        {agentInfo?.name} always loads all of
                                        its skills:
                                    </p>
                                    <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1">
                                        {!skills && (
                                            <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                                                <Loader2 className="size-3.5 animate-spin" />
                                                Loading skills...
                                            </p>
                                        )}
                                        {skills?.length === 0 && (
                                            <p className="p-2 text-sm text-muted-foreground">
                                                No skills found.
                                            </p>
                                        )}
                                        {skills?.map((s) => (
                                            <div
                                                key={s.name}
                                                className="px-2 py-1.5"
                                            >
                                                <span className="block truncate text-sm">
                                                    {s.name}
                                                </span>
                                                <span className="line-clamp-1 text-xs text-muted-foreground">
                                                    {s.description}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            ) : (
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        className="accent-primary"
                                        checked={allSkills}
                                        onChange={(e) =>
                                            setAllSkills(e.target.checked)
                                        }
                                    />
                                    Use all skills (default)
                                </label>
                            )}
                            {canFilter && !allSkills && (
                                <>
                                    <Input
                                        placeholder={`Search ${skills?.length ?? ""} skills...`}
                                        value={search}
                                        onChange={(e) =>
                                            setSearch(e.target.value)
                                        }
                                    />
                                    <div className="max-h-56 min-h-0 space-y-0.5 overflow-y-auto rounded-md border p-1">
                                        {!skills && (
                                            <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                                                <Loader2 className="size-3.5 animate-spin" />
                                                Loading skills...
                                            </p>
                                        )}
                                        {skills && visible.length === 0 && (
                                            <p className="p-2 text-sm text-muted-foreground">
                                                No skills match.
                                            </p>
                                        )}
                                        {visible.map((s) => (
                                            <label
                                                key={s.name}
                                                className="flex cursor-pointer gap-2 rounded px-2 py-1.5 hover:bg-accent"
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="mt-1 accent-primary"
                                                    checked={picked.includes(
                                                        s.name,
                                                    )}
                                                    onChange={() =>
                                                        setPicked((p) =>
                                                            toggle(p, s.name),
                                                        )
                                                    }
                                                />
                                                <span className="min-w-0">
                                                    <span className="block truncate text-sm">
                                                        {s.name}
                                                    </span>
                                                    <span className="line-clamp-1 text-xs text-muted-foreground">
                                                        {s.description}
                                                    </span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {picked.length} selected
                                    </p>
                                </>
                            )}
                        </div>

                        <div className="space-y-2 border-t pt-3">
                            <span className="text-sm font-medium">
                                MCP servers & plugins
                            </span>
                            {integrations.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    None yet. Add them under Integrations in the
                                    top bar.
                                </p>
                            ) : (
                                <div className="max-h-40 space-y-0.5 overflow-y-auto">
                                    {integrations.map((i) => (
                                        <label
                                            key={i.id}
                                            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                                        >
                                            <input
                                                type="checkbox"
                                                className="accent-primary"
                                                checked={enabled.includes(i.id)}
                                                onChange={() =>
                                                    setEnabled((e) =>
                                                        toggle(e, i.id),
                                                    )
                                                }
                                            />
                                            <span className="truncate text-sm">
                                                {i.name}
                                            </span>
                                            <Badge variant="outline">
                                                {i.kind === "plugin"
                                                    ? "plugin"
                                                    : "MCP"}
                                            </Badge>
                                            {i.trusted && (
                                                <Badge variant="secondary">
                                                    trusted
                                                </Badge>
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {shown?.agent === "codex"
                                    ? "Codex can't ask before using an MCP tool, so only servers marked trusted are used. Plugins are Claude-only."
                                    : "Your own ~/.claude servers, plugins and skills load too. Each enabled server starts with every run."}
                            </p>
                        </div>

                        <DialogFooter>
                            <Button variant="outline" onClick={onClose}>
                                Cancel
                            </Button>
                            <Button
                                disabled={!canSave}
                                title={
                                    canSave
                                        ? undefined
                                        : "Pick at least one skill"
                                }
                                onClick={() => {
                                    if (!shown) return;
                                    const sent = send(socket, {
                                        type: "update-session-tools",
                                        payload: {
                                            sessionId: shown.id,
                                            skills:
                                                !canFilter || allSkills
                                                    ? []
                                                    : picked,
                                            integrations: enabled,
                                        },
                                    });
                                    if (sent) onClose();
                                }}
                            >
                                Save
                            </Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

type IntegrationForm = {
    name: string;
    kind: "stdio" | "http" | "sse" | "plugin";
    command: string;
    args: string; // one per line
    env: string; // KEY=value per line
    url: string;
    headers: string; // Key: value per line
    path: string;
    trusted: boolean;
    submitted: boolean;
};
const NEW_INTEGRATION: IntegrationForm = {
    name: "",
    kind: "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
    path: "",
    trusted: false,
    submitted: false,
};

// "KEY=value" / "Key: value" lines -> record (splits at the first separator)
function parsePairs(text: string, sep: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const at = line.indexOf(sep);
        if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
}

// Top bar: define MCP servers and plugins once, then enable them per session
function IntegrationsDialog() {
    const { socket, integrations } = useContext(AppContext);
    const [form, setForm] = useState<IntegrationForm | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    // The new integration appears in the refreshed list: close the form
    useEffect(() => {
        if (form?.submitted && integrations.some((i) => i.name === form.name)) {
            setForm(null);
        }
    }, [integrations]);

    const submit = (f: IntegrationForm) => {
        const config =
            f.kind === "stdio"
                ? {
                      kind: f.kind,
                      command: f.command.trim(),
                      args: f.args
                          .split("\n")
                          .map((a) => a.trim())
                          .filter(Boolean),
                      env: parsePairs(f.env, "="),
                  }
                : f.kind === "plugin"
                  ? { kind: f.kind, path: f.path.trim() }
                  : {
                        kind: f.kind,
                        url: f.url.trim(),
                        headers: parsePairs(f.headers, ":"),
                    };
        const sent = send(socket, {
            type: "create-integration",
            payload: { name: f.name.trim(), trusted: f.trusted, config },
        });
        // On error the server's toast explains; the form stays open to fix it
        if (sent) setForm({ ...f, submitted: true });
    };

    return (
        <Dialog onOpenChange={() => setForm(null)}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="sm">
                    <Plug /> Integrations
                </Button>
            </DialogTrigger>
            <DialogContent
                aria-describedby={undefined}
                className="flex max-h-[85vh] flex-col sm:max-w-lg"
            >
                <DialogHeader>
                    <DialogTitle>Integrations</DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        MCP servers and plugins. Enable them per session from
                        its right-click menu.
                    </p>
                </DialogHeader>

                {form ? (
                    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                        <Input
                            autoFocus
                            placeholder="Name (letters, numbers, dashes)"
                            value={form.name}
                            onChange={(e) =>
                                setForm({
                                    ...form,
                                    name: e.target.value,
                                    submitted: false,
                                })
                            }
                        />
                        <Select
                            value={form.kind}
                            onValueChange={(v) =>
                                setForm({
                                    ...form,
                                    kind: v as IntegrationForm["kind"],
                                })
                            }
                        >
                            <SelectTrigger aria-label="Type" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="stdio">
                                    MCP server (command)
                                </SelectItem>
                                <SelectItem value="http">
                                    MCP server (HTTP URL)
                                </SelectItem>
                                <SelectItem value="sse">
                                    MCP server (SSE URL)
                                </SelectItem>
                                <SelectItem value="plugin">
                                    Plugin (local folder)
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        {form.kind === "stdio" && (
                            <>
                                <Input
                                    className="font-mono"
                                    placeholder="Command, e.g. npx"
                                    value={form.command}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            command: e.target.value,
                                        })
                                    }
                                />
                                <Textarea
                                    className="min-h-16 font-mono text-sm"
                                    placeholder={
                                        "Arguments, one per line\n-y\n@modelcontextprotocol/server-github"
                                    }
                                    value={form.args}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            args: e.target.value,
                                        })
                                    }
                                />
                                <Textarea
                                    className="min-h-16 font-mono text-sm"
                                    placeholder={
                                        "Environment, KEY=value per line\nGITHUB_TOKEN=..."
                                    }
                                    value={form.env}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            env: e.target.value,
                                        })
                                    }
                                />
                            </>
                        )}
                        {(form.kind === "http" || form.kind === "sse") && (
                            <>
                                <Input
                                    className="font-mono"
                                    placeholder="https://example.com/mcp"
                                    value={form.url}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            url: e.target.value,
                                        })
                                    }
                                />
                                <Textarea
                                    className="min-h-16 font-mono text-sm"
                                    placeholder={
                                        "Headers, Key: value per line\nAuthorization: Bearer ..."
                                    }
                                    value={form.headers}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            headers: e.target.value,
                                        })
                                    }
                                />
                            </>
                        )}
                        {form.kind === "plugin" && (
                            <Input
                                className="font-mono"
                                placeholder="/path/to/plugin (has .claude-plugin/plugin.json)"
                                value={form.path}
                                onChange={(e) =>
                                    setForm({ ...form, path: e.target.value })
                                }
                            />
                        )}
                        {form.kind !== "plugin" && (
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="mt-1 accent-primary"
                                    checked={form.trusted}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            trusted: e.target.checked,
                                        })
                                    }
                                />
                                <span>
                                    Trusted
                                    <span className="block text-xs text-muted-foreground">
                                        Its tools run without asking, even in
                                        "Ask before edits".
                                    </span>
                                </span>
                            </label>
                        )}
                        <p className="text-xs text-muted-foreground">
                            Secrets stay on the server and aren't shown again.
                        </p>
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setForm(null)}
                            >
                                Cancel
                            </Button>
                            <Button
                                disabled={form.submitted || !form.name.trim()}
                                onClick={() => submit(form)}
                            >
                                {form.submitted ? "Adding..." : "Add"}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="min-h-0 space-y-2 overflow-y-auto">
                            {integrations.length === 0 && (
                                <p className="py-6 text-center text-sm text-muted-foreground">
                                    No integrations yet.
                                </p>
                            )}
                            {integrations.map((i) => (
                                <div
                                    key={i.id}
                                    className="flex items-center gap-2 rounded-md border bg-card p-2"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="truncate text-sm font-medium">
                                                {i.name}
                                            </span>
                                            <Badge variant="outline">
                                                {i.kind === "plugin"
                                                    ? "plugin"
                                                    : `MCP ${i.kind}`}
                                            </Badge>
                                            {i.trusted && (
                                                <Badge variant="secondary">
                                                    trusted
                                                </Badge>
                                            )}
                                        </div>
                                        <code className="block truncate text-xs text-muted-foreground">
                                            {i.summary}
                                        </code>
                                        {i.secretKeys.length > 0 && (
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {i.kind === "stdio"
                                                    ? "env"
                                                    : "headers"}
                                                : {i.secretKeys.join(", ")}
                                            </span>
                                        )}
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            if (
                                                send(socket, {
                                                    type: "test-integration",
                                                    payload: { id: i.id },
                                                })
                                            ) {
                                                // Replaced by the result toast (same id)
                                                toast.loading(
                                                    `Testing ${i.name}...`,
                                                    {
                                                        id: `test-${i.id}`,
                                                        // in case the request itself errors (that toast has no id)
                                                        duration: 30_000,
                                                    },
                                                );
                                            }
                                        }}
                                    >
                                        Test
                                    </Button>
                                    <Button
                                        variant={
                                            confirmDelete === i.id
                                                ? "destructive"
                                                : "ghost"
                                        }
                                        size={
                                            confirmDelete === i.id
                                                ? "sm"
                                                : "icon-sm"
                                        }
                                        aria-label={`Delete ${i.name}`}
                                        onBlur={() => setConfirmDelete(null)}
                                        onClick={() => {
                                            // Two clicks: the env/headers can't be recovered
                                            if (confirmDelete !== i.id) {
                                                setConfirmDelete(i.id);
                                                return;
                                            }
                                            send(socket, {
                                                type: "delete-integration",
                                                payload: { id: i.id },
                                            });
                                            setConfirmDelete(null);
                                        }}
                                    >
                                        {confirmDelete === i.id ? (
                                            "Delete?"
                                        ) : (
                                            <Trash2 />
                                        )}
                                    </Button>
                                </div>
                            ))}
                        </div>
                        <Button
                            variant="outline"
                            onClick={() => setForm(NEW_INTEGRATION)}
                        >
                            <Plus /> Add MCP server or plugin
                        </Button>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

const initials = (name: string) =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("") || "?";

type SettingsSection =
    "profile" | "providers" | "defaults" | "limits" | "appearance";

// Bottom of the sidebar: who's using the app; opens Settings
function ProfileMenu() {
    const { settings } = useContext(AppContext);
    const [section, setSection] = useState<SettingsSection | null>(null);
    const [shown, setShown] = useState<SettingsSection>("profile"); // kept while closing
    const { openAfterMenu, runAfterMenu } = useAfterMenu();
    const open = (s: SettingsSection) =>
        openAfterMenu(() => {
            setShown(s);
            setSection(s);
        });
    const name = settings?.profile.name.trim() ?? "";

    return (
        <div className="border-t p-2">
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                    <button
                        className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-accent data-[state=open]:bg-accent"
                        aria-label="Profile and settings"
                    >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                            {initials(name)}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                                {name || "Set your name"}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                                Settings & API keys
                            </span>
                        </span>
                        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    side="top"
                    align="start"
                    className="w-64"
                    onCloseAutoFocus={runAfterMenu}
                >
                    <DropdownMenuItem onSelect={() => open("profile")}>
                        <UserRound /> Profile
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => open("providers")}>
                        <KeyRound /> API keys & accounts
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => open("defaults")}>
                        <SettingsIcon /> Settings
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <SettingsDialog
                open={section !== null}
                onClose={() => setSection(null)}
                section={shown}
                setSection={setShown}
            />
        </div>
    );
}

const SETTINGS_SECTIONS: {
    id: SettingsSection;
    label: string;
    icon: React.ReactNode;
}[] = [
    { id: "profile", label: "Profile", icon: <UserRound /> },
    { id: "providers", label: "API keys", icon: <KeyRound /> },
    { id: "defaults", label: "Defaults", icon: <SlidersHorizontal /> },
    { id: "limits", label: "Limits", icon: <Gauge /> },
    { id: "appearance", label: "Appearance", icon: <Palette /> },
];

function SettingsDialog({
    open,
    onClose,
    section,
    setSection,
}: {
    open: boolean;
    onClose: () => void;
    section: SettingsSection;
    setSection: (s: SettingsSection) => void;
}) {
    const { settings } = useContext(AppContext);
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent
                aria-describedby={undefined}
                className="flex h-[min(560px,85vh)] flex-col gap-0 p-0 sm:max-w-2xl"
            >
                <DialogHeader className="border-b px-6 py-4">
                    <DialogTitle>Settings</DialogTitle>
                </DialogHeader>
                <div className="flex min-h-0 flex-1">
                    <nav className="w-44 shrink-0 space-y-0.5 border-r p-2">
                        {SETTINGS_SECTIONS.map((s) => (
                            <button
                                key={s.id}
                                onClick={() => setSection(s.id)}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground",
                                    section === s.id && "bg-accent font-medium",
                                )}
                            >
                                {s.icon}
                                {s.label}
                            </button>
                        ))}
                    </nav>
                    <div className="min-w-0 flex-1 overflow-y-auto p-6">
                        {!settings ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" />{" "}
                                Loading...
                            </p>
                        ) : section === "profile" ? (
                            <ProfileSettings />
                        ) : section === "providers" ? (
                            <ProviderSettings />
                        ) : section === "defaults" ? (
                            <DefaultSettings />
                        ) : section === "limits" ? (
                            <LimitSettings />
                        ) : (
                            <AppearanceSettings />
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function SettingRow({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="space-y-1.5">
            <div className="text-sm font-medium">{label}</div>
            {children}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

function ProfileSettings() {
    const { settings, saveSettings } = useContext(AppContext);
    const [name, setName] = useState(settings!.profile.name);
    const save = () => {
        if (name.trim() === settings!.profile.name) return;
        saveSettings({ profile: { name } }, (s) => ({
            ...s,
            profile: { name: name.trim() },
        }));
    };
    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <span className="flex size-12 items-center justify-center rounded-full bg-primary text-base font-medium text-primary-foreground">
                    {initials(name)}
                </span>
                <div className="text-sm text-muted-foreground">
                    Shown at the bottom of the sidebar.
                </div>
            </div>
            <SettingRow
                label="Display name"
                hint="Saved when you leave the field."
            >
                <Input
                    value={name}
                    maxLength={60}
                    placeholder="Your name"
                    onChange={(e) => setName(e.target.value)}
                    onBlur={save}
                    onKeyDown={(e) => e.key === "Enter" && save()}
                />
            </SettingRow>
        </div>
    );
}

function ProviderSettings() {
    const {
        settings,
        agents,
        socket,
        providerChecks,
        setProviderChecks,
        saveSettings,
    } = useContext(AppContext);
    const [drafts, setDrafts] = useState<Partial<Record<ProviderId, string>>>(
        {},
    );
    const verify = (id: ProviderId) => {
        if (
            send(socket, { type: "verify-provider", payload: { provider: id } })
        )
            setProviderChecks((c) => ({ ...c, [id]: "pending" }));
    };
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Keys are stored on this machine's server and never shown again;
                only their last 4 characters are.
            </p>
            {settings!.providers.map((p) => {
                const check = providerChecks[p.id];
                const draft = drafts[p.id] ?? "";
                const usedBy = p.agents
                    .map((id) => agents.find((a) => a.id === id)?.name ?? id)
                    .join(", ");
                return (
                    <div key={p.id} className="space-y-2 rounded-lg border p-4">
                        <div className="flex items-center gap-2">
                            <span className="font-medium">{p.name}</span>
                            <span className="text-xs text-muted-foreground">
                                for {usedBy}
                            </span>
                            <Badge
                                variant={p.keySet ? "secondary" : "outline"}
                                className="ml-auto"
                            >
                                {p.keySet ? `Key ${p.keyHint}` : "No key"}
                            </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {p.note}
                        </p>
                        <form
                            className="flex gap-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                if (!draft.trim()) return;
                                saveSettings({
                                    apiKeys: { [p.id]: draft.trim() },
                                });
                                setDrafts((d) => ({ ...d, [p.id]: "" }));
                                setProviderChecks(
                                    ({ [p.id]: _, ...rest }) => rest,
                                );
                            }}
                        >
                            <Input
                                type="password"
                                autoComplete="off"
                                placeholder={
                                    p.keySet
                                        ? "Replace key..."
                                        : "Paste API key..."
                                }
                                value={draft}
                                onChange={(e) =>
                                    setDrafts((d) => ({
                                        ...d,
                                        [p.id]: e.target.value,
                                    }))
                                }
                            />
                            <Button type="submit" disabled={!draft.trim()}>
                                Save
                            </Button>
                        </form>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={check === "pending"}
                                onClick={() => verify(p.id)}
                            >
                                {check === "pending" ? (
                                    <Loader2 className="animate-spin" />
                                ) : (
                                    <ShieldCheck />
                                )}
                                {p.keySet ? "Verify key" : "Check sign-in"}
                            </Button>
                            {p.keySet && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        saveSettings({
                                            apiKeys: { [p.id]: null },
                                        });
                                        setProviderChecks(
                                            ({ [p.id]: _, ...rest }) => rest,
                                        );
                                    }}
                                >
                                    Remove key
                                </Button>
                            )}
                        </div>
                        {check && check !== "pending" && (
                            <p
                                className={cn(
                                    "flex items-start gap-1.5 text-sm",
                                    check.ok
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-destructive",
                                )}
                            >
                                {check.ok ? (
                                    <CircleCheck className="mt-0.5 size-4 shrink-0" />
                                ) : (
                                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                                )}
                                {check.message}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function DefaultSettings() {
    const { settings, agents, models, saveSettings } = useContext(AppContext);
    const d = settings!.defaults;
    const available = agents.filter((a) => a.available);
    return (
        <div className="space-y-6">
            <SettingRow
                label="Default agent"
                hint="Listed first when you start a new session."
            >
                <Select
                    value={d.agent}
                    onValueChange={(agent) =>
                        saveSettings(
                            { defaults: { agent: agent as AgentId } },
                            (s) => ({
                                ...s,
                                defaults: {
                                    ...s.defaults,
                                    agent: agent as AgentId,
                                },
                            }),
                        )
                    }
                >
                    <SelectTrigger className="w-64" aria-label="Default agent">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {available.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                                {a.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </SettingRow>
            <SettingRow
                label="Edit mode"
                hint="Also changeable next to the message box; that's the same setting."
            >
                <Select
                    value={d.mode}
                    onValueChange={(mode) =>
                        saveSettings(
                            { defaults: { mode: mode as EditMode } },
                            (s) => ({
                                ...s,
                                defaults: {
                                    ...s.defaults,
                                    mode: mode as EditMode,
                                },
                            }),
                        )
                    }
                >
                    <SelectTrigger
                        className="w-64"
                        aria-label="Default edit mode"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {EDIT_MODES.map((m) => (
                            <SelectItem key={m.value} value={m.value}>
                                {m.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </SettingRow>
            {available.map((a) => {
                const list = models[a.id] ?? [];
                const value =
                    list.find((m) => m.value === d.models[a.id])?.value ??
                    list[0]?.value;
                return (
                    <SettingRow
                        key={a.id}
                        label={`${a.name} model`}
                        hint="Used for new messages in this agent's sessions."
                    >
                        <Select
                            value={value ?? ""}
                            disabled={!list.length}
                            onValueChange={(model) =>
                                saveSettings(
                                    { defaults: { models: { [a.id]: model } } },
                                    (s) => ({
                                        ...s,
                                        defaults: {
                                            ...s.defaults,
                                            models: {
                                                ...s.defaults.models,
                                                [a.id]: model,
                                            },
                                        },
                                    }),
                                )
                            }
                        >
                            <SelectTrigger
                                className="w-64"
                                aria-label={`${a.name} model`}
                            >
                                <SelectValue placeholder="Loading models..." />
                            </SelectTrigger>
                            <SelectContent>
                                {list.map((m) => (
                                    <SelectItem key={m.value} value={m.value}>
                                        {m.displayName}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingRow>
                );
            })}
        </div>
    );
}

// A number field that saves on blur. Empty = no limit (null).
function LimitField({
    label,
    hint,
    value,
    step,
    min,
    max,
    onSave,
}: {
    label: string;
    hint: string;
    value: number | null;
    step: number;
    min: number;
    max: number;
    onSave: (v: number | null) => void;
}) {
    const [text, setText] = useState(value?.toString() ?? "");
    const save = () => {
        const v = text.trim() === "" ? null : Number(text);
        if (v !== null && (!Number.isFinite(v) || v < min || v > max)) {
            toast.error(
                `${label}: enter a number from ${min} to ${max}, or leave it empty.`,
            );
            setText(value?.toString() ?? "");
            return;
        }
        if (v !== value) onSave(v);
    };
    return (
        <SettingRow label={label} hint={hint}>
            <Input
                type="number"
                className="w-40"
                placeholder="No limit"
                step={step}
                min={min}
                max={max}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => e.key === "Enter" && save()}
            />
        </SettingRow>
    );
}

function LimitSettings() {
    const { settings, saveSettings } = useContext(AppContext);
    const l = settings!.limits;
    return (
        <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
                Per response. When a limit is hit the run stops and says why.
            </p>
            <LimitField
                label="Max turns"
                hint="Agent round-trips (tool call + answer) per response. 1 to 500."
                value={l.maxTurns}
                step={1}
                min={1}
                max={500}
                onSave={(maxTurns) =>
                    saveSettings({ limits: { maxTurns } }, (s) => ({
                        ...s,
                        limits: { ...s.limits, maxTurns },
                    }))
                }
            />
            <LimitField
                label="Max cost (USD)"
                hint="Estimated spend per response. With a Claude subscription this is what it would have cost."
                value={l.maxBudgetUsd}
                step={0.1}
                min={0.01}
                max={1000}
                onSave={(maxBudgetUsd) =>
                    saveSettings({ limits: { maxBudgetUsd } }, (s) => ({
                        ...s,
                        limits: { ...s.limits, maxBudgetUsd },
                    }))
                }
            />
        </div>
    );
}

function AppearanceSettings() {
    const { settings, saveSettings } = useContext(AppContext);
    const options = [
        { value: "system", label: "System", icon: <Monitor /> },
        { value: "light", label: "Light", icon: <Sun /> },
        { value: "dark", label: "Dark", icon: <Moon /> },
    ] as const;
    return (
        <SettingRow label="Theme" hint="System follows your OS setting.">
            <div className="flex gap-2" role="radiogroup" aria-label="Theme">
                {options.map((o) => (
                    <Button
                        key={o.value}
                        role="radio"
                        aria-checked={settings!.theme === o.value}
                        variant={
                            settings!.theme === o.value ? "default" : "outline"
                        }
                        onClick={() =>
                            saveSettings({ theme: o.value }, (s) => ({
                                ...s,
                                theme: o.value,
                            }))
                        }
                    >
                        {o.icon} {o.label}
                    </Button>
                ))}
            </div>
        </SettingRow>
    );
}

// A tool call the agent is paused on, with Approve/Deny
function ApprovalCard({ request }: { request: PermissionRequest }) {
    const { socket } = useContext(AppContext);
    const answer = (allow: boolean) =>
        send(socket, {
            type: "permission-response",
            payload: { requestId: request.requestId, allow },
        });
    const label =
        request.name === "ExitPlanMode"
            ? "Wants to start on this plan"
            : request.name === "Bash"
              ? "Wants to run a command"
              : `Wants to ${request.name.toLowerCase()}`;
    return (
        <div className="mb-3 rounded-md border border-amber-500/50 bg-background p-3">
            <div className="mb-2 text-sm">
                <span className="font-medium">{label}</span>
                {request.file && (
                    <code className="ml-2 text-xs text-muted-foreground">
                        {request.file}
                    </code>
                )}
            </div>
            {request.detail && (
                <pre className="mb-2 max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                    {request.detail}
                </pre>
            )}
            <div className="flex gap-2">
                <Button size="sm" onClick={() => answer(true)}>
                    Approve
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => answer(false)}
                >
                    Deny
                </Button>
            </div>
        </div>
    );
}

function ReplyText({ text }: { text: string }) {
    return (
        // data-reply: where "Ask about this" selections are allowed
        <div
            data-reply
            className="prose prose-sm max-w-none dark:prose-invert prose-code:before:content-none prose-code:after:content-none"
        >
            <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
    );
}

function ToolRow({ tool }: { tool: ToolUse }) {
    return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">tool: {tool.name}</Badge>
            {tool.file && <code className="truncate">{tool.file}</code>}
        </div>
    );
}

function Conversation({
    sessionId,
    liveRun,
    models,
    modelFor,
    setModel,
    mode,
    setMode,
}: {
    sessionId: string | null;
    liveRun?: LiveRun;
    models: Partial<Record<AgentId, ModelOption[]>>;
    modelFor: Partial<Record<AgentId, string>>; // chosen model per agent (Settings > Defaults)
    setModel: (agent: AgentId, model: string) => void;
    mode: EditMode;
    setMode: (mode: EditMode) => void;
}) {
    const { workspaces, socket } = useContext(AppContext);
    const [text, setText] = useState("");
    const session = workspaces
        .flatMap((w) => w.sessions)
        .find((s) => s.id === sessionId);
    // A saved choice that's no longer offered falls back to the SDK default
    // This session's agent's models (each agent has its own list)
    const agentModels = (session && models[session.agent]) ?? [];
    const model = session ? modelFor[session.agent] : undefined;
    const selected =
        agentModels.find((m) => m.value === model) ?? agentModels[0];
    // Edit modes this agent supports (Codex can't ask before each change)
    const { agents } = useContext(AppContext);
    const agentInfo = agents.find((a) => a.id === session?.agent);
    const supportedModes =
        agentInfo?.capabilities.modes ?? EDIT_MODES.map((m) => m.value);
    // Agents that can't ask (Codex) run modes differently, so describe them accordingly
    const canAsk = supportedModes.includes("default");
    // The saved default if this agent supports it, else the agent's first mode
    const effectiveMode: EditMode = supportedModes.includes(mode)
        ? mode
        : (supportedModes[0] ?? "default");

    // Follow new text as it streams, unless the user scrolled up to read
    const listRef = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    useEffect(() => {
        const el = listRef.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    });

    // "Ask about this": text selected inside an agent reply, and where to show the button
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [ask, setAsk] = useState<{
        text: string;
        x: number;
        y: number;
        below: boolean; // no room above the selection (near the top of the list)
    } | null>(null);
    const checkSelection = () => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!sel || !text || !sel.rangeCount) return setAsk(null);
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = node instanceof Element ? node : node.parentElement;
        // Only within a single reply; not user messages, stats or across bubbles
        if (!el?.closest("[data-reply]")) return setAsk(null);
        const rect = range.getBoundingClientRect();
        const below = rect.top < 120;
        setAsk({
            text,
            x: rect.left + rect.width / 2,
            y: below ? rect.bottom + 6 : rect.top - 6,
            below,
        });
    };
    // Clicking elsewhere / clearing the selection hides the button
    useEffect(() => {
        const onChange = () => {
            if (!window.getSelection()?.toString().trim()) setAsk(null);
        };
        document.addEventListener("selectionchange", onChange);
        return () => document.removeEventListener("selectionchange", onChange);
    }, []);
    const askAbout = () => {
        if (!ask) return;
        // Quoted as Markdown, then a blank line for the user's question
        const quote = ask.text
            .split("\n")
            .map((line) => `> ${line}`.trimEnd())
            .join("\n");
        setText((t) => `${quote}\n\n${t}`);
        setAsk(null);
        window.getSelection()?.removeAllRanges();
        requestAnimationFrame(() => {
            const input = inputRef.current;
            if (!input) return;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        });
    };

    if (!session) {
        return (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
                Select or create a session
            </div>
        );
    }
    return (
        <>
            <SessionStats session={session} />
            {ask && (
                <button
                    type="button"
                    // mousedown would otherwise clear the selection before the click lands
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={askAbout}
                    style={{ left: ask.x, top: ask.y }}
                    className={cn(
                        "fixed z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-md border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent",
                        !ask.below && "-translate-y-full",
                    )}
                >
                    <MessageSquareQuote className="size-3.5" />
                    Ask about this
                </button>
            )}
            <div
                ref={listRef}
                onMouseUp={checkSelection}
                onKeyUp={checkSelection}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    atBottom.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    setAsk(null); // the selection moved; the button would float in the wrong spot
                }}
                className="flex-1 space-y-3 overflow-y-auto p-4"
            >
                {session.messages.map((m, i) =>
                    m.role === "user" ? (
                        <div key={m.id} className="ml-auto w-fit max-w-[75%]">
                            <div className="rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                                {m.payload.message}
                            </div>
                            {/* Stop sits under the message that started the running reply */}
                            {liveRun && i === session.messages.length - 1 && (
                                <button
                                    type="button"
                                    disabled={liveRun.stopping}
                                    onClick={() =>
                                        send(socket, {
                                            type: "stop-run",
                                            payload: { sessionId: session.id },
                                        })
                                    }
                                    className="mt-1 ml-auto block px-1 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:hover:text-muted-foreground"
                                >
                                    {liveRun.stopping ? "Stopping..." : "Stop"}
                                </button>
                            )}
                        </div>
                    ) : (
                        <div key={m.id} className="w-fit max-w-[85%]">
                            <div
                                className={cn(
                                    "rounded-lg px-4 py-3",
                                    m.payload.type === "error"
                                        ? "border border-destructive/40 bg-destructive/10"
                                        : "bg-muted",
                                )}
                            >
                                {m.payload.tools?.length ? (
                                    <div className="mb-3 space-y-1 border-b pb-3">
                                        {m.payload.tools.map((t, i) => (
                                            <ToolRow key={i} tool={t} />
                                        ))}
                                    </div>
                                ) : null}
                                {m.payload.type === "error" ? (
                                    <div className="flex gap-2 text-sm text-destructive">
                                        <CircleAlert className="mt-0.5 size-4 shrink-0" />
                                        <div className="whitespace-pre-wrap">
                                            {m.payload.message}
                                        </div>
                                    </div>
                                ) : (
                                    <ReplyText text={m.payload.message} />
                                )}
                                {m.payload.type === "stopped" && (
                                    <div
                                        className={cn(
                                            "flex items-center gap-1.5 text-xs text-muted-foreground",
                                            m.payload.message &&
                                                "mt-2 border-t pt-2",
                                        )}
                                    >
                                        <Square className="size-3" />
                                        {m.payload.message
                                            ? "Stopped"
                                            : "Stopped before any response"}
                                    </div>
                                )}
                            </div>
                            {m.payload.usage && (
                                <MessageStats usage={m.payload.usage} />
                            )}
                        </div>
                    ),
                )}
                {liveRun && (
                    <div className="w-fit max-w-[85%] rounded-lg bg-muted px-4 py-3">
                        {liveRun.approvals.map((a) => (
                            <ApprovalCard key={a.requestId} request={a} />
                        ))}
                        {liveRun.tools.length > 0 && (
                            <div className="mb-3 space-y-1 border-b pb-3">
                                {liveRun.tools.map((t, i) => (
                                    <ToolRow key={i} tool={t} />
                                ))}
                            </div>
                        )}
                        {liveRun.text && (
                            <div className="mb-2">
                                <ReplyText text={liveRun.text} />
                            </div>
                        )}
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" />
                            {liveRun.stopping
                                ? "Stopping..."
                                : liveRun.approvals.length
                                  ? "Waiting for your approval..."
                                  : "Working..."}
                        </div>
                    </div>
                )}
            </div>
            <form
                className="flex gap-2 border-t p-3"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!text.trim() || liveRun) return;
                    const sent = send(socket, {
                        type: "add-message",
                        payload: {
                            sessionId: session.id,
                            message: text,
                            // "default" = let the SDK pick, same as not passing one
                            model:
                                selected && selected.value !== "default"
                                    ? selected.value
                                    : undefined,
                            mode: effectiveMode,
                        },
                    });
                    if (sent) setText("");
                }}
            >
                {/* Typing stays enabled during a run; only sending waits (the server allows one run per session).
                    Multi-line so dropped Markdown prompts keep their line breaks; Enter sends, Shift+Enter is a newline */}
                <Textarea
                    ref={inputRef}
                    rows={1}
                    className="max-h-48 min-h-9 resize-none py-1.5"
                    placeholder={
                        liveRun
                            ? "Agent is working... you can send when it finishes"
                            : "Send a message..."
                    }
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                        ) {
                            e.preventDefault();
                            e.currentTarget.form?.requestSubmit();
                        }
                    }}
                />
                <Select
                    value={effectiveMode}
                    onValueChange={(v) => setMode(v as EditMode)}
                >
                    <SelectTrigger className="shrink-0" aria-label="Edit mode">
                        <SelectValue>
                            {
                                EDIT_MODES.find(
                                    (m) => m.value === effectiveMode,
                                )?.label
                            }
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {EDIT_MODES.map((m) => {
                            const supported = supportedModes.includes(m.value);
                            return (
                                <SelectItem
                                    key={m.value}
                                    value={m.value}
                                    disabled={!supported}
                                >
                                    <div className="flex flex-col">
                                        <span>{m.label}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {!supported
                                                ? `Not supported by ${agentInfo?.name}: it can't ask before each change`
                                                : canAsk
                                                  ? m.description
                                                  : NO_ASK_MODE_DESCRIPTIONS[
                                                        m.value
                                                    ]}
                                        </span>
                                    </div>
                                </SelectItem>
                            );
                        })}
                    </SelectContent>
                </Select>
                <Select
                    value={selected?.value ?? ""}
                    onValueChange={(v) => session && setModel(session.agent, v)}
                    disabled={!agentModels.length}
                >
                    <SelectTrigger
                        className="shrink-0"
                        aria-label="Model"
                        title={selected?.description}
                    >
                        <SelectValue placeholder="Loading models...">
                            {selected?.displayName}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {agentModels.map((m) => (
                            <SelectItem key={m.value} value={m.value}>
                                <div className="flex flex-col">
                                    <span>{m.displayName}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {m.description}
                                    </span>
                                </div>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button type="submit" disabled={!text.trim() || !!liveRun}>
                    Send
                </Button>
            </form>
        </>
    );
}

export default App;
