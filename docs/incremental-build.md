# Static check elimination and incremental builds

## Commands

```sh
slmc build --explain-checks --stats
slmc build --clean              # remove generated output/cache, then rebuild
slmc build --no-cache           # recompile without reading/writing the cache
slmc server --dev               # uses the same incremental compiler
node bench/incremental-build.mjs 5
```

`--explain-checks` prints source file, original line/column, kind, expected type,
`removed`/`kept`, and the proof or reason for retaining the check. Cached modules
retain their explanations. Positions use the same preprocessing origin map as
static diagnostics; a generated parameter check can point to its function's
header. `--stats` counts actual calls to `transform`, not just visited modules.
The compiler entry point also accepts `--stats-json` for automated measurements.

`--no-check` disables both static diagnostics and elimination. For differential
verification, `transform(source, file, { elide: false })` or `SLIM_NO_ELIDE=1`
retains runtime checks while still running static diagnostics. `SLIM_RELEASE`
keeps its existing runtime semantics and is part of the cache identity.

The existing `slmc check` command only checks project/configuration presence;
it is not a source type-checking command. Source diagnostics run during build,
run and the dev compiler.

## What the checker knows

Inspection of `checker.js` shows that its `infer` function recognizes literals,
annotated bindings, function signatures, arrays, object/function expressions,
known constructors, struct fields/inheritance, enum members, tuple/array indexing,
unary/binary operators and unions from conditional/logical expressions. It also
carries exported struct/enum/function information through Slim `use` imports.

This diagnostic inference is deliberately permissive and cannot authorize
elimination by itself:

- Unknown expressions, unannotated variables, JS imports, member calls such as
  `JSON.parse`, and `await` often yield no type. `any` and open custom types are
  accepted without proving the value's representation.
- Union compatibility allows overlap/narrowing; it does not guarantee that every
  union member satisfies the target.
- Numeric diagnostics permit int-to-float assignment, but the runtime distinguishes
  integer and noninteger numbers. Arithmetic can overflow to Infinity or produce
  NaN, and division can produce an integer.
- Array indexing may be out of bounds, and fields/objects can be mutable.
- A return annotation alone does not rule out falling through to `undefined`,
  reassignment of the callee, or an async/generator wrapper.

The existing diagnostic acceptance rules and error messages remain in place.
`proofs.js`, invoked by the checker after successful verification, uses a stricter
relation: every possible source type must pass the target runtime check.

| Expression/check | Proof used for elimination |
| --- | --- |
| Primitive literal, template | Its actual JS primitive representation |
| Comparison, `!`, `typeof` | Fixed result representation if evaluation completes |
| String concatenation | At least one operand is a proven string |
| Numeric arithmetic | Both operands are numeric; result is only proven `number` |
| Unary numeric `+`/`-` | Proven numeric operand |
| Conditional | Both branches proven; every member accepted by target |
| Annotated binding | Initialization/parameter guard establishes its type; all writes are instrumented |
| Local typed function call | Stable callee, synchronous nongenerator, conservative proof against fallthrough, checked returns |
| Local function parameter | Every reference is a direct call in this module; every argument proven; function never exported or used as a value |

Parameter defaults execute before body checks and cannot use parameter annotations
as evidence. Defaulted functions, reassigned parameters, spread calls and functions
with no visible calls keep parameter guards. Optional parameters include
`null | undefined` in their proof type. Bare fallthrough and imported callees are
not treated as return proofs.

Objects, arrays, custom types and mixed primitive/object unions keep their checks
and proxy behavior. JSON/JS/unannotated/`any` values stay checked on arrival.
Exported function parameters always stay checked. Compound assignments and
increments also retain guards. A declaration's check stays when later writes need
the runtime type slot it registers. `var`, redeclarations and uninstrumented writes
cannot establish a binding proof. Direct `eval` disables elimination in its module.

Custom type definitions can override built-in names and have observable side
effects. A module with such definitions (including imported definitions) keeps
checks. The project compiler additionally detects primitive redefinitions anywhere
in the reachable Slim graph and disables elimination throughout that graph, since
the runtime type registry is shared even between sibling modules.

## Cache and dev mode

The output directory contains `.slim-build-cache.json`. The fingerprint covers the
compiler version/source, relevant code generation dependency versions, checking,
elimination, release, JSDoc/declarations, import style and configured paths.
Module keys cover source content and the sorted reachable `use` graph, including
resolved paths. This handles transitive dependencies and cycles independently of
DFS traversal order. A primitive redefinition also affects all module keys because
it changes the shared runtime type registry.

The graph is rediscovered on every build; source files are still read on a warm
build. Only changed modules and dependents are transformed. Unchanged JS and
`.d.ts` files retain their bytes and timestamps. Cached type summaries restore
cross-module diagnostics when only an importing module changes. Cached output is
hash-checked, and missing/corrupt output is rebuilt. The cache is atomically
replaced after successful compilation; failed builds do not publish partial cache
metadata.

Deleted source outputs are pruned, including on a dangling-use failure. Successful
builds remove unreachable outputs and obsolete declarations. Runtime files are
synchronized by content and obsolete runtime copies are removed. The dev watcher
invokes this same compiler/cache, starts watching before the first Ready message,
and can restart an application that already exited.

The closure-based key calculation favors simplicity/correctness over asymptotic
speed: very large dense graphs can require quadratic traversal. Warm builds avoid
loading Babel entirely. `--clean` removes generated output and the cache before
rebuilding; it refuses the project root and paths outside the project.

## Verification

`test/check-elision.test.mjs` covers proof decisions, JSON/JS/export boundaries,
custom primitive validators, eval/default arguments, redeclarations, source maps,
and differential execution with elimination on/off. Every compilable example is
executed both ways; the pre-existing syntax failure in `examples/use.slim` is
compared as a diagnostic instead. `test/incremental-build.test.mjs` covers counters,
transitive/cyclic invalidation, cached types, deletion, output repair, option/version
changes, deterministic output/explanations and a real dev watcher restart.

The benchmark copies all 15 `packages/slim` modules into a temporary project and
adds one driver module. Each cold sample clears generated output; each immediately
following warm sample reuses it. Wall time includes Node startup and output sync,
and does not imply a cold operating-system file cache. The repository's package
sources are never modified. Measurements and full-suite results are recorded in
the task completion report.
