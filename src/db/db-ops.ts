import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Opens a one-off pg client to verify whether the configured database is reachable.
 * Resolves if the connection and a simple `SELECT 1` succeed, otherwise rejects.
 */
export async function verifyDatabaseConnection(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not defined. Please set it before checking the connection."
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      `Failed to connect to the database. ${(error as Error).message}`
    );
  } finally {
    await pool.end().catch(() => {
      /* noop */
    });
  }
}

verifyDatabaseConnection()
  .then(() => {
    console.log("Database connection successful.");
  })
  .catch((error) => {
    console.error("Database connection failed:", error);
  });
