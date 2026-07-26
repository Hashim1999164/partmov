import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = join(__dirname, "../../migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const existing = await pool.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [file]);
    if (existing.rowCount) {
      console.log(`skip ${file}`);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
