# Enums With Data

A member of an enum can carry values. Each member is then a constructor that checks its fields, and [`match`](../06-operators/06-match.md) takes the values apart by position:

```js
enum Shape {
    Circle(radius: float)
    Rect(width: float, height: float)
    Empty
}

func area(shape: Shape) -> float {
    return match (shape) {
        Shape.Circle(r) => 3.14 * r * r,
        Shape.Rect(w, h) => w * h,
        Shape.Empty => 0.0
    }
}

log(area(Shape.Rect(2.0, 3.0)))   // 6
Shape.Circle("big")               // ❌ argument "radius" of "Shape.Circle" expects float, got string
```

A `match` over such an enum has to handle every member, the arguments of a pattern have to fit the member's fields, and nested patterns (`Shape.Circle(0.0) => "dot"`) work like any other.

Data enums can be generic:

```js
enum Tree<T> {
    Leaf(value: T)
    Node(left: Tree<T>, right: Tree<T>)
}

func sum(tree: Tree<int>) -> int {
    return match (tree) {
        Tree.Leaf(v) => v,
        Tree.Node(l, r) => sum(l) + sum(r)
    }
}

log(sum(Tree.Node(Tree.Leaf(1), Tree.Leaf(2)))) // 3
```

## Printing and JSON

A value prints as `Shape.Rect(2, 3)` and `JSON.stringify` gives `{"$tag":"Rect","width":2,"height":3}`. `Shape.fromJSON(data)` turns that back into a value, nested members included, and throws `EnumError` for an unknown `$tag`:

```js
enum Shape {
    Circle(radius: float)
    Rect(width: float, height: float)
    Empty
}

const json = JSON.stringify(Shape.Rect(2.0, 3.0))
log(json)                                 // {"$tag":"Rect","width":2,"height":3}
log(String(Shape.fromJSON(JSON.parse(json)))) // Shape.Rect(2, 3)
```

## Reading fields

Fields are readable by name once the member is known. A check of `$tag` narrows the value, and a field that every member has can be read right away:

```js
enum Shape {
    Circle(radius: float)
    Rect(width: float, height: float)
}

func size(shape: Shape) -> float {
    log(shape.radius)                          // ❌ "Shape.Rect" has no field "radius" — narrow it to "Shape.Circle" first
    if (shape.$tag == "Circle") return shape.radius
    return 0.0
}
```

## Methods and traits

An enum can have methods, written after its members, and implement [traits](../07-structures/04-traits.md). `this` is the member the method is called on:

```js
trait Describe {
    describe() -> string
}

enum Shape implements Describe {
    Circle(radius: float)
    Empty

    area() -> float {
        return match (this) {
            Shape.Circle(r) => 3.14 * r * r,
            Shape.Empty => 0.0
        }
    }
    describe() -> string { return `${this.$tag}` }
}

log(Shape.Circle(1.0).area())   // 3.14
log(Shape.Empty.describe())     // Empty
```

An enum with methods or traits is a data enum, so its members can't have values (`Up: 1`).

In [release mode](../15-build-and-runtime/01-release-mode.md) the field checks of data enum members (`Shape.Circle("big")`) are left out.

Next: [Operators: `kindof`](../06-operators/01-kindof.md).
