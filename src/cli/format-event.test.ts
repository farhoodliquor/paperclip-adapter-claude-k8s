import { describe, it, expect, vi, beforeEach } from "vitest";
import { printClaudeStreamEvent, formatClaudeStreamLine } from "./format-event.js";

// Mock console methods to capture output
const consoleMock = {
  log: vi.fn(),
};

vi.stubGlobal("console", {
  ...console,
  log: consoleMock.log,
});

beforeEach(() => {
  consoleMock.log.mockClear();
});

function output() {
  return consoleMock.log.mock.calls.map((c) => c[0]).join("\n");
}

describe("printClaudeStreamEvent", () => {
  it("prints raw line if not JSON", () => {
    printClaudeStreamEvent("hello world", false);
    expect(output()).toBe("hello world");
  });

  it("skips empty lines", () => {
    printClaudeStreamEvent("  ", false);
    expect(output()).toBe("");
  });

  it("prints init event with model and session", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-6",
      session_id: "sess_abc123",
    }), false);
    expect(output()).toContain("Claude initialized");
    expect(output()).toContain("claude-opus-4-6");
    expect(output()).toContain("sess_abc123");
  });

  it("prints assistant text block", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    }), false);
    expect(output()).toContain("assistant: Hello world");
  });

  it("prints thinking block", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
    }), false);
    expect(output()).toContain("thinking: Let me think...");
  });

  it("prints tool_use block with name and input", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Bash",
          input: { command: "ls -la" },
        }],
      },
    }), false);
    expect(output()).toContain("tool_call: Bash");
    expect(output()).toContain("ls -la");
  });

  it("prints tool_result for user message", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "file1.txt\nfile2.txt",
        }],
      },
    }), false);
    expect(output()).toContain("tool_result");
  });

  it("marks tool_result as error when is_error is true", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool_1",
          is_error: true,
          content: "Permission denied",
        }],
      },
    }), false);
    expect(output()).toContain("tool_result (error)");
  });

  it("prints result with tokens and cost", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "result",
      result: "Done",
      subtype: "stop",
      total_cost_usd: 0.005,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 50,
      },
    }), false);
    expect(output()).toContain("tokens:");
    expect(output()).toContain("in=100");
    expect(output()).toContain("out=200");
    expect(output()).toContain("cached=50");
    expect(output()).toContain("cost=");
  });

  it("prints error subtype in result", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "result",
      subtype: "error_rate_limit",
      is_error: true,
      errors: ["rate limited"],
    }), false);
    expect(output()).toContain("claude_result");
    expect(output()).toContain("error_rate_limit");
    expect(output()).toContain("rate limited");
  });

  it("prints non-JSON lines directly", () => {
    printClaudeStreamEvent("some output text", false);
    expect(output()).toBe("some output text");
  });

  it("prints rate_limit_event with type, status, and reset time", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1777056000,
        rateLimitType: "five_hour",
        overageStatus: "allowed",
        isUsingOverage: false,
      },
      uuid: "3ab8f9eb-b9d6-4bf6-9c39-4608427717fc",
      session_id: "ad5f3e11-3c0c-4144-b53d-d4b959e57cee",
    }), false);
    expect(output()).toContain("rate_limit:");
    expect(output()).toContain("five_hour");
    expect(output()).toContain("allowed");
    expect(output()).toContain("resets=");
    // Raw JSON must not be surfaced verbatim
    expect(output()).not.toContain("3ab8f9eb-b9d6-4bf6-9c39-4608427717fc");
  });

  it("prints rate_limit_event with unknown fields gracefully", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {},
    }), false);
    expect(output()).toContain("rate_limit:");
    expect(output()).toContain("type=unknown");
    expect(output()).toContain("status=unknown");
    // No resetsAt present — reset clause omitted
    expect(output()).not.toContain("resets=");
  });

  it("does not print unknown types in non-debug mode", () => {
    printClaudeStreamEvent(JSON.stringify({ type: "unknown", data: "stuff" }), false);
    expect(output()).toBe("");
  });

  it("prints unknown types in debug mode", () => {
    printClaudeStreamEvent(JSON.stringify({ type: "unknown", data: "stuff" }), true);
    expect(output()).toContain("stuff");
  });
});

describe("formatClaudeStreamLine", () => {
  it("returns null for empty/blank lines", () => {
    expect(formatClaudeStreamLine("")).toBeNull();
    expect(formatClaudeStreamLine("   ")).toBeNull();
  });

  it("returns raw text for non-JSON lines (adapter status messages pass through)", () => {
    expect(formatClaudeStreamLine("[paperclip] Pod running: pod-abc")).toBe("[paperclip] Pod running: pod-abc");
    expect(formatClaudeStreamLine("Error: disk full")).toBe("Error: disk full");
  });

  it("formats system/init event", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "system", subtype: "init", model: "claude-opus-4-7", session_id: "sess_abc",
    }));
    expect(result).toContain("Claude initialized");
    expect(result).toContain("claude-opus-4-7");
    expect(result).toContain("sess_abc");
    expect(result).not.toContain("{");
  });

  it("formats assistant text block", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    }));
    expect(result).toBe("assistant: Hello world");
  });

  it("formats assistant thinking block", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
    }));
    expect(result).toBe("thinking: Let me think...");
  });

  it("formats assistant tool_use block", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    }));
    expect(result).toContain("tool_call: Bash");
    expect(result).toContain("ls");
  });

  it("returns null for assistant with no printable content (thinking-only with empty text)", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "" }] },
    }));
    expect(result).toBeNull();
  });

  it("formats user tool_result", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "file1.txt\nfile2.txt" }] },
    }));
    expect(result).toContain("tool_result");
    expect(result).toContain("file1.txt");
  });

  it("formats user tool_result error", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content: "Permission denied" }] },
    }));
    expect(result).toContain("tool_result (error)");
    expect(result).toContain("Permission denied");
  });

  it("formats result event with tokens and cost", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "result", result: "Done", subtype: "stop", total_cost_usd: 0.005,
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50 },
    }));
    expect(result).toContain("result:");
    expect(result).toContain("Done");
    expect(result).toContain("in=100");
    expect(result).toContain("out=200");
    expect(result).toContain("cached=50");
  });

  it("formats rate_limit_event (FAR-32 repro)", () => {
    const result = formatClaudeStreamLine(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1777056000, rateLimitType: "five_hour" },
    }));
    expect(result).toContain("rate_limit:");
    expect(result).toContain("five_hour");
    expect(result).toContain("allowed");
    expect(result).not.toContain("{");
  });

  it("returns null for unknown event types", () => {
    expect(formatClaudeStreamLine(JSON.stringify({ type: "unknown_event", data: "x" }))).toBeNull();
  });
});
