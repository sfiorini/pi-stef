import { describe, it, expect, afterEach } from "vitest";
import { isEnabled, sessionName, shouldAdopt } from "../src/tmux/manager.js";

describe("tmux manager", () => {
  afterEach(() => {
    delete process.env.SF_FLOW_NO_TMUX;
  });

  it("isEnabled false when SF_FLOW_NO_TMUX=1", () => {
    process.env.SF_FLOW_NO_TMUX = "1";
    expect(isEnabled()).toBe(false);
  });
  it("isEnabled true by default", () => {
    delete process.env.SF_FLOW_NO_TMUX;
    expect(isEnabled()).toBe(true);
  });
  it("isEnabled true when SF_FLOW_NO_TMUX=0", () => {
    process.env.SF_FLOW_NO_TMUX = "0";
    expect(isEnabled()).toBe(true);
  });
  it("sessionName matches sf-flow-<hex>", () => {
    expect(sessionName("abcdef12")).toBe("sf-flow-abcdef12");
  });
  it("shouldAdopt rejects sessions owned by another launcher", () => {
    expect(shouldAdopt("sf-flow-abcdef12", "sf-flow-deadbeef")).toBe(false);
    expect(shouldAdopt("sf-flow-abcdef12", "sf-flow-abcdef12")).toBe(true);
  });
});
