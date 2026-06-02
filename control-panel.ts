import { DynamicBorder, getSelectListTheme, getSettingsListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type SelectItem,
  type SettingItem,
  matchesKey,
} from "@earendil-works/pi-tui";

import type { AgentConfig } from "./agents.js";
import type { BackgroundSubagentJob } from "./background-types.js";
import { formatBgJobDetails, formatBgJobSummary, formatTools, summarizeTask } from "./format.js";

export interface ForegroundPanelJob {
  id: string;
  agentName: string;
  task: string;
  detach: () => string;
}

export interface FastSubagentPanelOptions {
  ctx: ExtensionCommandContext;
  getAgents: () => AgentConfig[];
  getBackgroundJobs: () => BackgroundSubagentJob[];
  getRunningBackgroundJobs: () => BackgroundSubagentJob[];
  getForegroundJobs: () => ForegroundPanelJob[];
  cancelBackgroundJob: (jobId: string) => "cancelled" | "not_found" | "already_done";
}

export function formatAgentsValue(count: number): string {
  return count === 1 ? "1 available" : `${count} available`;
}

export function formatBackgroundJobsValue(jobs: BackgroundSubagentJob[]): string {
  const running = jobs.filter((job) => job.status === "running").length;
  return `${running} running · ${jobs.length} total`;
}

export function formatForegroundJobsValue(count: number): string {
  return count === 1 ? "1 active" : `${count} active`;
}

export function formatRunningJobsValue(count: number): string {
  return count === 1 ? "1 running" : `${count} running`;
}

function formatAgentDetails(agent: AgentConfig): string {
  return [
    `Name: ${agent.name}`,
    `Source: ${agent.source}`,
    `File: ${agent.filePath}`,
    `Description: ${agent.description}`,
    agent.model ? `Model: ${agent.model}` : null,
    agent.thinking ? `Thinking: ${agent.thinking}` : null,
    `Tools: ${formatTools(agent.tools)}`,
    `Max subagent depth: ${agent.maxDepth}`,
    agent.systemPrompt ? `\nSystem prompt:\n${agent.systemPrompt}` : null,
  ].filter(Boolean).join("\n");
}

function formatDetachResult(job: ForegroundPanelJob, bgJobId: string): string {
  return [
    `Moved ${job.agentName} to background as ${bgJobId}.`,
    "",
    `Foreground job: ${job.id}`,
    `Task: ${job.task}`,
  ].join("\n");
}

class DetailScreen implements Component {
  private container = new Container();

  constructor(
    private readonly theme: ExtensionCommandContext["ui"]["theme"],
    private readonly title: string,
    private readonly body: string,
    private readonly onBack: () => void,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    this.container = new Container();
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.body, 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.fg("dim", "Enter or Esc to go back"), 0, 0));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
      this.onBack();
    }
  }

  invalidate(): void {
    this.container.invalidate();
    this.rebuild();
  }
}

interface DrilldownSelectSubmenuOptions {
  title: string;
  description?: string;
  emptyMessage: string;
  listHint?: string;
  getItems: () => SelectItem[];
  getDetail: (value: string) => { title?: string; body: string };
  onClose: () => void;
}

class DrilldownSelectSubmenu implements Component {
  private container = new Container();
  private selectList: SelectList | null = null;
  private detailScreen: DetailScreen | null = null;

  constructor(
    private readonly theme: ExtensionCommandContext["ui"]["theme"],
    private readonly options: DrilldownSelectSubmenuOptions,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    const selectedValue = this.selectList?.getSelectedItem()?.value;

    this.container = new Container();
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.options.title)), 0, 0));

    if (this.options.description) {
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(this.theme.fg("muted", this.options.description), 0, 0));
    }

    this.container.addChild(new Spacer(1));

    if (this.detailScreen) {
      this.container.addChild(this.detailScreen);
      return;
    }

    const items = this.options.getItems();
    if (items.length === 0) {
      this.selectList = null;
      this.container.addChild(new Text(this.theme.fg("muted", this.options.emptyMessage), 0, 0));
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(this.theme.fg("dim", "Enter or Esc to go back"), 0, 0));
      return;
    }

    this.selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 36,
    });

    if (selectedValue) {
      const selectedIndex = items.findIndex((item) => item.value === selectedValue);
      if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);
    }

    this.selectList.onSelect = (item) => {
      const detail = this.options.getDetail(item.value);
      this.detailScreen = new DetailScreen(
        this.theme,
        detail.title ?? item.label,
        detail.body,
        () => {
          this.detailScreen = null;
          this.rebuild();
        },
      );
      this.rebuild();
    };
    this.selectList.onCancel = this.options.onClose;

    this.container.addChild(this.selectList);
    this.container.addChild(new Spacer(1));
    this.container.addChild(
      new Text(this.theme.fg("dim", this.options.listHint ?? "↑↓ navigate · Enter inspect · Esc back"), 0, 0),
    );
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  handleInput(data: string): void {
    if (this.detailScreen) {
      this.detailScreen.handleInput?.(data);
      return;
    }

    if (!this.selectList) {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
        this.options.onClose();
      }
      return;
    }

    this.selectList.handleInput(data);
  }

  invalidate(): void {
    this.container.invalidate();
    this.detailScreen?.invalidate();
    this.rebuild();
  }
}

interface ActionSubmenuOptions {
  title: string;
  description?: string;
  emptyMessage: string;
  actionVerb: string;
  getItems: () => SelectItem[];
  runAction: (value: string) => { title?: string; body: string };
  onAfterAction?: () => void;
  onClose: () => void;
}

class ActionSelectSubmenu implements Component {
  private container = new Container();
  private selectList: SelectList | null = null;
  private detailScreen: DetailScreen | null = null;

  constructor(
    private readonly theme: ExtensionCommandContext["ui"]["theme"],
    private readonly options: ActionSubmenuOptions,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    const selectedValue = this.selectList?.getSelectedItem()?.value;

    this.container = new Container();
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.options.title)), 0, 0));

    if (this.options.description) {
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(this.theme.fg("muted", this.options.description), 0, 0));
    }

    this.container.addChild(new Spacer(1));

    if (this.detailScreen) {
      this.container.addChild(this.detailScreen);
      return;
    }

    const items = this.options.getItems();
    if (items.length === 0) {
      this.selectList = null;
      this.container.addChild(new Text(this.theme.fg("muted", this.options.emptyMessage), 0, 0));
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(this.theme.fg("dim", "Enter or Esc to go back"), 0, 0));
      return;
    }

    this.selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 36,
    });

    if (selectedValue) {
      const selectedIndex = items.findIndex((item) => item.value === selectedValue);
      if (selectedIndex >= 0) this.selectList.setSelectedIndex(selectedIndex);
    }

    this.selectList.onSelect = (item) => {
      const result = this.options.runAction(item.value);
      this.options.onAfterAction?.();
      this.detailScreen = new DetailScreen(
        this.theme,
        result.title ?? item.label,
        result.body,
        () => {
          this.detailScreen = null;
          this.rebuild();
        },
      );
      this.rebuild();
    };
    this.selectList.onCancel = this.options.onClose;

    this.container.addChild(this.selectList);
    this.container.addChild(new Spacer(1));
    this.container.addChild(
      new Text(this.theme.fg("dim", `↑↓ navigate · Enter ${this.options.actionVerb} · Esc back`), 0, 0),
    );
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  handleInput(data: string): void {
    if (this.detailScreen) {
      this.detailScreen.handleInput?.(data);
      return;
    }

    if (!this.selectList) {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
        this.options.onClose();
      }
      return;
    }

    this.selectList.handleInput(data);
  }

  invalidate(): void {
    this.container.invalidate();
    this.detailScreen?.invalidate();
    this.rebuild();
  }
}

class ActionConfirmSubmenu implements Component {
  private container = new Container();
  private detailScreen: DetailScreen | null = null;

  constructor(
    private readonly theme: ExtensionCommandContext["ui"]["theme"],
    private readonly title: string,
    private readonly description: string,
    private readonly actionLabel: string,
    private readonly runAction: () => Promise<{ title?: string; body: string }> | { title?: string; body: string },
    private readonly onClose: () => void,
    private readonly requestRender: () => void,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    this.container = new Container();
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 0, 0));
    this.container.addChild(new Spacer(1));

    if (this.detailScreen) {
      this.container.addChild(this.detailScreen);
      return;
    }

    this.container.addChild(new Text(this.description, 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.fg("dim", `Enter ${this.actionLabel} · Esc back`), 0, 0));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  handleInput(data: string): void {
    if (this.detailScreen) {
      this.detailScreen.handleInput?.(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.onClose();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      Promise.resolve(this.runAction())
        .then((result) => {
          this.detailScreen = new DetailScreen(
            this.theme,
            result.title ?? this.title,
            result.body,
            () => this.onClose(),
          );
          this.rebuild();
          this.requestRender();
        })
        .catch((error) => {
          this.detailScreen = new DetailScreen(
            this.theme,
            this.title,
            error instanceof Error ? error.message : String(error),
            () => this.onClose(),
          );
          this.rebuild();
          this.requestRender();
        });
    }
  }

  invalidate(): void {
    this.container.invalidate();
    this.detailScreen?.invalidate();
    this.rebuild();
  }
}

export async function openFastSubagentPanel(options: FastSubagentPanelOptions): Promise<void> {
  const { ctx } = options;

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    let container = new Container();

    let settingsList: SettingsList;

    const refreshValues = (): void => {
      settingsList.updateValue("agents", formatAgentsValue(options.getAgents().length));
      settingsList.updateValue("background-jobs", formatBackgroundJobsValue(options.getBackgroundJobs()));
      settingsList.updateValue("cancel-background", formatRunningJobsValue(options.getRunningBackgroundJobs().length));
      settingsList.updateValue("detach-foreground", formatForegroundJobsValue(options.getForegroundJobs().length));
      tui.requestRender();
    };

    const items: SettingItem[] = [
      {
        id: "agents",
        label: "Agents",
        description: "Browse available subagents and inspect their configuration.",
        currentValue: formatAgentsValue(options.getAgents().length),
        submenu: (_currentValue, closeSubmenu) => new DrilldownSelectSubmenu(theme, {
          title: "Available Agents",
          description: "Inspect subagent descriptions, tools, thinking, and prompts.",
          emptyMessage: "No agents found. Add .md files under ~/.pi/agent/agents/ or .pi/agents/.",
          getItems: () => options.getAgents().map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: `${agent.source}${agent.model ? ` · ${agent.model}` : ""} · ${agent.description}`,
          })),
          getDetail: (value) => {
            const agent = options.getAgents().find((item) => item.name === value);
            return {
              title: value,
              body: agent ? formatAgentDetails(agent) : `Agent ${value} is no longer available.`,
            };
          },
          onClose: () => closeSubmenu(),
        }),
      },
      {
        id: "background-jobs",
        label: "Background jobs",
        description: "Inspect running, completed, failed, and cancelled background jobs.",
        currentValue: formatBackgroundJobsValue(options.getBackgroundJobs()),
        submenu: (_currentValue, closeSubmenu) => new DrilldownSelectSubmenu(theme, {
          title: "Background Jobs",
          description: "Inspect live or recent subagent jobs.",
          emptyMessage: "No background jobs yet.",
          getItems: () => options.getBackgroundJobs()
            .sort((a, b) => b.startedAt - a.startedAt)
            .map((job) => ({
              value: job.id,
              label: job.id,
              description: `${job.status} · ${job.agentName} · ${summarizeTask(job.task, 72)}`,
            })),
          getDetail: (value) => {
            const job = options.getBackgroundJobs().find((item) => item.id === value);
            return {
              title: value,
              body: job ? formatBgJobDetails(job) : `Background job ${value} is no longer available.`,
            };
          },
          onClose: () => closeSubmenu(),
        }),
      },
      {
        id: "cancel-background",
        label: "Cancel bg job",
        description: "Stop a running background subagent job.",
        currentValue: formatRunningJobsValue(options.getRunningBackgroundJobs().length),
        submenu: (_currentValue, closeSubmenu) => new ActionSelectSubmenu(theme, {
          title: "Cancel Background Job",
          description: "Choose a running job to cancel immediately.",
          emptyMessage: "No running background jobs to cancel.",
          actionVerb: "cancel",
          getItems: () => options.getRunningBackgroundJobs()
            .sort((a, b) => b.startedAt - a.startedAt)
            .map((job) => ({
              value: job.id,
              label: job.id,
              description: formatBgJobSummary(job),
            })),
          runAction: (value) => {
            const result = options.cancelBackgroundJob(value);
            const job = options.getBackgroundJobs().find((item) => item.id === value);
            const body = result === "cancelled"
              ? job
                ? `${formatBgJobDetails(job)}\n\nCancelled from control panel.`
                : `Background job ${value} cancelled.`
              : result === "already_done"
                ? `Background job ${value} already completed.`
                : `Background job ${value} not found.`;
            return { title: value, body };
          },
          onAfterAction: refreshValues,
          onClose: () => closeSubmenu(),
        }),
      },
      {
        id: "detach-foreground",
        label: "Detach fg job",
        description: "Move a running foreground subagent to the background queue.",
        currentValue: formatForegroundJobsValue(options.getForegroundJobs().length),
        submenu: (_currentValue, closeSubmenu) => new ActionSelectSubmenu(theme, {
          title: "Detach Foreground Job",
          description: "Move a foreground subagent to background execution.",
          emptyMessage: "No foreground subagent jobs are currently running.",
          actionVerb: "detach",
          getItems: () => options.getForegroundJobs().map((job) => ({
            value: job.id,
            label: job.id,
            description: `${job.agentName} · ${summarizeTask(job.task, 72)}`,
          })),
          runAction: (value) => {
            const job = options.getForegroundJobs().find((item) => item.id === value);
            if (!job) {
              return { title: value, body: `Foreground job ${value} is no longer available.` };
            }
            const bgJobId = job.detach();
            return { title: value, body: formatDetachResult(job, bgJobId) };
          },
          onAfterAction: refreshValues,
          onClose: () => closeSubmenu(),
        }),
      },
    ];

    settingsList = new SettingsList(items, Math.min(items.length + 2, 12), getSettingsListTheme(), () => {}, () => done(undefined), {
      enableSearch: true,
    });

    const rebuild = (): void => {
      container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Fast Subagent")), 1, 0));
      container.addChild(new Text(theme.fg("muted", "Settings-style control panel for agents and job management."), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(settingsList);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    };

    rebuild();

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        settingsList.invalidate();
        rebuild();
      },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
        refreshValues();
      },
    };
  });
}
