# Legacy hosted-cron SQL fixtures

This directory is **test input only**. Its SQL files preserve the retired
pre-0007 hosted PostgreSQL cron programs so the disposable migration suite can
reproduce and verify the historical upgrade boundary.

These files are outside every production migration and operator path. **Do not
run them against a real, shared, staging, or production database.** They are not
deployment operations and must never be copied back into an executable project
directory.
