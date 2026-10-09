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
--
-- Its heartbeat (docs/service-status.md §1): its row in idou_run_worker_beats,
-- which the coordinator makes (run-queue.js) when it starts a release that has
-- it. Run this again after that; before, the table is not there and only the
-- queue is granted. The workers share this role, so one could change another's
-- row; none can read another's state.
--
-- On a server set up before the rename the role is mydoubao_worker; it is
-- granted there, and no idou_worker is made beside it.
DO $$
DECLARE
  queue text := CASE WHEN to_regclass('mydoubao_run_queue') IS NOT NULL THEN 'mydoubao_run_queue' ELSE 'idou_run_queue' END;
  beats text := CASE WHEN to_regclass('mydoubao_run_queue') IS NOT NULL THEN 'mydoubao_run_worker_beats' ELSE 'idou_run_worker_beats' END;
  who text := CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = 'mydoubao_worker') THEN 'mydoubao_worker' ELSE 'idou_worker' END;
BEGIN
  IF who = 'idou_worker' AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'idou_worker') THEN
    CREATE ROLE idou_worker LOGIN;
  END IF;
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', who);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', who);
  -- Taking a run, holding it, and handing back what it produced (run-queue.js
  -- attach, claim, renew, complete).
  EXECUTE format('GRANT SELECT (id, schedule, state, payload, cancel, created_at, worker) ON %I TO %I', queue, who);
  EXECUTE format('GRANT UPDATE (state, worker, lease_until, updated_at, result) ON %I TO %I', queue, who);
  -- Writing its row and refreshing its time and state (process-status.js
  -- WorkerHeartbeat); the coordinator removes rows a day old.
  IF to_regclass(beats) IS NOT NULL THEN
    EXECUTE format('GRANT SELECT (worker), INSERT, UPDATE (beat_at, state) ON %I TO %I', beats, who);
  END IF;
END $$;
