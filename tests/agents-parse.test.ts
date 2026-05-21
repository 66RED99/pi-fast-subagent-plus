import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSubagentToolPrompt, type AgentConfig, parseMaxDepthField, parseThinkingField, parseToolsField } from "../agents.ts";

describe("parseToolsField", () => {
  it("defaults to 'all' when unset/empty/whitespace", () => {
    assert.equal(parseToolsField(undefined), "all");
    assert.equal(parseToolsField(null), "all");
    assert.equal(parseToolsField(""), "all");
    assert.equal(parseToolsField("   "), "all");
  });

  it("recognises canonical keywords case-insensitively", () => {
    assert.equal(parseToolsField("all"), "all");
    assert.equal(parseToolsField("ALL"), "all");
    assert.equal(parseToolsField("none"), "none");
    assert.equal(parseToolsField("NONE"), "none");
    assert.equal(parseToolsField("builtins"), "builtins");
    assert.equal(parseToolsField("builtin"), "builtins"); // legacy singular
  });

  it("parses comma-separated allowlists", () => {
    assert.deepEqual(parseToolsField("read, bash, web_search"), [
      "read",
      "bash",
      "web_search",
    ]);
  });

  it("trims blanks out of allowlists and falls back to 'all' when empty", () => {
    assert.deepEqual(parseToolsField("read, , bash"), ["read", "bash"]);
    assert.equal(parseToolsField(","), "all");
    assert.equal(parseToolsField(" , , "), "all");
  });
});

describe("parseThinkingField", () => {
  it("defaults to undefined when missing/empty", () => {
    assert.equal(parseThinkingField(undefined), undefined);
    assert.equal(parseThinkingField(null), undefined);
    assert.equal(parseThinkingField(""), undefined);
    assert.equal(parseThinkingField("   "), undefined);
  });

  it("accepts canonical levels case-insensitively", () => {
    assert.equal(parseThinkingField("off"), "off");
    assert.equal(parseThinkingField("LOW"), "low");
    assert.equal(parseThinkingField("medium"), "medium");
    assert.equal(parseThinkingField("xhigh"), "xhigh");
  });

  it("accepts common shorthand aliases", () => {
    assert.equal(parseThinkingField("min"), "minimal");
    assert.equal(parseThinkingField("med"), "medium");
    assert.equal(parseThinkingField("hi"), "high");
    assert.equal(parseThinkingField("xhi"), "xhigh");
  });

  it("returns undefined for invalid values", () => {
    assert.equal(parseThinkingField("maybe"), undefined);
    assert.equal(parseThinkingField("42"), undefined);
  });
});

describe("parseMaxDepthField", () => {
  it("defaults to 0 when missing/empty", () => {
    assert.equal(parseMaxDepthField(undefined), 0);
    assert.equal(parseMaxDepthField(null), 0);
    assert.equal(parseMaxDepthField(""), 0);
  });

  it("accepts numeric and string inputs", () => {
    assert.equal(parseMaxDepthField(2), 2);
    assert.equal(parseMaxDepthField("3"), 3);
  });

  it("floors fractional values", () => {
    assert.equal(parseMaxDepthField(2.9), 2);
    assert.equal(parseMaxDepthField("1.4"), 1);
  });

  it("clamps invalid / negative values to 0", () => {
    assert.equal(parseMaxDepthField("NaN"), 0);
    assert.equal(parseMaxDepthField("abc"), 0);
    assert.equal(parseMaxDepthField(-1), 0);
    assert.equal(parseMaxDepthField("-5"), 0);
    assert.equal(parseMaxDepthField(Infinity), 0);
  });
});

describe("buildSubagentToolPrompt", () => {
  it("uses minimal tool metadata with delegation guidance", () => {
    const prompt = buildSubagentToolPrompt();

    assert.equal(prompt.description, "Spawn subagents for delegated work");
    assert.equal(prompt.promptSnippet, "Spawn subagents for delegated work");
    assert.deepEqual(prompt.promptGuidelines, [
      "Before doing anything else, check whether the task can be delegated to a subagent.",
      "Always prefer subagents over using tools yourself whenever a suitable subagent exists.",
      "Use { action: 'list' } to inspect available agents before choosing one.",
      "Use single mode for one focused delegated task and parallel mode for independent delegated tasks.",
    ]);
  });

  it("keeps the same guidance when no agents are available", () => {
    const prompt = buildSubagentToolPrompt();

    assert.equal(prompt.description, "Spawn subagents for delegated work");
    assert.equal(prompt.promptSnippet, "Spawn subagents for delegated work");
    assert.deepEqual(prompt.promptGuidelines, [
      "Before doing anything else, check whether the task can be delegated to a subagent.",
      "Always prefer subagents over using tools yourself whenever a suitable subagent exists.",
      "Use { action: 'list' } to inspect available agents before choosing one.",
      "Use single mode for one focused delegated task and parallel mode for independent delegated tasks.",
    ]);
  });
});
