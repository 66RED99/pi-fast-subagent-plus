/**
 * fast-subagent — In-process subagent delegation.
 *
 * Uses createAgentSession() to run subagents in the same process as pi —
 * no subprocess spawn, no cold-start overhead.
 *
 * Supports: single mode (agent + task) and parallel mode (tasks array).
 * Running agents appear below the editor; click one to see live details.
 */

import { randomUUID } from "node:crypto";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { buildSubagentToolPrompt, type AgentConfig, discoverAgents } from "./agents.js";
import { formatThinkingLabel } from "./render.js";
import { formatDuration, getFinalText } from "./format.js";
import { defaultLoaderPool } from "./loader-pool.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { getCurrentDepth, mapConcurrent, runAgent } from "./runner.js";
import { SubagentParams } from "./schemas.js";
import type { AgentRowStatus, OnUpdate, RunningAgentEntry, RunResult, SubagentDetails, ToolCallEntry } from "./types.js";

// ─── Module-level state ─────────────────────────────────────────────────────

const WIDGET_KEY = "fast-subagent-widget";
const FG_STATUS_KEY = "fast-subagent-fg";
const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Capture ctx.ui from onSessionStart since ExtensionAPI has no .ui property.
let _ctxUi: any = null;

let _widgetTui: TUI | undefined = undefined;

// Overlay state for live re-rendering
const _overlayState = { tui: {} as TUI, open: false };

// Running agent registry (for below-editor widget + detail overlay)
const _runningAgents = new Map<string, RunningAgentEntry>();

// Dedup key events (TUI sends press+release via raw listeners)
const _lastInput = new Map<string, number>();
let _inputUnsub: (() => void) | undefined = undefined;

function refreshWidget(): void {
  if (_widgetTui) _widgetTui.invalidate();
  if (_overlayState.open && _overlayState.tui.invalidate) _overlayState.tui.invalidate();
}

function registerAgent(entry: RunningAgentEntry): void {
  _runningAgents.set(entry.id, entry);
  refreshWidget();
}

function unregisterAgent(id: string): void {
  _runningAgents.delete(id);
  if (_runningAgents.size === 0) {
    _agentListFocused = false;
    _agentListSelectedIdx = 0;
  } else if (_agentListSelectedIdx >= _runningAgents.size) {
    _agentListSelectedIdx = Math.max(0, _runningAgents.size - 1);
  }
  refreshWidget();
}

// ─── Agent list state (shared between widget and keyboard handler) ──────────

let _agentListFocused = false;
let _agentListSelectedIdx = 0;

function buildAgentListLines(agents: RunningAgentEntry[], theme: import("@earendil-works/pi-coding-agent").Theme, width: number): string[] {
  const out: string[] = [];

  for (let i = 0; i < agents.length; i++) {
    const entry = agents[i]!;
    const isSelected = _agentListFocused && _agentListSelectedIdx === i;
    const cursor = isSelected ? ">" : " ";
    const elapsed = formatDuration(Date.now() - entry.startedAt);
    const thinkingLabel = formatThinkingLabel(entry.thinking);
    const meta = [entry.model, thinkingLabel].filter(Boolean).join(" · ");
    const metaSuffix = meta ? theme.fg("dim", ` [${meta}]`) : "";
    // agent name + task on the left, elapsed on the right
    const leftText = `${cursor} ○ ${entry.agentName}${metaSuffix}   ${entry.taskSummary}`;
    const leftWidth = Math.max(1, width - elapsed.length - 2);
    out.push(`${truncateToWidth(leftText, leftWidth, "...")}  ${elapsed}`);
  }

  if (_agentListFocused) {
    out.push(truncateToWidth(
      theme.fg("dim", "Enter to view · x to stop · ctrl+k stop all · ESC unfocus"),
      width, "...",
    ));
  } else {
    out.push(theme.fg("dim", "↓ to navigate agents"));
  }

  return out;
}

// ─── Dynamic detail overlay ──────────────────────────────────────────────────

function openAgentDetailOverlay(entry: RunningAgentEntry): void {
  if (_overlayState.open || !_ctxUi) return;
  _overlayState.open = true;

  // Strip ANSI escape codes to get visible character width for padding.
  const visLen = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "").length;

  void _ctxUi.custom(
    (tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: unknown) => void) => {
      // Capture the TUI reference for live re-rendering
      Object.assign(_overlayState as any, tui);
      return {
        render(width: number): string[] {
          const inner = Math.max(4, width - 4);

          const bline = (text: string) => {
            const truncated = truncateToWidth(text, inner, "...");
            const pad = Math.max(0, inner - visLen(truncated));
            return `│ ${truncated}${" ".repeat(pad)} │`;
          };

          // Title in top border: ╭─── agentName ───╮
          const titleLabel = ` ${entry.agentName} `;
          const titleLabelLen = visLen(titleLabel);
          const sidesLen = Math.max(0, width - 2 - titleLabelLen);
          const leftDashes = Math.floor(sidesLen / 2);
          const rightDashes = sidesLen - leftDashes;
          const topBorder = `╭${"─".repeat(leftDashes)}${theme.fg("accent", theme.bold(titleLabel))}${"─".repeat(rightDashes)}╮`;
          const botBorder = `╰${"─".repeat(width - 2)}╯`;

          const elapsed = formatDuration(Date.now() - entry.startedAt);
          const thinkingLabel = formatThinkingLabel(entry.thinking);
          const metaParts = [entry.model, thinkingLabel].filter(Boolean);
          const metaLine = metaParts.length ? theme.fg("dim", metaParts.join(" · ")) : "";

          const lines: string[] = [];
          lines.push(bline(""));
          lines.push(bline(`Status: ${entry.status} · ${elapsed}`));
          if (metaLine) lines.push(bline(`${metaLine}`));
          lines.push(bline(""));
          lines.push(bline("Task:"));
          lines.push(bline(`  ${entry.taskSummary}`));

          if (entry.toolCalls.length > 0) {
            lines.push(bline(""));
            lines.push(bline("Tool calls:"));
            for (const tc of entry.toolCalls.slice(-8)) {
              const st = tc.result !== undefined ? (tc.isError ? "✗" : "✓") : "…";
              const durStr = tc.durMs != null
                ? ` (${tc.durMs < 1000 ? `${tc.durMs}ms` : `${(tc.durMs / 1000).toFixed(1)}s`})`
                : "";
              lines.push(bline(`  ${st} ${tc.name}(${tc.argSummary})${durStr}`));
            }
          }

          if (entry.responseText) {
            lines.push(bline(""));
            lines.push(bline("Response:"));
            for (const l of entry.responseText.split("\n").slice(0, 12)) {
              lines.push(bline(`  ${l}`));
            }
          }

          lines.push(bline(""));
          lines.push(bline(theme.fg("dim", "ESC or Enter to close")));

          return [topBorder, ...lines, botBorder];
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
            done(undefined);
          }
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%" } },
  ).finally(() => {
    _overlayState.open = false;
    refreshWidget();
  });
}

// ─── Subagent tool registration ──────────────────────────────────────────────

function registerSubagentTool(pi: ExtensionAPI): void {
  const prompt = buildSubagentToolPrompt();

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: prompt.description,
    promptSnippet: prompt.promptSnippet,
    promptGuidelines: prompt.promptGuidelines,
    parameters: SubagentParams,

    renderCall(args, theme, context) {
      return renderSubagentCall(args, theme, context);
    },

    renderResult(result, opts, theme) {
      return renderSubagentResult(result, opts, theme);
    },

    async execute(_id: string, params: Record<string, any>, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext): Promise<any> {
      const cwd = params.cwd ?? ctx.cwd;
      const agents = discoverAgents(cwd);

      // Cache the UI context from this execution's context (used by overlay)
      if (!_ctxUi) {
        _ctxUi = ctx.ui as any;
      }

      const findAgent = (name: string): { agent?: AgentConfig; error?: string } => {
        const found = agents.find((a) => a.name === name);
        if (!found) {
          const list = agents.map((a) => `"${a.name}"`).join(", ") || "none";
          return { error: `Unknown agent: "${name}". Available: ${list}` };
        }
        return { agent: found };
      };

      // ── Single mode ─────────────────────────────────────────────────────
      if (params.agent && params.task) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };

        const effectiveModel = params.model;
        const agentAbort = new AbortController();
        const forwardAbort = () => agentAbort.abort();
        signal?.addEventListener("abort", forwardAbort, { once: true });
        const fgTimeout = setTimeout(() => agentAbort.abort(), AGENT_TIMEOUT_MS);

        // Registry entry for below-editor widget + detail overlay
        const registryId = `fg_r_${randomUUID().slice(0, 8)}`;
        const registryEntry: RunningAgentEntry = {
          id: registryId,
          agentName: agent.name,
          taskSummary: params.task.length > 60 ? params.task.slice(0, 57) + "..." : params.task,
          startedAt: Date.now(),
          abort: () => agentAbort.abort(),
          toolCalls: [],
          responseText: "",
          status: "running",
          executionEvents: [],
        };
        registerAgent(registryEntry);

        let forwardUpdates = true;
        const wrappedOnUpdate: OnUpdate | undefined = onUpdate
          ? (partial) => {
              const d = partial.details as SubagentDetails | undefined;
              if (d) {
                registryEntry.toolCalls = d.toolCalls ?? registryEntry.toolCalls;
                registryEntry.model = d.model ?? registryEntry.model;
                registryEntry.thinking = d.thinking ?? registryEntry.thinking;
                registryEntry.executionEvents = d.executionEvents ?? registryEntry.executionEvents;
              }
              registryEntry.responseText = (partial.content?.[0] as any)?.text || registryEntry.responseText;
              refreshWidget();
              if (forwardUpdates) (onUpdate as unknown as OnUpdate)(partial);
            }
          : undefined;

        const agentRunPromise: Promise<RunResult> = runAgent(
          agent, params.task, cwd, effectiveModel, agentAbort.signal, wrappedOnUpdate,
        );

        ctx.ui.setStatus(FG_STATUS_KEY, `${agent.name} running`);

        let runResult: RunResult | null = null;
        await agentRunPromise.then((r) => { runResult = r; }).finally(() => {
          clearTimeout(fgTimeout);
          signal?.removeEventListener("abort", forwardAbort);
          ctx.ui.setStatus(FG_STATUS_KEY, undefined);
          if (runResult !== null) {
            registryEntry.status = runResult.exitCode === 0 ? "done" : "error";
          }
          unregisterAgent(registryId);
        });

        const result = runResult!;
        return {
          content: [{ type: "text", text: getFinalText(result) }],
          details: {
            agentName: params.agent,
            task: params.task,
            usage: result.usage,
            running: false,
            elapsedMs: undefined,
            model: result.model,
            thinking: agent.thinking,
            toolCalls: result.toolCalls,
            executionEvents: result.executionEvents,
          } satisfies SubagentDetails,
          isError: result.exitCode !== 0,
        };
      }

      // ── Parallel mode ───────────────────────────────────────────────────
      if (params.tasks && params.tasks.length > 0) {
        const agentByName = new Map(agents.map((a) => [a.name, a]));
        const expanded: Array<{ agent: string; task: string; model?: string; fallbackModel?: string; thinking?: string; cwd?: string }> = [];
        for (const t of params.tasks) {
          const n = t.count ?? 1;
          const agentDef = agentByName.get(t.agent);
          for (let i = 0; i < n; i++) expanded.push({
            agent: t.agent,
            task: t.task,
            model: t.model,
            fallbackModel: t.fallbackModel ?? agentDef?.fallbackModel,
            thinking: agentDef?.thinking,
            cwd: t.cwd,
          });
        }

        const concurrency = params.concurrency ?? 4;
        const emptyUsage = { input: 0, output: 0, cost: 0, turns: 0 };
        const parallelAgents: AgentRowStatus[] = expanded.map((t) => ({
          name: t.agent,
          taskSummary: t.task.length > 60 ? t.task.slice(0, 57) + "..." : t.task,
          status: "pending" as const,
          thinking: t.thinking,
        }));
        let runningUsage = { ...emptyUsage };

        const emitParallel = (running: boolean) => (onUpdate as unknown as OnUpdate | undefined)?.({
          content: [{ type: "text", text: "" }],
          details: { mode: "parallel", parallelAgents: [...parallelAgents], usage: { ...runningUsage }, running, toolCalls: [] } satisfies SubagentDetails,
        });

        emitParallel(true);

        // Capture the current depth once for this parallel batch — each concurrent task
        // receives an explicit parentDepth so it doesn't race with the shared _currentDepth.
        const baseDepth = getCurrentDepth();
        const allResults = await mapConcurrent(expanded, concurrency, async (t, i) => {
          parallelAgents[i]!.status = "running";
          emitParallel(true);

          // Per-agent abort controller chained to parent signal + 10-min timeout
          const taskAbort = new AbortController();
          const onParentAbort = () => taskAbort.abort();
          signal?.addEventListener("abort", onParentAbort, { once: true });
          const taskTimeout = setTimeout(() => taskAbort.abort(), AGENT_TIMEOUT_MS);

          // Registry entry for widget + overlay
          const registryId = `par_${randomUUID().slice(0, 8)}`;
          const registryEntry: RunningAgentEntry = {
            id: registryId,
            agentName: t.agent,
            taskSummary: t.task.length > 60 ? t.task.slice(0, 57) + "..." : t.task,
            startedAt: Date.now(),
            abort: () => taskAbort.abort(),
            toolCalls: [],
            responseText: "",
            status: "running",
            executionEvents: [],
          };
          registerAgent(registryEntry);

          const { agent: foundAgent, error } = findAgent(t.agent);
          if (error || !foundAgent) {
            signal?.removeEventListener("abort", onParentAbort);
            unregisterAgent(registryId);
            parallelAgents[i]!.status = "error";
            emitParallel(true);
            return { agentName: t.agent, output: "", exitCode: 1, error, model: undefined, toolCalls: [] as ToolCallEntry[], usage: emptyUsage };
          }
          // Merge per-task fallbackModel override into agent config
          const agent = t.fallbackModel ? { ...foundAgent, fallbackModel: t.fallbackModel } : foundAgent;
          const agentStart = Date.now();
          const agentOnUpdate: OnUpdate = (partial) => {
            const d = partial.details as SubagentDetails | undefined;
            parallelAgents[i]!.toolCalls = d?.toolCalls ? [...d.toolCalls] : parallelAgents[i]!.toolCalls;
            parallelAgents[i]!.thinking = d?.thinking ?? parallelAgents[i]!.thinking;
            parallelAgents[i]!.responseText = (partial.content?.[0] as any)?.text || parallelAgents[i]!.responseText;
            if (d) {
              registryEntry.toolCalls = d.toolCalls ?? registryEntry.toolCalls;
              registryEntry.executionEvents = d.executionEvents ?? registryEntry.executionEvents;
              registryEntry.model = d.model ?? registryEntry.model;
              registryEntry.thinking = d.thinking ?? registryEntry.thinking;
            }
            registryEntry.responseText = (partial.content?.[0] as any)?.text || registryEntry.responseText;
            refreshWidget();
            emitParallel(true);
          };
          const result = await runAgent(
            agent,
            t.task,
            t.cwd ?? cwd,
            t.model,
            taskAbort.signal,
            agentOnUpdate,
            baseDepth,
          );
          clearTimeout(taskTimeout);
          signal?.removeEventListener("abort", onParentAbort);
          registryEntry.status = result.exitCode === 0 ? "done" : "error";
          unregisterAgent(registryId);
          parallelAgents[i]!.status = result.exitCode === 0 ? "done" : "error";
          parallelAgents[i]!.durMs = Date.now() - agentStart;
          parallelAgents[i]!.toolCalls = result.toolCalls;
          parallelAgents[i]!.responseText = result.output;
          runningUsage = { input: runningUsage.input + result.usage.input, output: runningUsage.output + result.usage.output, cost: runningUsage.cost + result.usage.cost, turns: runningUsage.turns + result.usage.turns };
          emitParallel(true);
          return { ...result, agentName: t.agent, toolCalls: result.toolCalls ?? [] };
        });

        const totalUsage = allResults.reduce(
          (acc, r) => ({ input: acc.input + r.usage.input, output: acc.output + r.usage.output, cost: acc.cost + r.usage.cost, turns: acc.turns + r.usage.turns }),
          emptyUsage,
        );
        const outputs = allResults.map((r) => {
          const modelTag = r.model ? ` (${r.model})` : "";
          return `[${r.agentName}]${modelTag} ${r.exitCode === 0 ? "✓" : "✗"}\n${getFinalText(r)}`;
        }).join("\n\n");

        return {
          content: [{ type: "text", text: outputs }],
          details: { mode: "parallel", parallelAgents, usage: totalUsage, running: false, toolCalls: [] } satisfies SubagentDetails,
        };
      }

      return { content: [{ type: "text", text: "Provide agent+task or tasks array." }] };
    },
  });
}

// ─── Below-editor widget + keyboard handling ────────────────────────────────

function setupBelowEditorWidget(pi: ExtensionAPI, ctxUi: NonNullable<typeof _ctxUi>): void {
  ctxUi.setWidget(
    WIDGET_KEY,
    (tui: TUI, theme: Theme) => {
      // Capture the TUI reference for invalidation from outside this factory scope
      _widgetTui = tui;

      // Register an input listener that intercepts ALL keyboard input BEFORE
      // it reaches the focused component. This is essential because our widget
      // renders below the editor and rarely has TUI focus — without this, arrow
      // keys go to the editor above instead of our handler.
      _inputUnsub = tui.addInputListener((data: string) => {
        // Don't intercept when overlay is open — let the overlay handle input
        if (_overlayState.open) return undefined;

        const agents = Array.from(_runningAgents.values());
        if (agents.length === 0) return undefined;

        // TUI sends both key press AND key release events via raw listeners.
        // Deduplicate: skip if we processed the same event string <50ms ago.
        const now = Date.now();
        const last = _lastInput.get(data);
        if (last && now - last < 50) return undefined;
        _lastInput.set(data, now);

        function shouldConsume(): boolean {
          if (matchesKey(data, Key.up)) return true;
          if (matchesKey(data, Key.down)) return true;
          if (matchesKey(data, Key.enter)) return true;
          if (data === "x" || data === "X") return true;
          if (matchesKey(data, Key.ctrl("k"))) return true;
          if (matchesKey(data, Key.escape)) return true;
          return false;
        }

        if (!shouldConsume()) return undefined;

        // Process the key event
        if (matchesKey(data, Key.up)) {
          _agentListFocused = true;
          _agentListSelectedIdx = (_agentListSelectedIdx - 1 + agents.length) % agents.length;
          refreshWidget();
        } else if (matchesKey(data, Key.down)) {
          _agentListFocused = true;
          _agentListSelectedIdx = (_agentListSelectedIdx + 1) % agents.length;
          refreshWidget();
        } else if (matchesKey(data, Key.enter)) {
          if (_agentListFocused && agents.length > 0) {
            const entry = agents[_agentListSelectedIdx];
            if (entry) openAgentDetailOverlay(entry);
          } else if (!_agentListFocused && agents.length > 0) {
            _agentListFocused = true;
            _agentListSelectedIdx = 0;
            refreshWidget();
          }
        } else if (data === "x" || data === "X") {
          if (_agentListFocused && agents.length > 0) {
            const entry = agents[_agentListSelectedIdx];
            if (entry) {
              entry.abort();
              _agentListFocused = false;
            }
          }
        } else if (matchesKey(data, Key.ctrl("k"))) {
          // Stop all running agents
          for (const a of agents) a.abort();
          _agentListFocused = false;
        } else if (matchesKey(data, Key.escape)) {
          // Return focus to editor / unfocus agent list
          _agentListFocused = false;
          refreshWidget();
        }
        return { consume: true };
      });

      return {
        render(width: number): string[] {
          const agents = Array.from(_runningAgents.values());
          if (agents.length === 0 && !_agentListFocused) return [];
          return buildAgentListLines(agents, theme, width);
        },

        invalidate() {},
      };
    },
    { placement: "belowEditor" },
  );
}

// ─── Extension entry point (default export) ──────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Register tool at module load time so it appears first in system prompt.
  registerSubagentTool(pi);

  pi.on("session_start", (_event, ctx) => {
    _ctxUi = ctx.ui as any;
    setupBelowEditorWidget(pi, ctx.ui as any);
    // Start warming the loader pool in background (non-blocking).
    const agentDir = getAgentDir();
    if (agentDir) defaultLoaderPool.warm(ctx.cwd, agentDir, false);
  });

  pi.on("session_shutdown", () => {
    _inputUnsub?.();
    _runningAgents.clear();
    _ctxUi = null;
    _widgetTui = undefined;
    Object.assign(_overlayState as any, {});
  });
}
