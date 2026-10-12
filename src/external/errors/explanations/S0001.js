export default `S0001: value does not match its declared type

Slim checks variables, arguments, return values and struct fields. Supply a
value of the expected type, or change the declaration to describe your data.

    struct User { age: int }
    User.verify({ age: "18" }) // expected int, got string
    User.verify({ age: 18 })   // valid

An empty [] has runtime type null[] and cannot infer string[] or int[].
Use Array<string> / Array<int> to accept an empty array, or supply elements.
An int has no fractional part; float and int are distinct runtime types.
Use number to accept both. A Role::Admin field requires Role.Admin itself;
its raw value is accepted by Role, but is not the same as the member.`
