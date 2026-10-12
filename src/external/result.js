// Portable, immutable variants. Payloads remain application-owned values.
export class Result {
    constructor(ok, payload) {
        this.ok = ok
        if (ok) this.value = payload
        else this.error = payload
        Object.freeze(this)
    }

    isOk() { return this.ok }
    isErr() { return !this.ok }
    unwrap() {
        if (!this.ok) throw new Error("Cannot unwrap Err", { cause: this.error })
        return this.value
    }
    unwrapOr(fallback) { return this.ok ? this.value : fallback }
    map(fn) { return this.ok ? Ok(fn(this.value)) : this }
    mapErr(fn) { return this.ok ? this : Err(fn(this.error)) }
    andThen(fn) { return this.ok ? __result_expect__(fn(this.value)) : this }
}

export function Ok(value) { return new Result(true, value) }
export function Err(error) { return new Result(false, error) }

export function __result_expect__(value) {
    if (!(value instanceof Result)) throw new TypeError("Result operator ? expects Ok(value) or Err(error)")
    return value
}
