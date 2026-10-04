import { unavailableAdapter } from "./unavailable";

// Cursor's agent CLI. Not implemented yet; registered so it shows (disabled) in the picker.
//
// To implement, replace this with a real AgentAdapter (see types.ts), e.g. driving
// `cursor-agent --print --output-format stream-json`:
//  - run(): pass ctx.resume as the chat id to resume (report new ones via ctx.onSession),
//    stream assistant text deltas via ctx.onText, and map tool_call events to ToolCall
//    (shell -> "command", edit/write -> "edit" with paths, read/grep/glob -> "read"),
//    awaiting ctx.checkTool(call) before letting each one run; report via ctx.onToolUse.
//    Stop: kill the process on ctx.signal.
//  - sandbox: commands must be confined to ctx.cwd (OS sandbox) since the policy can
//    only path-check file tools.
export const cursorAdapter = unavailableAdapter({
    id: "cursor",
    name: "Cursor",
    cli: "cursor-agent",
    install: "curl https://cursor.com/install -fsS | bash",
});
