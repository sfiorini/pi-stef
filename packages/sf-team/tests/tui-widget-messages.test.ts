import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addWorkflowMessage,
  createWorkflowReporter,
  expireWorkflowMessages,
  MAX_WORKFLOW_MESSAGES,
  renderWorkflowMessages,
  WORKFLOW_MESSAGE_MAX_CHARS,
  type WorkflowMessage,
} from "@pi-stef/agent-workflows";

import { mountWidget } from "../src/tui/dispose";
import { emptyState, setMessages, setMilestones, setResume, upsertAgent } from "../src/tui/state";

afterEach(() => {
  vi.useRealTimers();
});

describe("workflow widget messages", () => {
  it("keeps a bounded newest-first lane and truncates long message text", () => {
    let messages: WorkflowMessage[] = [];
    for (let i = 1; i <= MAX_WORKFLOW_MESSAGES + 1; i += 1) {
      messages = addWorkflowMessage(messages, {
        id: `m-${i}`,
        level: "info",
        text: `message ${i}`,
      }, i);
    }

    expect(messages).toHaveLength(MAX_WORKFLOW_MESSAGES);
    expect(messages.map((message) => message.id)).toEqual(["m-2", "m-3", "m-4", "m-5", "m-6"]);

    const longText = `installing ${"dependencies ".repeat(40)}`;
    messages = addWorkflowMessage([], { id: "long", level: "warning", text: longText }, 10);
    expect(messages[0].text.length).toBeLessThanOrEqual(WORKFLOW_MESSAGE_MAX_CHARS);
    expect(messages[0].text.endsWith("...")).toBe(true);
    expect(renderWorkflowMessages(messages)[0]).toContain("warn:");
  });

  it("renders after the header and resume banner but before milestones and agent cards", () => {
    let state = emptyState();
    state = setResume(state, { show: true, text: "Resume from S-201?" });
    state = setMessages(state, [
      { id: "install", level: "info", text: "installing dependencies", createdAtMs: 1_000 },
    ]);
    state = setMilestones(state, [
      { id: "M2", title: "Widget Message Lane", completed: 1, inDev: 1, total: 4 },
    ]);
    state = upsertAgent(state, {
      id: "dev",
      role: "developer",
      model: "claude-opus-4-7",
      state: "running",
    });

    const calls: string[][] = [];
    const ui = {
      setWidget: (_key: string, lines: unknown) => {
        if (Array.isArray(lines)) calls.push(lines as string[]);
      },
    } as never;

    const handle = mountWidget(ui, { useColor: false, now: () => 1_000 });
    handle.update(state);

    const lines = calls.at(-1) ?? [];
    const headerIndex = lines.findIndex((line) => line.includes("sf-team"));
    const resumeIndex = lines.findIndex((line) => line.includes("Resume from S-201"));
    const messageIndex = lines.findIndex((line) => line.includes("installing dependencies"));
    const milestoneIndex = lines.findIndex((line) => line.includes("M2["));
    const agentIndex = lines.findIndex((line) => line.includes("developer"));

    expect(headerIndex).toBe(0);
    expect(resumeIndex).toBeGreaterThan(headerIndex);
    expect(messageIndex).toBeGreaterThan(resumeIndex);
    expect(milestoneIndex).toBeGreaterThan(messageIndex);
    expect(agentIndex).toBeGreaterThan(milestoneIndex);
  });

  it("expires messages on a timer and re-renders without an agent event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let state = emptyState();
    let renders = 0;

    const reporter = createWorkflowReporter({
      getMessages: () => state.messages,
      setMessages: (messages) => {
        state = setMessages(state, messages);
      },
      render: () => {
        renders += 1;
      },
    });

    reporter.message("dependency install skipped", { level: "info", ttlMs: 1_000 });
    expect(state.messages).toHaveLength(1);
    expect(renders).toBe(1);

    vi.advanceTimersByTime(999);
    expect(expireWorkflowMessages(state.messages, Date.now())).toHaveLength(1);
    expect(state.messages).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(state.messages).toHaveLength(0);
    expect(renders).toBe(2);

    reporter.dispose();
  });

  it("does not touch widget state or re-render after disposal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    let state = emptyState();
    let renders = 0;

    const reporter = createWorkflowReporter({
      getMessages: () => state.messages,
      setMessages: (messages) => {
        state = setMessages(state, messages);
      },
      render: () => {
        renders += 1;
      },
    });

    reporter.message("short-lived status", { level: "info", ttlMs: 1_000 });
    reporter.dispose();
    vi.advanceTimersByTime(1_000);

    expect(state.messages).toHaveLength(1);
    expect(renders).toBe(1);
  });

  it("writes to stderr when no widget state is available", () => {
    const writes: string[] = [];
    const reporter = createWorkflowReporter({
      headless: true,
      stderr: {
        write(chunk: string | Uint8Array): boolean {
          writes.push(String(chunk));
          return true;
        },
      },
    });

    reporter.message("installing dependencies", { level: "info" });

    expect(writes.join("")).toContain("info: installing dependencies");
    reporter.dispose();
  });
});
