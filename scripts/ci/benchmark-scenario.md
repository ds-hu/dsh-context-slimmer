# v0.2.0 benchmark scenario (single composite session)

You are running a deterministic benchmark. Follow the steps exactly, in order,
then stop. Every tool call must be exactly the one listed here: do not explore
the repository, do not read other files, do not retry a failing command, and do
not skip a step.

1. Use the read tool to read `scripts/ci/bench/fixture/unique.txt`.
2. Use the read tool to read `scripts/ci/bench/fixture/duplicate.txt`.
3. Use the bash tool to run exactly `node scripts/ci/bench/fixture/verify.mjs`.
   That command is expected to fail; record its error text and exit code, and do
   not retry it.
4. Use the bash tool to run exactly `node scripts/ci/bench/fixture/log.mjs`.
5. Use the bash tool to run exactly `node scripts/ci/bench/fixture/log.mjs` again.
6. Use the read tool to read `scripts/ci/bench/fixture/duplicate.txt` again.
7. Use the bash tool to run exactly `wc -l scripts/ci/bench/fixture/unique.txt`.
8. Use the bash tool to run exactly `wc -l scripts/ci/bench/fixture/duplicate.txt`.
9. Use the bash tool to run exactly `ls scripts/ci/bench/fixture`.
10. Use the bash tool to run exactly `git status --short`.
11. Use the bash tool to run exactly `pwd`.
12. Use the bash tool to run exactly `tail -1 scripts/ci/bench/fixture/unique.txt`.

After all twelve results are available, reply with exactly one JSON object and
nothing else (no markdown fence, no explanation). Use the values you found in
the tool results:

{"unique_code":"<ORBITAL_CODE value>","atlas_port":<atlas port number>,"failure":"<first error code>/exit <exit code>","maint_token":"<MAINTENANCE_TOKEN value>","backup_slot":"<BACKUP_SLOT value>"}

The fields must be copied exactly from the tool results (the unique code, the
port number, the error code and exit code, the maintenance token, and the backup
slot). Do not guess and do not read any other file.
