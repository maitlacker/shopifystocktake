const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stocktake_history (
      id           SERIAL PRIMARY KEY,
      product_id   BIGINT NOT NULL,
      product_title TEXT NOT NULL,
      initials     TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_stocktake_product_id
      ON stocktake_history(product_id);

    CREATE INDEX IF NOT EXISTS idx_stocktake_created_at
      ON stocktake_history(created_at DESC);
  `);
}

module.exports = { pool, initDb };
