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

-- Tracks every /submit attempt (spam or not) for IP rate limiting.
CREATE TABLE IF NOT EXISTS submission_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_ip_time ON submission_attempts(ip, created_at);

-- Audit log of submissions rejected by spam filters (honeypot, time-trap,
-- rate limit) so they can be reviewed later instead of vanishing silently.
CREATE TABLE IF NOT EXISTS blocked_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  ip TEXT NOT NULL,
  reason TEXT NOT NULL, -- 'rate_limit' | 'honeypot' | 'time_trap'
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_blocked_created ON blocked_signups(created_at);
