-- The database role a worker of the execution pool connects as
-- (docs/server-deployment.md §11): the run queue, and of it only what a worker
-- reads and changes. Nothing else in the shared database -- sessions, Feishu
-- grants, schedules, unattended credentials -- is reachable from it, and not
-- what earlier runs produced either. The server's PostgreSQL authenticates a
-- local connection by the account's name (peer), so the role has the name of
-- the worker's system account.
--
-- Run as the database's superuser, after the coordinator has made the queue
-- (it does the first time it starts with IDOU_SCHEDULE_EXECUTION=pool):
--   sudo -u postgres psql -d idou -v ON_ERROR_STOP=1 -f deploy/server/worker-role.sql
-- Running it again changes nothing. A database made before the product was
-- renamed holds the queue as mydoubao_run_queue (database-names.js), and that
-- is the table granted there.
DO $$
DECLARE
  queue text := CASE WHEN to_regclass('mydoubao_run_queue') IS NOT NULL THEN 'mydoubao_run_queue' ELSE 'idou_run_queue' END;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'idou_worker') THEN
    CREATE ROLE idou_worker LOGIN;
  END IF;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM idou_worker;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM idou_worker;
  -- Taking a run, holding it, and handing back what it produced (run-queue.js
  -- attach, claim, renew, complete).
  EXECUTE format('GRANT SELECT (id, schedule, state, payload, cancel, created_at, worker) ON %I TO idou_worker', queue);
  EXECUTE format('GRANT UPDATE (state, worker, lease_until, updated_at, result) ON %I TO idou_worker', queue);
END $$;
