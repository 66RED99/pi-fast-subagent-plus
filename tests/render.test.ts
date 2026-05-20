import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatThinkingLabel } from "../render.ts";

describe("formatThinkingLabel", () => {
  it("returns empty when thinking is missing", () => {
    assert.equal(formatThinkingLabel(undefined), "");
    assert.equal(formatThinkingLabel(""), "");
  });

  it("formats the thinking level for display", () => {
    assert.equal(formatThinkingLabel("high"), "thinking:high");
    assert.equal(formatThinkingLabel("xhigh"), "thinking:xhigh");
  });
});
