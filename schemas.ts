/**
 * Typebox parameter schema for the `subagent` tool.
 */

import { Type } from "typebox";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  model: Type.Optional(Type.String({ description: "OPTIONAL: override the agent's configured model (format: provider/model-id). Leave unset to use the agent's built-in model." })),
  fallbackModel: Type.Optional(Type.String({ description: "Fallback model if primary fails (provider/model)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  count: Type.Optional(Type.Number({ description: "Repeat this task N times" })),
});

export const SubagentParams = Type.Object({
  // Single mode
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate" })),
  model: Type.Optional(Type.String({ description: "OPTIONAL: override the agent's configured model (format: provider/model-id). Leave unset to use the agent's built-in model." })),
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

  // Agent scope — recognized by pi but not used directly in this package
  agentScope: Type.Optional(
    Type.Union(
      [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
      { description: "Agent scope filter", default: "both" },
    ),
  ),
});
