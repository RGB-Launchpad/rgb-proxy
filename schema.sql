-- Mirrors the schema of the reference implementation, RGB-Tools/rgb-proxy-server.
-- One difference: `filename` is called `object_key` here, the key in R2. Same meaning: the
-- sha256 of the file content.
CREATE TABLE IF NOT EXISTS consignments (
  recipient_id  TEXT PRIMARY KEY,
  object_key    TEXT NOT NULL,      -- hex sha256 of the file content
  txid          TEXT NOT NULL,
  vout          INTEGER,
  ack           INTEGER,            -- NULL / 0 / 1
  created_at    INTEGER NOT NULL    -- for TTL cleanup; not in the official schema
);

CREATE TABLE IF NOT EXISTS media (
  attachment_id TEXT PRIMARY KEY,
  object_key    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consignments_created ON consignments(created_at);
