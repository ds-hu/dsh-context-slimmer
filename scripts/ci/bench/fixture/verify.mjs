#!/usr/bin/env node
// Deterministic failing command used by the v0.2 benchmark.
// C3 expects the failure evidence: ERR_BENCH_42 and exit code 42.
process.stderr.write('ERR_BENCH_42: checksum mismatch\n');
process.stderr.write('detail: fixture/unique.txt:173 does not match the expected ORBITAL_CODE\n');
process.stderr.write('hint: rerun with --strict to see the segment table\n');
process.exit(42);
