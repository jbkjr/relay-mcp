-- A registry (relay.db) as relay 0.2.0 left it: written by 0.2.0's own code (main at c6cd78c,
-- package version 0.2.0) through createRun, insertNode, insertTurn, updateTurn, updateNode and
-- decide, then dumped with sqlite3 .dump. PRAGMA user_version is 0, as 0.2.0 never set it.
-- One run: a finished write job with a job-scoped web approval, a finished thread, and a queued
-- job with a pending approval request (an active run at upgrade time).
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, root_cwd TEXT NOT NULL,
  config_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
, root_pid INTEGER, root_start TEXT, root_token TEXT);
INSERT INTO runs VALUES('run_475ecd79',1792104739727,'/Users/someone/project','{"max_depth":3,"max_concurrent":4,"block_s":240,"job_timeout_s":1800,"turn_timeout_s":600,"cancel_grace_ms":5000,"child_mcp":"relay-only","child_hooks":false,"child_network":false,"child_git":"relay","allow_dangerous":false,"escalation":true,"approval_timeout_s":3600,"notify":true,"ask_user":"auto","child_web":"inherit","codex_backend":"app-server","allow_temp_home":false,"child_settings":"isolated","child_auth":"login","trust_git_filters":false,"claude_managed_settings":"refuse","allow_untested":false,"default_model":{"codex":"gpt-6.1-sol"},"default_effort":{},"bin":{"claude":"claude","codex":"codex"}}','active',62458,'Thu Oct 15 16:52:19 2026','tok-020');
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
  target TEXT, mode TEXT NOT NULL, depth INTEGER NOT NULL, allow_delegation INTEGER NOT NULL,
  status TEXT NOT NULL, task TEXT NOT NULL, params_json TEXT, session_id TEXT,
  cwd TEXT NOT NULL, repo TEXT, worktree TEXT, branch TEXT, base_sha TEXT, model TEXT, effort TEXT,
  worker_pid INTEGER, worker_claimed_at INTEGER, agent_pid INTEGER, agent_pgid INTEGER,
  log_path TEXT, transcript_path TEXT, result_json TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
, worker_start TEXT, agent_start TEXT, owner_id TEXT, head_sha TEXT);
INSERT INTO nodes VALUES('j_0200aaaa','run_475ecd79',NULL,'job','codex','write',1,0,'done','Fix the parser','{"grant":{"network":true}}','019a-codex-thread','/Users/someone/project','/Users/someone/project','/Users/someone/.local/share/relay/worktrees/x/j_0200aaaa','relay/j_0200aaaa','0123456789abcdef0123456789abcdef01234567',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'{"status":"done","summary":"Fixed it.","commits":["abc1234"]}',NULL,1792104739731,NULL,1792104739731,NULL,NULL,NULL,'fedcba9876543210fedcba9876543210fedcba98');
INSERT INTO nodes VALUES('t_0200bbbb','run_475ecd79',NULL,'thread','codex','read',1,0,'done','Is this sound?',NULL,'019a-codex-thread-2','/Users/someone/project',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1792104739731,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO nodes VALUES('j_0200cccc','run_475ecd79',NULL,'job','codex','write',1,0,'queued','Still queued',NULL,NULL,'/Users/someone/project',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1792104739731,NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, source TEXT NOT NULL,
  body TEXT NOT NULL, access TEXT NOT NULL, status TEXT NOT NULL, reply TEXT, error TEXT,
  prompt_path TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
INSERT INTO turns VALUES(1,'j_0200aaaa','root','Fix the parser','write','done','Fixed it.',NULL,NULL,1792104739731,1792104739731,1792104739731);
INSERT INTO turns VALUES(2,'t_0200bbbb','root','Is this sound?','read','done','Mostly.',NULL,NULL,1792104739731,NULL,1792104739731);
INSERT INTO turns VALUES(3,'j_0200cccc','root','Still queued','write','queued',NULL,NULL,NULL,1792104739732,NULL,NULL);
CREATE TABLE injections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discussion_id TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE requests (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, reason TEXT, detail_json TEXT, status TEXT NOT NULL,
  decided_by TEXT, note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
, scope TEXT);
INSERT INTO requests VALUES('q_0200dddd','run_475ecd79','j_0200aaaa','web','fetch https://example.com','docs','{"cwd":"/Users/someone/project","access":"write"}','allowed','user','ok',1792104739732,1792104739732,'job');
INSERT INTO requests VALUES('q_0200eeee','run_475ecd79','j_0200cccc','web','fetch https://example.com','docs','{"cwd":"/Users/someone/project","access":"write"}','pending',NULL,NULL,1792104739732,NULL,NULL);
CREATE TABLE relay_procs (
  pid INTEGER NOT NULL, start TEXT NOT NULL, kind TEXT NOT NULL, node_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, holder TEXT NOT NULL,
  pid INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('turns',3);
CREATE INDEX nodes_run ON nodes(run_id);
CREATE INDEX nodes_parent ON nodes(parent_id);
CREATE INDEX turns_node ON turns(node_id);
CREATE INDEX requests_run ON requests(run_id, status);
COMMIT;
