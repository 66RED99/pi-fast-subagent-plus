/**
 * fast-subagent — In-process subagent delegation.
 *
 * Uses createAgentSession() to run subagents in the same process as pi —
 * no subprocess spawn, no cold-start overhead.
 *
 * Supports: single, parallel, background.
 * Agent .md files are compatible with pi-subagents frontmatter format.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import { buildSubagentToolPrompt, type AgentConfig, discoverAgents } from "./agents.js";
import { BackgroundJobManager } from "./background-job-manager.js";
import type { BackgroundHandleLike, BackgroundJobResult, BackgroundSubagentJob } from "./background-types.js";
import {
  formatDuration,
  formatTools,
  getFinalText,
} from "./format.js";
import { openFastSubagentPanel } from "./control-panel.js";
import { defaultLoaderPool } from "./loader-pool.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { getCurrentDepth, mapConcurrent, runAgent } from "./runner.js";
import { SubagentParams } from "./schemas.js";
import type { AgentRowStatus, OnUpdate, RunningAgentEntry, RunResult, SubagentDetails, ToolCallEntry } from "./types.js";

// ─── Module-level state ─────────────────────────────────────────────────────

let _bgManager: BackgroundJobManager | null = null;
let _onBgJobComplete: ((job: BackgroundSubagentJob) => void) | null = null;
let _setBgStatus: ((text: string | undefined) => void) | null = null;
const FG_STATUS_KEY = "fast-subagent-fg";

// ─── Running agent registry (for below-editor widget) ───────────────────────

const _runningAgents = new Map<string, RunningAgentEntry>();
let _sessionUi: ExtensionUIContext | null = null;
let _agentListFocused = false;
let _agentListSelectedIdx = 0;
let _overlayOpen = false;
let _tui: TUI | null = null;
let _inputUnsubscribe: (() => void) | null = null;

function refreshAgentWidget(): void {
  _tui?.requestRender();
}

function registerAgent(entry: RunningAgentEntry): void {
  _runningAgents.set(entry.id, entry);
  refreshAgentWidget();
}

function unregisterAgent(id: string): void {
  _runningAgents.delete(id);
  if (_runningAgents.size === 0 && _agentListFocused) {
    _agentListFocused = false;
    _agentListSelectedIdx = 0;
  } else if (_agentListSelectedIdx > _runningAgents.size) {
    _agentListSelectedIdx = _runningAgents.size;
  }
  refreshAgentWidget();
}

function buildAgentListLines(agents: RunningAgentEntry[], theme: Theme, width: number): string[] {
  const out: string[] = [];

  const mainCursor = _agentListFocused && _agentListSelectedIdx === 0 ? ">" : " ";
  const mainBullet = theme.bold ? theme.bold("●") : "●";
  out.push(truncateToWidth(`${mainCursor} ${mainBullet} main`, width, "..."));

  for (let i = 0; i < agents.length; i++) {
    const entry = agents[i]!;
    const isSelected = _agentListFocused && _agentListSelectedIdx === i + 1;
    const cursor = isSelected ? ">" : " ";
    const elapsed = formatDuration(Date.now() - entry.startedAt);
    const left = `${cursor} ○ ${entry.agentName}   ${entry.taskSummary}`;
    const leftWidth = Math.max(1, width - elapsed.length - 2);
    out.push(`${truncateToWidth(left, leftWidth, "...")}  ${theme.fg("dim", elapsed)}`);
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

function openAgentDetailOverlay(entry: RunningAgentEntry): void {
  if (_overlayOpen || !_sessionUi) return;
  _overlayOpen = true;

  // Strip ANSI escape codes to get visible character width for padding.
  const visLen = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "").length;

  void _sessionUi.custom((_overlayTui, theme, _keybindings, done) => {
    return {
      render(width: number): string[] {
        const inner = Math.max(4, width - 4); // content width inside │ <content> │

        // Build a padded bordered line: │ <content padded to inner> │
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
        const modelPart = entry.model ? ` · ${entry.model}` : "";

        const lines: string[] = [];
        lines.push(bline(""));
        lines.push(bline("Task:"));
        lines.push(bline(`  ${entry.taskSummary}`));
        lines.push(bline(""));
        lines.push(bline(`Status: ${entry.status} · ${elapsed}${modelPart}`));
        if (entry.toolCalls.length > 0) {
          lines.push(bline(""));
          lines.push(bline("Recent tool calls:"));
          for (const tc of entry.toolCalls.slice(-8)) {
            const st = tc.result !== undefined ? (tc.isError ? "✗" : "✓") : "…";
            lines.push(bline(`  ${st} ${tc.name}(${tc.argSummary})`));
          }
        }
        if (entry.responseText) {
          lines.push(bline(""));
          lines.push(bline("Response:"));
          for (const l of entry.responseText.split("\n").slice(0, 8)) {
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
  }, { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%" } })
    .finally(() => {
      _overlayOpen = false;
      refreshAgentWidget();
    });
}

function getBgManager(): BackgroundJobManager {
  if (!_bgManager) _bgManager = new BackgroundJobManager({
    onJobComplete: (job) => _onBgJobComplete?.(job),
  });
  return _bgManager;
}

function refreshBgStatus(): void {
  const running = getBgManager().getRunningJobs();
  _setBgStatus?.(running.length > 0 ? `⧗ ${running.length} bg agent${running.length > 1 ? "s" : ""}` : undefined);
}

async function writeDebugPrompt(ctx: ExtensionCommandContext): Promise<string> {
  await ctx.waitForIdle();
  const prompt = ctx.getSystemPrompt();
  const debugDir = join(getAgentDir(), "debug");
  const debugFile = join(debugDir, "fast-subagent-system-prompt.txt");
  mkdirSync(debugDir, { recursive: true });
  writeFileSync(debugFile, prompt, "utf8");
  return debugFile;
}

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

      const findAgent = (name: string): { agent?: AgentConfig; error?: string } => {
        const found = agents.find((a) => a.name === name);
        if (!found) {
          const list = agents.map((a) => `"${a.name}"`).join(", ") || "none";
          return { error: `Unknown agent: "${name}". Available: ${list}` };
        }
        return { agent: found };
      };

      // ── Management: list ────────────────────────────────────────────────
      if (params.action === "list" || (!params.action && !params.agent && !params.tasks)) {
        if (agents.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No agents found. Add .md files to ~/.pi/agent/agents/ or .pi/agents/.",
            }],
          };
        }
        const lines = agents.map(
          (a) => `${a.name} [${a.source}]${a.model ? ` · ${a.model}` : ""}: ${a.description}`,
        );
        return { content: [{ type: "text", text: `Agents (${agents.length}):\n${lines.join("\n")}` }] };
      }

      // ── Management: get ─────────────────────────────────────────────────
      if (params.action === "get" && params.agent) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };
        const info = [
          `## ${agent.name} [${agent.source}]`,
          `**Description:** ${agent.description}`,
          agent.model ? `**Model:** ${agent.model}` : null,
          `**Tools:** ${formatTools(agent.tools)}`,
          `**Max subagent depth:** ${agent.maxDepth}`,
          agent.systemPrompt ? `
**System prompt:**
${agent.systemPrompt}` : null,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: info }] };
      }

      // ── Background status ───────────────────────────────────────────────
      if (params.action === "status") {
        const jobs = getBgManager().getAllJobs();
        if (jobs.length === 0) return { content: [{ type: "text", text: "No background jobs." }] };
        const lines = jobs.map((j) => {
          const dur = j.completedAt ? formatDuration(j.completedAt - j.startedAt) : formatDuration(Date.now() - j.startedAt);
          return `${j.id} [${j.status}] ${j.agentName} · ${dur} · ${j.task.length > 50 ? j.task.slice(0, 47) + "..." : j.task}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── Background poll ─────────────────────────────────────────────────
      if (params.action === "poll") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId to poll." }] };
        const job = getBgManager().getJob(params.jobId);
        if (!job) return { content: [{ type: "text", text: `Job ${params.jobId} not found (completed and evicted, or invalid).` }] };
        const dur = job.completedAt ? formatDuration(job.completedAt - job.startedAt) : formatDuration(Date.now() - job.startedAt);
        const parts = [`${job.id} [${job.status}] ${job.agentName} · ${dur}`, `Task: ${job.task}`];
        if (job.status === "completed") parts.push(`
Result:
${job.resultSummary ?? "(no output)"}`);
        if (job.status === "failed") parts.push(`
Error: ${job.error ?? "(unknown)"}`);
        if (job.status === "running") parts.push("Still running — poll again later.");
        return { content: [{ type: "text", text: parts.join("\n") }] };
      }

      // ── Background cancel ───────────────────────────────────────────────
      if (params.action === "cancel") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId to cancel." }] };
        const result = getBgManager().cancel(params.jobId);
        const msg = result === "cancelled" ? `Job ${params.jobId} cancelled.`
          : result === "already_done" ? `Job ${params.jobId} already completed.`
          : `Job ${params.jobId} not found.`;
        return { content: [{ type: "text", text: msg }] };
      }

      // ── Foreground → background detach ──────────────────────────────────
      if (params.action === "detach") {
        if (!params.jobId) return { content: [{ type: "text", text: "Provide jobId (fg_xxxxx) to detach." }] };
        const fgEntry = _fgJobs.get(params.jobId);
        if (!fgEntry) return { content: [{ type: "text", text: `Foreground job "${params.jobId}" not found (already completed or invalid).` }] };
        const bgJobId = fgEntry.detach();
        return { content: [{ type: "text", text: `Moved to background: ${bgJobId}
To check status, ask me to poll job ${bgJobId}.` }] };
      }

      // ── Single mode ─────────────────────────────────────────────────────
      if (params.agent && params.task) {
        const { agent, error } = findAgent(params.agent);
        if (error || !agent) return { content: [{ type: "text", text: error ?? "Not found" }] };

        const effectiveModel = params.model;

        if (params.background) {
          const bgAbort = new AbortController();
          const handle: BackgroundHandleLike = { abort: () => bgAbort.abort() };
          const resultPromise: Promise<BackgroundJobResult> = runAgent(
            agent, params.task, cwd, effectiveModel, bgAbort.signal, undefined,
          ).then((r) => ({ summary: r.output, exitCode: r.exitCode, error: r.error, model: r.model }));
          const jobId = getBgManager().adoptHandle(agent.name, params.task, cwd, handle, resultPromise);
          return { content: [{ type: "text", text: `Background job started: ${jobId}
To check status, ask me to poll job ${jobId}.` }] };
        }

        const fgId = `fg_${randomUUID().slice(0, 8)}`;
        const agentAbort = new AbortController();
        const forwardAbort = () => agentAbort.abort();
        signal?.addEventListener("abort", forwardAbort, { once: true });

        // Register in the running-agents widget
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

        let detachResolveFn: ((bgJobId: string) => void) | null = null;
        const detachPromise = new Promise<string>((resolve) => { detachResolveFn = resolve; });

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
              refreshAgentWidget();
              if (forwardUpdates) (onUpdate as unknown as OnUpdate)(partial);
            }
          : undefined;

        const agentRunPromise: Promise<RunResult> = runAgent(
          agent, params.task, cwd, effectiveModel, agentAbort.signal, wrappedOnUpdate,
        );

        const bgResultPromise: Promise<BackgroundJobResult> = agentRunPromise
          .then((r) => ({ summary: r.output, exitCode: r.exitCode, error: r.error, model: r.model }));

        _fgJobs.set(fgId, {
          agentName: agent.name,
          task: params.task,
          detach: () => {
            forwardUpdates = false;
            signal?.removeEventListener("abort", forwardAbort);
            const bgHandle: BackgroundHandleLike = { abort: () => agentAbort.abort() };
            const bgJobId = getBgManager().adoptHandle(agent.name, params.task, cwd, bgHandle, bgResultPromise);
            refreshBgStatus();
            detachResolveFn?.(bgJobId);
            return bgJobId;
          },
        });

        ctx.ui.setStatus(FG_STATUS_KEY, `${agent.name} running · Alt+Shift+B to move to background`);

        let runResult: RunResult | null = null;
        const outcome = await Promise.race([
          agentRunPromise.then((r) => { runResult = r; return "done" as const; }),
          detachPromise.then(() => "detached" as const),
        ]).finally(() => {
          _fgJobs.delete(fgId);
          signal?.removeEventListener("abort", forwardAbort);
          ctx.ui.setStatus(FG_STATUS_KEY, undefined);
          if (runResult !== null) {
            registryEntry.status = runResult.exitCode === 0 ? "done" : "error";
          }
          unregisterAgent(registryId);
        });

        if (outcome === "detached") {
          const bgJobId = await detachPromise;
          return {
            content: [{ type: "text", text: `Moved to background: ${bgJobId}. Completion will be announced automatically.` }],
            details: {
              agentName: params.agent,
              task: params.task,
              usage: { input: 0, output: 0, cost: 0, turns: 0 },
              running: false,
              backgroundJobId: bgJobId,
              toolCalls: [],
            } satisfies SubagentDetails,
          };
        }

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

        const parentDepth = getCurrentDepth();
        const allResults = await mapConcurrent(expanded, concurrency, async (t, i) => {
          parallelAgents[i]!.status = "running";
          emitParallel(true);

          // Per-agent abort controller chained to parent signal
          const taskAbort = new AbortController();
          const onParentAbort = () => taskAbort.abort();
          signal?.addEventListener("abort", onParentAbort, { once: true });

          // Registry entry for widget
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
            }
            registryEntry.responseText = (partial.content?.[0] as any)?.text || registryEntry.responseText;
            refreshAgentWidget();
            emitParallel(true);
          };
          const result = await runAgent(
            agent,
            t.task,
            t.cwd ?? cwd,
            t.model,
            taskAbort.signal,
            agentOnUpdate,
            parentDepth,
          );
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
// ─── Foreground detach registry ─────────────────────────────────────────────

interface ForegroundDetachEntry {
  agentName: string;
  task: string;
  detach: () => string;
}
const _fgJobs = new Map<string, ForegroundDetachEntry>();

// ─── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const BG_STATUS_KEY = "fast-subagent-bg";

  // Register tool at module load time so it appears first in system prompt
  // (extensions are loaded in packages array order; tools registered earlier
  // appear earlier in the "Available tools" list and Guidelines section)
  registerSubagentTool(pi);

  _onBgJobComplete = (job) => {
    refreshBgStatus();
    const elapsed = job.completedAt ? ((job.completedAt - job.startedAt) / 1000).toFixed(1) : "?";
    const statusEmoji = job.status === "completed" ? "✓" : "✗";
    const taskPreview = job.task.length > 80 ? `${job.task.slice(0, 80)}…` : job.task;
    const output = job.status === "completed"
      ? (job.resultSummary ?? "(no output)")
      : `Error: ${job.error ?? "unknown"}`;
    const modelInfo = job.model ? ` · ${job.model}` : "";
    pi.sendUserMessage(
      [
        `**Background subagent ${statusEmoji}: ${job.id}** (${job.agentName}, ${elapsed}s${modelInfo})`,
        `> ${taskPreview}`,
        ``,
        output,
      ].join("\n"),
      { deliverAs: "followUp" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    _setBgStatus = (text) => ctx.ui.setStatus(BG_STATUS_KEY, text);
    _sessionUi = ctx.ui;

    // Register below-editor widget (component factory form captures tui + theme)
    ctx.ui.setWidget("fast-subagent-list", (tui, theme) => {
      _tui = tui;
      return {
        render(width: number): string[] {
          const agents = [..._runningAgents.values()];
          if (agents.length === 0 && !_agentListFocused) return [];
          return buildAgentListLines(agents, theme, width);
        },
        invalidate() {},
      };
    }, { placement: "belowEditor" });

    // Register keyboard handler for agent list navigation
    const unsubInput = ctx.ui.onTerminalInput((data) => {
      if (_overlayOpen) return undefined;

      const agentList = [..._runningAgents.values()];

      if (!_agentListFocused) {
        // Focus on down-arrow if agents are running and editor has no newline
        if (agentList.length > 0 && matchesKey(data, Key.down)) {
          const editorText = _sessionUi?.getEditorText() ?? "";
          if (!editorText.includes("\n")) {
            _agentListFocused = true;
            _agentListSelectedIdx = 0;
            refreshAgentWidget();
            return { consume: true };
          }
        }
        return undefined;
      }

      // Agent list is focused
      const totalItems = 1 + agentList.length; // main + agents

      if (matchesKey(data, Key.down)) {
        _agentListSelectedIdx = Math.min(_agentListSelectedIdx + 1, totalItems - 1);
        refreshAgentWidget();
        return { consume: true };
      }
      if (matchesKey(data, Key.up)) {
        if (_agentListSelectedIdx === 0) {
          _agentListFocused = false;
          refreshAgentWidget();
          return undefined; // let editor receive the key
        }
        _agentListSelectedIdx--;
        refreshAgentWidget();
        return { consume: true };
      }
      if (matchesKey(data, Key.escape)) {
        _agentListFocused = false;
        _agentListSelectedIdx = 0;
        refreshAgentWidget();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        if (_agentListSelectedIdx === 0) {
          _agentListFocused = false;
          refreshAgentWidget();
        } else {
          const entry = agentList[_agentListSelectedIdx - 1];
          if (entry) openAgentDetailOverlay(entry);
        }
        return { consume: true };
      }
      if (data === "x" || data === "X") {
        if (_agentListSelectedIdx > 0) {
          const entry = agentList[_agentListSelectedIdx - 1];
          if (entry) {
            entry.abort();
            ctx.ui.notify(`Stopping ${entry.agentName}…`, "info");
          }
        }
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("k"))) {
        for (const entry of agentList) entry.abort();
        if (agentList.length > 0) ctx.ui.notify("Stopping all agents…", "info");
        return { consume: true };
      }

      return undefined;
    });
    _inputUnsubscribe = unsubInput;

    // Warm one extension-capable loader after startup so first `tools: all`
    // subagent call reuses loaded extensions instead of blocking.
    if (process.env.PI_FAST_SUBAGENT_WARM !== "0") {
      const warmCwd = ctx.cwd;
      const warmAgentDir = getAgentDir();
      setTimeout(() => defaultLoaderPool.warm(warmCwd, warmAgentDir, false), 1000);
    }
  });

  pi.on("session_shutdown", async () => {
    _inputUnsubscribe?.();
    _inputUnsubscribe = null;
    _sessionUi = null;
    _tui = null;
    _agentListFocused = false;
    _agentListSelectedIdx = 0;
    _overlayOpen = false;
    getBgManager().shutdown();
    _bgManager = null;
    _setBgStatus = null;
    defaultLoaderPool.clear();
  });

  // ─── Alt+Shift+B — detach foreground subagent ────────────────────────────
  pi.registerShortcut("alt+shift+b", {
    description: "Move foreground subagent to background",
    handler: async (ctx) => {
      const entry = [..._fgJobs.values()][0];
      if (!entry) {
        ctx.ui.notify("No foreground subagent running.", "info");
        return;
      }
      try {
        const bgJobId = entry.detach();
        ctx.ui.notify(
          `Moved ${entry.agentName} to background as ${bgJobId}. Completion will be announced automatically.`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  // ─── /fast-subagent ───────────────────────────────────────────────────────
  pi.registerCommand("fast-subagent", {
    description: "Open the fast-subagent control panel.",
    async handler(_args: string, ctx) {
      await openFastSubagentPanel({
        ctx,
        getAgents: () => discoverAgents(ctx.cwd),
        getBackgroundJobs: () => getBgManager().getAllJobs(),
        getRunningBackgroundJobs: () => getBgManager().getRunningJobs(),
        getForegroundJobs: () => [..._fgJobs.entries()].map(([id, entry]) => ({
          id,
          agentName: entry.agentName,
          task: entry.task,
          detach: entry.detach,
        })),
        writeDebugPrompt: () => writeDebugPrompt(ctx),
        cancelBackgroundJob: (jobId) => getBgManager().cancel(jobId),
      });
    },
  });

}
