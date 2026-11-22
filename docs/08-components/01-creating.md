# Creating Components

Slim has its own component system for building and interacting with the UI. A component is a function that returns markup and gives back a real DOM element. Slim compiles the markup into a template that is cloned per use, and each `${...}` into a binding that updates only its own text node or attribute: there is no virtual DOM. Let's look at a simple component:

__Component creation__
```js
component Wrapper() {
    return <div class="wrapper"></div>
}

log(Wrapper().outerHTML) // <div class="wrapper"></div>
```

Where:
- `component` - keyword
- `Wrapper` - name of the component
- `return ...` - the markup the component renders

The component body must contain a `return`; a component without one is a compile error (`Component "Wrapper" must contain return`). Code after the `return` never runs, so it is a compile error too; a function declared after the `return` is still available above it.

## Component arguments

Components receive their data in one argument, the props object. Props can carry any value, including other components and elements:

__Example__
```js
component Avatar(props) {
    return <img src=${props.avatarURL}>
}

log(Avatar({ avatarURL: "/a.png" }).outerHTML) // <img src="/a.png">
```

You can also use destructuring to get the values right away. A default is evaluated once per component instance, when it is first read, so `items = []` doesn't create a new array on every update:

__Example__
```js
component Avatar({ avatarURL, size = 32 }) {
    return <img src=${avatarURL} width=${size}>
}

log(Avatar({ avatarURL: "/a.png" }).outerHTML) // <img width="32" src="/a.png">
```

## Typing props

User data cannot be trusted, so you can validate props with a structure, with a typed destructuring pattern, or manually inside the body:

__Example: props checked by a structure__
```js
struct AvatarProps {
    avatarURL: string
}

component Avatar(props: AvatarProps) {
    return <img src=${props.avatarURL}>
}

Avatar(JSON.parse(`{ "avatarURL": 5 }`)) // ❌ TypeError: function "Avatar": argument<0> "props" expected AvatarProps, got object
```

__Example: typed destructuring__

A component call is checked against its props at compile time:

```js
component Badge({ count: int, label?: string }) {
    return <span>${count} ${label ?? ""}</span>
}

Badge({ count: 1 })           // ok
Badge({ cont: 1 })            // ❌ "Badge" has no prop "cont" — did you mean "count"?
Badge({ count: "1" })         // ❌ prop "count" of "Badge" expects int, got string
Badge({ label: "a" })         // ❌ "Badge" is missing prop "count" of type int
```

__Example: manual verification__
```js
component Avatar(props) {
    let avatarURL: string = props.avatarURL

    return <img src=${avatarURL}>
}
```

This also shows that you can run any code in the body of a component before the `return`, and process the data there.

## Using components as tags

A component is used as a tag, and the markup inside it arrives as `children`. `<Card title="x">` is `Card({ title: "x" })`, and both forms work:

```js
component Card({ title, children }) {
    return <section class="card">
        <h2>${title}</h2>
        ${children}
    </section>
}

component Page() {
    return <Card title="Settings">
        <p>Everything in one place.</p>
    </Card>
}

log(Page().outerHTML) // <section class="card"><h2>Settings</h2><p>Everything in one place.</p></section>
```

See [Markup](03-markup.md#components-as-tags) for how tags become components.

## Component isolation

The keyword `isolated` isolates a component from its surroundings: it runs in its own scope, so it can't use outside variables or functions. Everything it needs comes through props:

```js
let avatarURL = "https://example.com/a.png"

isolated component Avatar() {
    return <img src=${avatarURL}> // ❌ isolated component "Avatar" can't see "avatarURL": it runs in its own scope — move it inside the component or pass it as a prop
}
```

An isolated component can't hold state, and its markup is built from an HTML string rather than live bindings, so it doesn't update and doesn't use other components as tags. Its body is checked like any other code.

## Lifecycle

Inside a component:
- `onMount(fn)` runs `fn` with the element once it is built;
- `onConnect(fn)` runs it every time the element is added to the document;
- `onUnmount(fn)` runs it when the element is removed.

A component can hold [state](../10-reactivity/01-state.md) that updates its markup when it changes.

```js
component Clock() {
    state now = Date.now()
    onConnect(() => {
        const timer = setInterval(() => { now = Date.now() }, 1000)
        onUnmount(() => clearInterval(timer))
    })
    return <time>${new Date(now).toLocaleTimeString()}</time>
}
```

A component is removed when its element leaves the document and is still out of it once the current task ends. Moving it from one parent to another in the same task is not a removal. On removal, Slim runs `onUnmount` and disposes the component: its effects stop and its `onCleanup` callbacks run, so nothing it subscribed to keeps it alive. Hooks registered later, after an `await`, still count, and so do listeners added with `listen`.

A component that is taken out and put back later, like a tab that is hidden by detaching it, calls `keepAlive()`. It is then not disposed, and neither is anything inside it: the components and custom elements in its markup keep their state and are not built again. `onUnmount` runs on every removal, `onConnect` on every return, and `dispose(el)` ends it for good, with everything inside it. A kept component that is dropped without `dispose` holds nothing in the runtime: once nothing refers to its element, it is freed like any other object.

`expose(api)` puts methods on the element; it can be called in the body or inside `onMount`.

### Outside components

For DOM that no component owns:
- `onRemove(node, fn)` runs `fn` once `node` is removed. It returns a function that cancels it.
- `listen(target, event, fn, options)` adds a listener and returns what removes it. Inside a component, the listener is removed with the component, even when it is added after an `await` or in `onConnect`.
- `render(view, target)` puts a component or markup into `target`, replacing what an earlier `render` put there and disposing it. It returns a function that removes the view.

```js
const stop = render(() => App({}), document.querySelector("#app"))
```

Next: [Custom elements](02-custom-elements.md).
