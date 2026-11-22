import "/src/external/defaults.js";
const __tpl1__ = __template__([["tr", 0, ["td", 0, ""], ["td", 0, ["a", 0, ""]], ["td", 0, ["a", {
  "class": "remove"
}, ["span", 0, "x"]]]]]);
const __tpl2__ = __template__([["table", 0, ["tbody", 0, ""]]]);
try {
  const ADJECTIVES = ["pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint", "clean", "elegant", "easy", "angry", "crazy", "helpful", "mushy", "odd", "unsightly", "adorable", "important", "inexpensive", "cheap", "expensive", "fancy"];
  const COLOURS = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
  const NOUNS = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza", "mouse", "keyboard"];
  let nextId = 1;
  const pick = list => list[Math.round(Math.random() * 1000) % list.length];
  function build(count) {
    const rows = new Array(count);
    for (let i = 0; i < count; i++) {
      rows[i] = {
        id: nextId++,
        label: `${pick(ADJECTIVES)} ${pick(COLOURS)} ${pick(NOUNS)}`
      };
    }
    return rows;
  }
  const Bench = (() => {
    const Bench = () => __component__(() => {
      const __mounts__ = [];
      const __connects__ = [];
      const __unmounts__ = [];
      let __exposed__ = 0;
      const expose = api => __mounts__.splice(__exposed__++, 0, el => Object.defineProperties(el, Object.getOwnPropertyDescriptors(api)));
      const onMount = fn => __mounts__.push(fn);
      const onConnect = fn => __connects__.push(fn);
      const onUnmount = fn => __unmounts__.push(fn);
      const rows = __signal__([]);
      const selected = __signal__(0);
      window.slimBench = {
        run: () => {
          rows.v = build(1000);
        },
        runLots: () => {
          rows.v = build(10000);
        },
        add: () => {
          __mut__(rows, rows.v.push(...build(1000)));
        },
        update: () => {
          for (let i = 0; i < rows.v.length; i += 10) __mut_deep__(rows, __o__ => __o__.label += " !!!", rows.v[i]);
        },
        select: () => {
          selected.v = rows.v[5].id;
        },
        swap: () => {
          const a = rows.v[1];
          __mut__(rows, rows.v[1] = rows.v[998]);
          __mut__(rows, rows.v[998] = a);
        },
        remove: () => {
          __mut__(rows, rows.v.splice(3, 1));
        },
        clear: () => {
          rows.v = [];
        }
      };
      const __el__ = (() => {
        const __r__ = __tpl2__();
        const __n1__ = __child__(__r__, 0);
        const __n2__ = __child__(__n1__, 0);
        __list__(__n2__, () => rows.v, row => (() => {
          const __r__ = __tpl1__();
          const __n1__ = __child__(__r__, 0);
          const __n2__ = __child__(__n1__, 0);
          const __n3__ = __next__(__n1__, 1);
          const __n4__ = __child__(__n3__, 0);
          const __n5__ = __child__(__n4__, 0);
          __attr__(__r__, "class", () => __is__(selected, row.v.id, false) ? "danger" : "");
          __once__(__n2__, row.v.id);
          __on__(__n4__, "click", () => {
            selected.v = row.v.id;
          });
          __insert__(__n5__, () => row.v.label);
          return __r__;
        })(), row => row.id);
        return __r__;
      })();
      for (const fn of __mounts__) fn(__el__);
      __lifecycle__(__el__, __connects__, __unmounts__);
      return __el__;
    });
    Bench.__component__ = true;
    Bench.__module__ = import.meta.url;
    return Bench;
  })();
  document.getElementById("slim").append(Bench());
} catch (__err__) {
  __handle_sync_error__(__err__);
}