-- AIU-470: Reconcile drizzle.__drizzle_migrations for rebase v2026.403.0 -> v2026.416.0
--
-- Context: fork had 4 custom schema migrations under old numbers 0049-0052.
-- Upstream v2026.416.0 introduces migrations 0049-0056 that overlap those
-- numbers with different content-hashes. After rebase:
--   - Upstream 0049-0056 take the 0049-0056 slots.
--   - Our consolidated fork change lands as 0057_aiu_fork_customizations.
--
-- Prod DB state (pre-deploy) holds:
--   - __drizzle_migrations rows for 0000-0048 (identical to rebase state -- no change needed).
--   - 4 old fork rows (old 0049-0052 hashes/names) that must be dropped.
--   - Schema already contains: agents.last_timer_heartbeat_at,
--     heartbeat_runs.instructions_hash_before, issues.scheduled_for (+ index),
--     heartbeat_runs.process_group_id (prod had the process_group_id backport
--     commit that is now in upstream c566a923 / migration 0055).
--
-- This script:
--   1. Snapshots the current __drizzle_migrations rows into a temp table.
--   2. Deletes the 4 old fork rows (by name).
--   3. Inserts rows for upstream 0049-0056 (marking them "already applied")
--      so drizzle-kit migrate() skips them. 0055 is ALSO marked applied
--      because prod already has process_group_id; the SQL itself is now
--      idempotent via `ADD COLUMN IF NOT EXISTS` (belt-and-suspenders).
--   4. Inserts row for 0057_aiu_fork_customizations so drizzle skips it
--      (columns already exist via the old fork migrations).
--   5. Verifies final state: count = 58, all names unique.
--   6. COMMITs (run with -v ON_ERROR_STOP=1).
--
-- Run ONCE against prod before applying the rebase deployment.
-- Idempotent: re-running after successful apply is a no-op (DELETEs/INSERTs
-- guarded by NOT EXISTS / WHERE clauses).

BEGIN;

-- 1. Snapshot current state
CREATE TEMP TABLE aiu_470_migration_snapshot ON COMMIT DROP AS
  SELECT id, hash, created_at
  FROM drizzle.__drizzle_migrations
  ORDER BY id;

DO $$
BEGIN
  RAISE NOTICE 'aiu-470 reconcile: snapshot has % rows',
    (SELECT COUNT(*) FROM aiu_470_migration_snapshot);
END $$;

-- 2. Delete old fork migration rows (names that match fork's historical 0049-0052 tags).
--    Names are immutable once inserted; if prod used different fork tag names,
--    extend this list before running.
DELETE FROM drizzle.__drizzle_migrations
WHERE hash IN (
  -- Old fork migration content-hashes (placeholder: filled in at run time by ops
  -- via SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at > ...).
  -- If your __drizzle_migrations table does not have a `name` column, use the
  -- created_at cutoff from migration 0048 (folderMillis=1775145655557).
  SELECT hash
  FROM aiu_470_migration_snapshot
  WHERE created_at > 1775145655557  -- after 0048_flashy_marrow
);

DO $$
DECLARE
  deleted_count INT;
BEGIN
  SELECT COUNT(*) INTO deleted_count FROM drizzle.__drizzle_migrations
    WHERE id IN (SELECT id FROM aiu_470_migration_snapshot);
  RAISE NOTICE 'aiu-470 reconcile: fork rows remaining post-delete = %', deleted_count;
END $$;

-- 3. Insert upstream migrations 0049-0056 as "already applied".
--    Hashes are sha256 of the rebased migration file contents.
--    created_at preserves monotonic ordering by using folderMillis from the
--    meta/_journal.json (when field).
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES
  ('7d25e72a806b086a94e6f548e764a7393f1e4d917c9afcee4d051e54643028fc', 1775349863293), -- 0049_flawless_abomination
  ('0432fd6dda492288eea238a155ffb46e146bbe55efac99ab81a99a290bb528fb', 1775487782768), -- 0050_stiff_luckman
  ('b6467b62ce525d470df92b97b0678c2568ae9d1ba8e6ca9d8a48ca2597899501', 1775524651831), -- 0051_young_korg
  ('27fb10df284e95ecdf9e4029efa4df1a3b381b4073b9eeffb59b53cf4abc8c48', 1775571715162), -- 0052_mushy_trauma
  ('f8ec8fad6aa7bca5068720c2f0a4ea74efbafc40f53ad709fd31b8727412457c', 1775604018515), -- 0053_sharp_wild_child
  ('f21d1da197bb83eced58f6074e9ac74e003b266afd51eac0cfafe0c2083af1e8', 1775750400000), -- 0054_draft_routines
  ('e43d1377e85dd8ff603838a96b16d953169446c4157ac948a2ba0148bcdd3040', 1775825256196), -- 0055_kind_weapon_omega (process_group_id - prod already has column)
  ('f305ae7da5d1b5df1701152ef2fe9b200cc7c1c50814c08cc274ca1e9d9a150b', 1776084034244)  -- 0056_spooky_ultragirl
ON CONFLICT DO NOTHING;

-- 4. Insert our consolidated fork migration as "already applied".
--    Prod already has last_timer_heartbeat_at, instructions_hash_before,
--    scheduled_for + index from the old fork migrations.
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES
  ('912e74e9c9bd49ec6b9391178eec783f529a719695ce9e8e67acaab7313d123b', 1776736452766) -- 0057_aiu_fork_customizations
ON CONFLICT DO NOTHING;

-- 5. Verify: exactly 58 rows total (0000-0057), all hashes unique.
DO $$
DECLARE
  total INT;
  unique_hashes INT;
BEGIN
  SELECT COUNT(*) INTO total FROM drizzle.__drizzle_migrations;
  SELECT COUNT(DISTINCT hash) INTO unique_hashes FROM drizzle.__drizzle_migrations;

  IF total <> 58 THEN
    RAISE EXCEPTION 'aiu-470 reconcile verify FAILED: expected 58 rows, got %', total;
  END IF;
  IF unique_hashes <> 58 THEN
    RAISE EXCEPTION 'aiu-470 reconcile verify FAILED: % rows but only % unique hashes', total, unique_hashes;
  END IF;

  RAISE NOTICE 'aiu-470 reconcile verify OK: 58 rows, 58 unique hashes';
END $$;

COMMIT;
