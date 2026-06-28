import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db";
import { insertSuggestion, listPendingSuggestions, dismissSuggestion, upsertGoal, listGoals } from "../src/store/repo";

describe("suggestions + goals repo", () => {
  it("inserts, lists, and dismisses suggestions", () => {
    const db = openDb(":memory:");
    insertSuggestion(db, { id: "s1", created_at: 1, market_session: "intraday", kind: "drift", payload: "{}", status: "pending" });
    insertSuggestion(db, { id: "s2", created_at: 2, market_session: "intraday", kind: "dca", payload: "{}", status: "pending" });
    expect(listPendingSuggestions(db)).toHaveLength(2);
    dismissSuggestion(db, "s1");
    const pending = listPendingSuggestions(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("s2");
  });

  it("upserts and lists goals", () => {
    const db = openDb(":memory:");
    upsertGoal(db, { id: "g1", name: "Growth", target_allocation: JSON.stringify({ equity: 0.8, bonds: 0.2 }), risk_limits: JSON.stringify({}) });
    const goals = listGoals(db);
    expect(goals).toHaveLength(1);
    expect(goals[0].name).toBe("Growth");
    // Update
    upsertGoal(db, { id: "g1", name: "Growth v2", target_allocation: JSON.stringify({ equity: 0.9, bonds: 0.1 }), risk_limits: JSON.stringify({}) });
    expect(listGoals(db)[0]).toHaveProperty("name", "Growth v2");
  });
});
