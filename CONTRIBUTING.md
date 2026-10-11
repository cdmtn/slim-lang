# Contributing

Run `npm test` before sending a change.

## Performance rule

Every change that touches a hot path (type checks and guards, `transform`, the parser/lexer/checker, or the
runtime in `src/external/core.js`) must have a case in the benchmark harness (`bench/`, see
[docs/benchmark.md](docs/benchmark.md)) and attach a before/after table taken with
`npm run bench -- --filter <case> --save before` and `--compare before` on the same machine, with the same flags.
Add cases to the existing harness; do not create a separate measuring script. Say which numbers were measured
and which were estimated, and do not compare dev figures with release figures.
