# Other Operators

There are also operators that are not standard JavaScript:

| Operator | Description | Example |
|----------|-------------|---------|
| `~/` | integer (truncating) division | `7 ~/ 2` → `3` |
| `or` | logical OR (lowers to `\|\|`) | `true or false` → `true` |
| `and` | logical AND (lowers to `&&`) | `true and false` → `false` |
| `\|>` | pipe: passes a value to a function | `[1, 2] \|> sum` → `sum([1, 2])` |
| `?` (postfix) | unwraps a `Result` or an `Option`, or returns its failure | `parsePort(raw)?` |
| `as T` | treats a value as `T` for the checker | `JSON.parse(raw) as int` |
| `!` (postfix) | treats a value as not `null` or `undefined` | `items.find(f)!` |

```js
log(7 ~/ 2)          // 3
log(-7 ~/ 2)         // -3
log(true or false)   // true
log(true and false)  // false
```

`/` always gives a `float`; use `~/` when you need an `int`. Dividing by zero with `~/ 0` is a compile error.

## Pipe operator

`value |> f` is `f(value)`, and `value |> f(a)` passes the value as the first argument, `f(value, a)`. Wrap anything else in parentheses:

```js
const isPaid = order => order.paid
const filter = (items, fn) => items.filter(fn)
const sumBy = (items, key) => items.reduce((sum, item) => sum + item[key], 0)

const orders = [{ amount: 10, paid: true }, { amount: 5, paid: false }]

const total = orders
    |> filter(isPaid)
    |> sumBy("amount")
    |> (sum => sum * 1.2)

log(total) // 12
```

The pipe has the lowest precedence of the binary operators, so `a || b |> f` is `f(a || b)`.

## Result unwrapping and type assertions

The postfix `?` is described in [Result and Option](../03-types/05-result-and-option.md), and `as` and `!` in [Type expressions](../03-types/03-type-expressions.md#type-assertions).

Next: [Structures](../07-structures/01-creating.md).
