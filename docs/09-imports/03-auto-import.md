# Auto Import

With `autoImport`, a name that a file uses but doesn't declare is imported from the project file that exports it. There is no `use` to write for your own files:

```json
{
    "main": "index",
    "autoImport": true
}
```

```javascript
// models/user.slim
export struct User { name: string }

// index.slim
const user = User.new({ name: "Ada" })  // import { User } from "./models/user.js"
```

The `.slim` files under the folder named by `watch` in `slimconfig.json` (the project folder by default) are scanned, except the output folder, the packages folder and test files. Packages are always imported with `use`, and the files inside them get no auto-imports. A name used as a type is never imported when it is a built-in type (`int`, `string`, `bool`...).

- A component used as a tag in markup (`<Badge count=${n} />`) is imported like a name used in code.
- A local declaration or a `use` wins.
- A name that two files export is left alone; import it with `use`.
- A name that is also a browser or host global (`File`, `Comment`, `Notification`, `Event`, `document`...) is never imported: it keeps meaning the global, and the compiler warns that the project's export is shadowed. Import that one with `use`.
- A name used only as the operand of `typeof` is not imported, so `typeof Player != "undefined"` still tests whether that code is on the page.
- Imported signatures are checked like any `use`.

With `transform`, pass the index of exports yourself: `transform(code, file, { autoImport: projectExports("src") })`, with `projectExports` imported from `@slim-lang/core`. The [esbuild plugin](../15-build-and-runtime/07-esbuild.md) builds the index itself with `autoImport: true`. See [JavaScript API](../15-build-and-runtime/06-javascript-api.md).

## Custom element tags

A custom element registers its tag when its module runs. A tag used in markup or in `document.createElement("y-navbar")` imports the file that defines it, with `element("y-navbar") component ...`, `element component ...` or `customElements.define("y-navbar", ...)`, for its side effect only:

```javascript
// ui/navbar.slim
element("y-navbar") component Navbar() {
    return <nav>...</nav>
}

// pages/home.slim
component Home() {
    return <main><y-navbar></y-navbar></main>   // import "../ui/navbar.js"
}
```

Next: [Slim modules and the standard library](04-standard-library.md).
