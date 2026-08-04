CREATE TABLE IF NOT EXISTS signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  notes TEXT,
  join_accelerator TEXT,
  join_many_languages TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
  decided_at TEXT,
  canvas_user_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_signups_status ON signups(status);
CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(email);
