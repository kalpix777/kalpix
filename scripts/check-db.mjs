// Verifies the PostgreSQL connection in DATABASE_URL. Exit code 1 on failure.
import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows } = await client.query("select version() as v, current_database() as db");
  console.log(`PostgreSQL OK: ${rows[0].db} | ${rows[0].v.split(",")[0]}`);
  await client.end();
} catch (err) {
  console.error(`PostgreSQL connection FAILED: ${err.message || err.code || String(err)}`);
  console.error("Start it with: pnpm db:up   (requires Docker Desktop running)");
  process.exit(1);
}
