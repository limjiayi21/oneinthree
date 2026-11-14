-- One row per Part 2 session, for aggregate counts only.
-- No transcripts, spoken or typed words, or audio are stored here.
CREATE TABLE IF NOT EXISTS playthroughs (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,          -- ISO 8601, when the Part 2 session began
  updated_at TEXT NOT NULL,          -- ISO 8601, last write
  tactics    TEXT,                   -- JSON array of Part 2 free-play tactics, in order
  outcome    TEXT,                   -- Part 2 OutcomeKind
  guided_m1  TEXT,                   -- first choice id picked at each guided moment
  guided_m2  TEXT,
  guided_m3  TEXT
);
CREATE INDEX IF NOT EXISTS playthroughs_created ON playthroughs (created_at);
