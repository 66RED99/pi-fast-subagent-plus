/**
 * Typebox parameter schema for the `subagent` tool.
 */

import { Type } from "typebox";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  model: Type.Optional(Type.String({ description: "Model override (provider/model)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  count: Type.Optional(Type.Number({ description: "Repeat this task N times" })),
});

export const SubagentParams = Type.Object({
  // Single mode
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task (single mode)" })),
  model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),

  // Parallel mode
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: "Array of {agent, task} for parallel execution. Use count to repeat one task.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({ description: "Max parallel concurrency (default: 4)", default: 4 }),
  ),

  // Background — omit this for normal use; results return inline in the tool call
  background: Type.Optional(Type.Boolean({ description: "OPTIONAL: true = run async in background and return job ID immediately. Omit for normal synchronous execution where results are returned directly." })),

  // Background job management — ONLY used after background:true calls
  jobId: Type.Optional(Type.String({ description: "Background job ID (from a previous background:true call) for poll/cancel. Not used in normal synchronous execution." })),

  // Management actions — most are ONLY for background jobs
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("get"),
        Type.Literal("status"),
        Type.Literal("poll"),
        Type.Literal("cancel"),
        Type.Literal("detach"),
      ],
      {
        description:
          "'list' = show available agents; 'get' = inspect one agent. BACKGROUND-ONLY: 'status' = list bg jobs, 'poll' = get completed bg job result (requires jobId), 'cancel' = stop a bg job, 'detach' = move current foreground job to background. Never use status/poll/cancel/detach after normal synchronous subagent calls.",
      },
    ),
  ),
  agentScope: Type.Optional(
    Type.Union(
      [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
      { description: "Agent scope filter", default: "both" },
    ),
  ),
});
