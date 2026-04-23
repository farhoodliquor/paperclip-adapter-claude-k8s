import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

const onLog = vi.fn();

describe("prepareClaudePromptBundle path traversal validation", () => {
  const validArgs = {
    skills: [],
    instructionsContents: null,
    onLog,
  };

  it("rejects companyId containing ..", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: ".." })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing ../x", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "../x" })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing /", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "a/b" })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing backslash", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "a\\b" })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing null byte", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "a\0b" })).rejects.toThrow(/companyId/);
  });

  it("rejects empty companyId", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "" })).rejects.toThrow(/companyId/);
  });

  it("rejects whitespace-only companyId", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "   " })).rejects.toThrow(/companyId/);
  });

  it("accepts a valid companyId", async () => {
    vi.stubEnv("PAPERCLIP_HOME", path.join(os.tmpdir(), `prompt-cache-test-${process.pid}`));
    const result = await prepareClaudePromptBundle({ ...validArgs, companyId: "acme-co" });
    expect(result.rootDir).toContain("acme-co");
    vi.unstubAllEnvs();
  });
});
