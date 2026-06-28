import Database from "better-sqlite3";
import { applyMigrations } from "./migrations";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  applyMigrations(db);
  return db;
}
