# Slim Package Manager

`spm` installs, locks and publishes Slim packages. It is a separate npm package, so the compiler doesn't carry its dependencies:

```bash
npm i -g @slim-lang/spm
```

A package is Slim source in a GitHub repository. `spm i <name>` puts it in your project's packages folder (`packages`, or the folder `names.packages` in `slimconfig.json` names), records the exact commit in `spm.lock.json`, and `use ... from @name` finds it:

```bash
spm i std
```

```js
use { even } from @std/types/numerical
```

`@slim/...` is not a package: those are the [modules of Slim itself](../09-imports/04-standard-library.md).

## How the pieces fit together

Four parts take part in getting a package into your program, and each does one job:

| Part | What it does |
|---|---|
| `@slim-lang/core` (`slmc`) | Compiles `use ... from @name/path` to the file in your packages folder. It never downloads packages and doesn't talk to the registry |
| `@slim-lang/spm` (`spm`) | Downloads packages into the packages folder, keeps `spm.lock.json`, publishes packages |
| The registry, `https://spm.yurba.one` | Knows which GitHub repository a package name stands for, its latest version and who published it. It doesn't store any code |
| GitHub | Holds the source of every package, each in its author's own repository |

What happens on `spm i std`:

1. `spm` asks the registry what `std` is and gets back its repository, `spm-libs/std`.
2. `spm` downloads that repository from GitHub into `packages/std` and records the exact commit in `spm.lock.json`.
3. `slmc` compiles `use { even } from @std/types/numerical` against `packages/std/types/numerical.slim`, like any other source file.

So a project with its packages folder in place builds without `spm` and without a network; `spm` is only needed to fetch or update packages.

Publishing goes the other way: `spm publish` pushes your package to your own GitHub repository (a user's or an organization's, whichever you name) and then registers the name in the registry. The registry checks with GitHub that you have access to that repository; updating a package needs the same access, and removing it needs it too, or, when the repository no longer exists, being the one who published it.

Every command, the lockfile and publishing your own packages are described in the [documentation of `@slim-lang/spm`](https://github.com/cdmtn/slim-spm#readme).

Next: [Configuration](03-configuration.md).
