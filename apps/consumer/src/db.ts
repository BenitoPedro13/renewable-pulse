import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({ connectionString });

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Applies every .sql file in migrations/ in filename order. No migration
 * framework yet — one table, plain SQL, matching TASK-ingest-spine.md §2.
 */
export async function runMigrations(): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
}
