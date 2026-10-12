export default `S0006: enum match is not exhaustive

Handle every enum member, or add a _ fallback arm. Guarded matches are left
to runtime because the checker cannot prove which guards will succeed.`
