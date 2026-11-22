# Markup

Components return markup written directly in the code, similar to JSX. This page lists the rules it follows.

## Escaping

Values interpolated with `${...}` are escaped, so data from users can't inject HTML:

```js
component Comment(props) {
    return <p class="comment">${props.text}</p>
}

log(Comment({ text: "<b>hi</b>" }).outerHTML) // <p class="comment">&lt;b&gt;hi&lt;/b&gt;</p>
```

Markup is never escaped: tags written in the body or inside an interpolation (like `items.map(item => <li>...</li>)`) stay elements. HTML that arrives as a string and is already trusted goes through `raw()`:

```js
component List(props) {
    const title = props.title ? <h2>${props.title}</h2> : ""
    return <section>
        ${title}
        <ul>${props.items.map(item => <li>${item}</li>)}</ul>
        <div>${raw(props.trustedHtml)}</div>
    </section>
}

log(List({ title: "T", items: ["a", "b"], trustedHtml: "<b>x</b>" }).outerHTML)
// <section><h2>T</h2><ul><li>a</li><li>b</li></ul><div><b>x</b></div></section>
```

Joining markup with `+` or `.join("")` turns it into a plain string, which the next level escapes. Put the list itself into `${...}`, or join it with `raw.join(list, separator)`, which keeps the markup and escapes plain strings. `raw([...])` takes an array of trusted strings and markup.

```js
func item(text) {
    return <a>${text}</a>
}

const links = raw.join(["Home", "About"].map(item), " | ")
```

Markup outside components is a safe HTML value. To put it into an element, with the components and handlers inside it working, use `setHtml(el, markup)` rather than `innerHTML`.

When a binding gives `raw()` the same string again, the nodes already on the page stay, so nothing blinks and changes made to them survive. `raw(html, { fresh: true })` builds them again every time the binding runs, for HTML whose CSS animation should play again. See [Raw HTML in rows](../10-reactivity/03-conditions-and-lists.md#raw-html-in-rows) for lists.

## Attributes

- Unquoted attribute values are quoted automatically: `<div title=${text}>`.
- Attributes follow their values. `disabled=${off}` is present or absent, `data-` and `aria-` attributes, `draggable`, `spellcheck` and `contenteditable` get `"true"`/`"false"`, and `checked` and `selected` also set the element property. On `<input>`, `<textarea>` and `<select>`, `value` sets only the property, so what is typed into a password field never shows up in the markup.
- `class=${...}` adds and removes only the classes it gave: a class added from elsewhere with `classList.add` stays.
- An object, array or function given to a custom element (`<user-card user=${user}>`) goes to its props; see [Custom elements](02-custom-elements.md#props).
- `<input ${attrs}>` takes a string or an object of attributes.
- Events are written in camel case: `onClick=${fn}`. `onclick=${fn}` is a compile error, because the lowercase attribute would turn the function into text.
- A handler is bound to its element, so a `stopPropagation` higher up doesn't stop it, and events that don't bubble (`onError`, `onLoad`, `onFocus`, `onScroll`) work, in markup outside components too.
- Modifiers follow the event name: `onClick:capture=${fn}`, `onTouchstart:passive=${fn}`, `onClick:once=${fn}`, or several at once (`onScroll:passive:once`).
- A name with `:` must start with `bind:`, `xlink:`, `xml:` or `xmlns:`; anything else, like `class:active`, is a compile error instead of a silent attribute.
- Write `class` and `for`; `className` and `htmlFor` are reported.
- Markup inside `<svg>` is built in the SVG namespace.

The checker knows the events and attributes of HTML elements, and suggests a fix for a typo:

```js
component Home() {
    return <a herf="/">Home</a>   // ❌ unknown attribute "herf" on <a> — did you mean "href"?
}

component Save({ save }) {
    return <button onClik=${save}>Save</button>  // ❌ unknown event "onClik" — did you mean "onClick"?
}
```

Only names close to a known one are reported: `data-`, `aria-`, custom element and SVG attributes, and custom events like `onMyEvent` pass.

## Fragments

`<>...</>` groups several elements without a wrapper element, wherever markup goes: after `return`, in a variable, or in a branch of a condition.

```js
component Term({ word, meaning }) {
    return <><dt>${word}</dt><dd>${meaning}</dd></>
}

component Glossary(props) {
    return <dl>${props.open ? <><Term word="a" meaning="b" /><Term word="c" meaning="d" /></> : ""}</dl>
}
```

Markup kept in a variable before it is returned is the same markup: its bindings update by themselves, and the component returns the element itself.

## Text

Text follows JSX: a line break with the indentation around it goes, lines of text are joined with a space, and text on one line keeps its spaces. `<pre>`, `<textarea>`, `<script>` and `<style>` keep everything.

```js
component Note() {
    return <p>
        Hello
        world
    </p>
}

log(Note().outerHTML) // <p>Hello world</p>
```

## Components as tags

A capital letter makes a tag a component (`<Card>`, `<ui.Card>`), and the markup inside it is passed as `children`, built when the component first reads it. This works in component markup. Markup outside components builds an HTML string (a safe HTML value), where `<Card>` is just a tag. A tag with no component behind it (`<Helo />`) is a compile error.

## Dynamic tags

`<${tag}>...</${tag}>` picks the tag when the markup runs. A string makes an element, a component makes that component, and in component markup the element is rebuilt when the tag changes:

```js
component Heading({ level, children }) {
    const tag = "h" + level
    return <${tag} class="heading">${children}</${tag}>
}

component Tabs({ tab }) {
    const views = { feed: Feed, profile: Profile }
    return <${views[tab]} />
}
```

## Conditions and lists

`cond ? <A/> : <B/>`, `cond && <A/>` and `items.map(item => <li>...</li>)` render conditional content and lists. With [state](../10-reactivity/01-state.md) they update in place; see [Conditions and lists](../10-reactivity/03-conditions-and-lists.md).

Next: [Imports](../09-imports/01-use-imports.md).
