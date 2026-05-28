import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  formatAgentsValue,
  formatBackgroundJobsValue,
  formatForegroundJobsValue,
  formatRunningJobsValue,
} from "../control-panel.ts";
import type { BackgroundSubagentJob } from "../background-types.ts";

function makeJob(id: string, status: BackgroundSubagentJob["status"]): BackgroundSubagentJob {
  return {
    id,
    agentName: "scout",
    task: "inspect codebase",
    cwd: "/tmp",
    status,
    startedAt: 1000,
    abortController: new AbortController(),
    promise: Promise.resolve(),
  };
}

describe("control panel value formatters", () => {
  it("formats agent counts", () => {
    assert.equal(formatAgentsValue(0), "0 available");
    assert.equal(formatAgentsValue(1), "1 available");
    assert.equal(formatAgentsValue(3), "3 available");
  });

  it("formats background job summary counts", () => {
    const jobs = [
      makeJob("sa_1", "running"),
      makeJob("sa_2", "completed"),
      makeJob("sa_3", "running"),
    ];

    assert.equal(formatBackgroundJobsValue([]), "0 running · 0 total");
    assert.equal(formatBackgroundJobsValue(jobs), "2 running · 3 total");
  });

  it("formats foreground and running job counts", () => {
    assert.equal(formatForegroundJobsValue(0), "0 active");
    assert.equal(formatForegroundJobsValue(1), "1 active");
    assert.equal(formatForegroundJobsValue(4), "4 active");

    assert.equal(formatRunningJobsValue(0), "0 running");
    assert.equal(formatRunningJobsValue(1), "1 running");
    assert.equal(formatRunningJobsValue(2), "2 running");
  });
});
