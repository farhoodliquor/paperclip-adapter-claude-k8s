import { describe, it, expect } from "vitest";
import { isK8s404, buildPartialRunError } from "./execute.js";

describe("isK8s404", () => {
  it("returns false for non-Error values", () => {
    expect(isK8s404(null)).toBe(false);
    expect(isK8s404(undefined)).toBe(false);
    expect(isK8s404("string error")).toBe(false);
    expect(isK8s404(404)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isK8s404(new Error("something went wrong"))).toBe(false);
    expect(isK8s404(new Error("HTTP-Code: 500 Message: Internal Server Error"))).toBe(false);
  });

  it("detects 404 from v1.0+ message format", () => {
    const err = new Error("HTTP-Code: 404 Message: Unknown API Status Code! Body: ...");
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from v0.x response.statusCode", () => {
    const err = Object.assign(new Error("Not Found"), {
      response: { statusCode: 404 },
    });
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from v1.0+ response.status", () => {
    const err = Object.assign(new Error("Not Found"), {
      response: { status: 404 },
    });
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from direct statusCode property", () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404 });
    expect(isK8s404(err)).toBe(true);
  });

  it("does not match non-404 status codes on response", () => {
    const err = Object.assign(new Error("Forbidden"), {
      response: { statusCode: 403 },
    });
    expect(isK8s404(err)).toBe(false);
  });
});

describe("buildPartialRunError", () => {
  const initLine = JSON.stringify({
    type: "system",
    subtype: "init",
    model: "claude-sonnet-4-6",
    session_id: "sess_abc",
  });

  it("returns parse-failure message when exitCode is 0", () => {
    expect(buildPartialRunError(0, "", "")).toBe("Failed to parse Claude JSON output");
    expect(buildPartialRunError(0, "claude-sonnet-4-6", initLine)).toBe(
      "Failed to parse Claude JSON output",
    );
  });

  it("returns generic exit message when stdout is empty", () => {
    expect(buildPartialRunError(1, "", "")).toBe("Claude exited with code 1");
    expect(buildPartialRunError(null, "", "")).toBe("Claude exited with code -1");
  });

  it("skips system/init events and returns generic message when only init captured", () => {
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", initLine);
    expect(msg).toBe(
      "Claude started but did not produce a result (model: claude-sonnet-4-6) — check API credentials, model support, and adapter config",
    );
  });

  it("includes model from parsedStream when stdout is init-only", () => {
    const msg = buildPartialRunError(null, "MiniMax-M2.7", initLine);
    expect(msg).toContain("MiniMax-M2.7");
    expect(msg).not.toContain("type");
    expect(msg).not.toContain("system");
  });

  it("uses first non-system line as content when present", () => {
    const stdout = [initLine, "Error: no API key configured"].join("\n");
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", stdout);
    expect(msg).toBe("Claude exited with code 1: Error: no API key configured");
  });

  it("uses first non-system JSON event as content", () => {
    const resultLike = JSON.stringify({ type: "result", subtype: "error", result: "rate limit" });
    const stdout = [initLine, resultLike].join("\n");
    const msg = buildPartialRunError(2, "claude-sonnet-4-6", stdout);
    expect(msg).toContain("rate limit");
    expect(msg).toContain("code 2");
  });

  it("null exitCode renders as -1 in message", () => {
    const msg = buildPartialRunError(null, "", "Some plain error text");
    expect(msg).toBe("Claude exited with code -1: Some plain error text");
  });

  it("skips multiple consecutive system events", () => {
    const anotherSystem = JSON.stringify({ type: "system", subtype: "other" });
    const stdout = [initLine, anotherSystem, "real error line"].join("\n");
    const msg = buildPartialRunError(1, "model-x", stdout);
    expect(msg).toBe("Claude exited with code 1: real error line");
  });
});
