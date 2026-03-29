-- cleanup-bots.sql
-- Removes demo/bot/seed users before launch.
--
-- Usage:
--   1. Run the DRY RUN block first — it only SELECTs, never deletes.
--      Inspect the output. If the list looks wrong, update the ALLOWLIST.
--   2. When confident, run the DELETE block (step 2).
--
-- ALLOWLIST: real users whose emails you want to keep no matter what.
--   Add every real tester/admin email here.
--   Pattern-based bots are deleted unless their email matches the allowlist.
--
-- Bot heuristics used:
--   • email LIKE '%@example.com'   — seeder default domain
--   • email LIKE '%@test.com'
--   • email LIKE '%bot%'
--   • email LIKE '%seed%'
--   • email LIKE '%demo%'
--   • email LIKE '%fake%'
--   • name  LIKE '%Bot%' OR name LIKE '%Test%' OR name LIKE '%Seed%'
--   • verified = FALSE AND created_at < NOW() - INTERVAL '7 days'
--     (unverified accounts older than 7 days — likely abandoned sign-ups)
--
-- You can tighten or loosen these heuristics as needed.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0 — define the allowlist
-- ─────────────────────────────────────────────────────────────────────────────
-- Replace the example values with the real emails you want to preserve.
-- This CTE is referenced by both the dry-run and the delete.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — DRY RUN (read-only — safe to run at any time)
-- ─────────────────────────────────────────────────────────────────────────────
WITH allowlist(email) AS (
  VALUES
    ('your-real-email@domain.com'),
    ('admin@campusconnect.app')
    -- add more real emails here, comma-separated
),
bot_candidates AS (
  SELECT
    u.id,
    u.email,
    u.name,
    u.verified,
    u.created_at,
    u.plan
  FROM users u
  WHERE
    -- not in the allowlist
    u.email NOT IN (SELECT email FROM allowlist)
    AND (
      -- synthetic domains
      u.email ILIKE '%@example.com'
      OR u.email ILIKE '%@test.com'
      OR u.email ILIKE '%@placeholder.com'
      -- suspicious keywords in email
      OR u.email ILIKE '%bot%'
      OR u.email ILIKE '%seed%'
      OR u.email ILIKE '%demo%'
      OR u.email ILIKE '%fake%'
      -- suspicious keywords in display name
      OR u.name  ILIKE '%bot%'
      OR u.name  ILIKE '%test%'
      OR u.name  ILIKE '%seed%'
      -- stale unverified accounts (>7 days old)
      OR (u.verified = FALSE AND u.created_at < NOW() - INTERVAL '7 days')
    )
)
SELECT
  id,
  email,
  name,
  verified,
  plan,
  created_at,
  'WILL BE DELETED' AS action
FROM bot_candidates
ORDER BY created_at DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — DELETE (comment out STEP 1 and uncomment this when ready)
-- ─────────────────────────────────────────────────────────────────────────────
-- WARNING: This is irreversible. Take a database backup first.
--   pg_dump $DATABASE_URL > backup-before-cleanup.sql
--
-- BEGIN;
--
-- WITH allowlist(email) AS (
--   VALUES
--     ('your-real-email@domain.com'),
--     ('admin@campusconnect.app')
-- ),
-- bot_ids AS (
--   SELECT id FROM users
--   WHERE
--     email NOT IN (SELECT email FROM allowlist)
--     AND (
--       email ILIKE '%@example.com'
--       OR email ILIKE '%@test.com'
--       OR email ILIKE '%@placeholder.com'
--       OR email ILIKE '%bot%'
--       OR email ILIKE '%seed%'
--       OR email ILIKE '%demo%'
--       OR email ILIKE '%fake%'
--       OR name  ILIKE '%bot%'
--       OR name  ILIKE '%test%'
--       OR name  ILIKE '%seed%'
--       OR (verified = FALSE AND created_at < NOW() - INTERVAL '7 days')
--     )
-- )
-- DELETE FROM users WHERE id IN (SELECT id FROM bot_ids);
--
-- -- Verify the count before committing:
-- -- SELECT COUNT(*) FROM users;
--
-- COMMIT;
-- -- or ROLLBACK; if anything looks wrong
