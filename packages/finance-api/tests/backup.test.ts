import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { backupDb, exportJson } from "../src/store/backup";
import { applyMigrations } from "../src/store/migrations";
import { upsertAccount, upsertHolding } from "../src/store/repo";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("backup", () => {
  it("backupDb produces an openable copy", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });

    const dir = mkdtempSync(path.join(tmpdir(), "backup-"));
    const dest = path.join(dir, "backup.db");
    await backupDb(db, dest);

    // Verify the backup is a valid SQLite file
    const backup = new Database(dest);
    const accounts = backup.prepare("SELECT * FROM accounts").all();
    expect(accounts).toHaveLength(1);
    expect((accounts[0] as { id: string }).id).toBe("fid-1");
    backup.close();
  });

  it("exportJson returns all tables", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    upsertAccount(db, { id: "fid-1", provider_id: "fidelity", kind: "brokerage", name: "Fidelity", currency: "USD" });
    upsertHolding(db, { account_id: "fid-1", symbol: "AAPL", quantity: 10, asset_class: "equity", as_of: 1 });

    const snapshot = exportJson(db);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.holdings).toHaveLength(1);
    expect(snapshot.transactions).toHaveLength(0);
    expect(snapshot.goals).toHaveLength(0);
  });
});
