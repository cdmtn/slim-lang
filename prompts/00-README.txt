Промпты для развития Slim. Каждый файл самодостаточен: его можно отдать агенту целиком. Папка bench/ содержит замер рантайма, на который ссылаются промпты о скорости.

Рекомендуемый порядок и зависимости:
01 compiled-type-predicates   основа скорости; 06, 10, 11, 13 используют её предикаты
02 type-fn-single-pass        независим, можно параллельно с 01
03 release-erasure            независим, но после 01 цифры сравнивать проще
04 guard-modes                после 01 (использует быстрые предикаты)
05 static-elision-incremental после 03 (общая часть transform)
06 diagnostics-and-validation после 01
07 language-server            после 06 (единый формат диагностик)
08 doc-bench-tooling          независим
09 pipe-result-try            независим; Result нужен промптам 10 и 12
10 match-patterns             после 01 и 09
11 struct-features            после 01
12 sum-type-enums             после 09, 10
13 reflection-schema-api      после 01 и 11

14 builtin-benchmark-harness  внутренний харнесс для самого Slim (по образцу zaxis); лучше сделать ПЕРВЫМ, чтобы все остальные задачи мерялись им; общий модуль статистики с 08

Замер до правок (Node, 100000 объектов, режим dev, ns на объект):
User.verify 1720; verifySafe 1748; User.new 1840; let x: int = i 597 (без аннотации 2); let o: User = d (Proxy) 5966; let a: int[] = [1,2,3] 2234; вызов функции с типами 1415 (без 2); type([1,2,3]) 181; рукописный предикат для той же struct 14.
В режиме --release: аннотации ≈ 0, но вызов типизированной функции 43 нс против 3, Proxy-присваивание 12 против 0, type() без изменений.
Запуск: slmc run в каталоге с package.json и slimconfig.json (main=index), файл prompts/bench/runtime-bench.slim скопировать в index.slim.
