# Forms

## Binding inputs

`bind:value` and `bind:checked` show a state or a field and write back what the user types. A number or range input writes a number. The value is set as the input's property only, never as its `value` attribute:

```js
component Signup() {
    state form = { name: "", age: 18, terms: false }
    return <form>
        <input bind:value=${form.name}>
        <input type="number" bind:value=${form.age}>
        <input type="checkbox" bind:checked=${form.terms}>
        <p>${form.name} (${form.age})</p>
    </form>
}
```

## createForm

`createForm` from `@slim/forms` builds a form from a struct. The struct's field types are the form's rules, the same ones its values are checked against everywhere else, on the server included. `email` and `positive` here come from the [standard library](../09-imports/04-standard-library.md):

```js
use { createForm } from @slim/forms
use { email } from @std/types/mails
use { positive } from @std/types/numerical

struct Signup {
    name: string
    email: email
    age: positive
    nick?: string
}

func save(data: Signup) {
    log("saving", data.name)
}

component SignupForm() {
    const form = createForm(Signup, { messages: { age: "Age must be above zero" } })
    return <form onSubmit=${form.submit(save)}>
        <input bind:value=${form.name}>
        <input bind:value=${form.email}>
        <p class="error">${form.errors.email}</p>
        <input bind:value=${form.age}>
        <p class="error">${form.errors.age}</p>
        <button disabled=${!form.valid || form.submitting}>Sign up</button>
    </form>
}
```

- `form.errors.email` reads `"expected email"` once the email field was changed. `messages` replaces the text for a field.
- `"30"` typed into the age input arrives as the number 30.
- A field's error shows once the field was changed or a submit was tried; an empty required field is `"required"`.
- `form.valid` tells whether all fields are valid.
- `form.submit(save)` calls `save` only with valid data, as a `Signup` built like `Signup.new`, and `form.submitting` is true while a promise it returns is pending.
- `form.reset()` starts over, `form.values` is what was typed.

The compiler knows a form has its struct's fields: `form.nmae` and `form.errors.nmae` get a did-you-mean.

## Rules, checks and server errors

The second argument also takes per-rule messages, rules per field and a rule for the whole form:

```js
struct Account {
    name: string
    password: string
    confirm: string
    invite?: string
    invited: bool
}

const form = createForm(Account, {
    messages: {
        name: { required: "Pick a name", short: "At least 3 letters" }
    },
    fields: {
        name: {
            validate: { short: name => name.length >= 3 },
            check: async name => (await api.nameTaken(name)) ? "This name is taken" : null,
            debounce: 300
        },
        invite: { when: values => values.invited, validate: code => code.length == 8 || "8 characters" }
    },
    validate: values => values.password != values.confirm ? { confirm: "Passwords differ" } : null
})
```

- `messages` per field is a string for every failure, or an object keyed by rule: `required`, the type's name (`email`, `positive`, or `type` for any) and the names of your rules.
- `validate` is a function, a list of functions or an object of named ones. Each gets the value and all values, and returns `null` or `true` when it passes, a message, or `false` for the message of its name.
- `check` is an async rule, for example a question to the server. It runs after the other rules pass, `debounce` milliseconds after the last change, and an answer for a value that has changed since is dropped. `form.checking` is true meanwhile; a submit waits for it.
- `when` skips a field while it returns false: it has no errors and is left out of the data, so make it optional in the struct.
- The form's `validate` returns errors by field, or a message for the whole form, which `form.formError` shows after a submit.
- `form.setErrors({ name: "Taken" })` shows errors from the server; a key that isn't a field, or a plain string, goes to `form.formError`. A field's server error goes away when the field changes, and `form.valid` is false while one is shown.

Next: [Loading data](05-loading-data.md).
