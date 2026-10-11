// Component creation: calls of a compiled component returning a DOM element (linkedom).
const PER_RUN = 50

export const setups = {
    async "runtime.component.create"(ctx) {
        const { module } = await ctx.load("component", ctx.fixture("component"))
        return {
            run: () => {
                let last
                for (let i = 0; i < PER_RUN; i++) last = module.Card({ title: "T" + i, tag: "new" })
                return last
            },
            verify: el => {
                const html = el.outerHTML
                if (!html.includes(`T${PER_RUN - 1}`) || !html.includes("card")) throw new Error(`unexpected markup: ${html}`)
            },
            counters: { components_per_sample: PER_RUN }
        }
    }
}
