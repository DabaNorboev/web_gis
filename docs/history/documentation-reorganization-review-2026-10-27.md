---
status: history
updated: 2026-10-27
verified: run 2026-10-27
---

# Доводка организации документации — 27.10.2026

Это отчёт только о документации и её проверяющем инструменте. Приложение, его тесты, БД, runtime и новые Codex-сессии не запускались. HEAD остаётся `0f30b60`; commit/staging в этом задании не выполнялись. Существующие 62 staged-переименования оставлены как были. Интерфейсный план и эксперимент защищены от изменений; их ошибки здесь не скрываются.

## Что изменено

- Сохранён расчёт лимита по UTF-8 байтам: `len(text.encode('utf-8'))`; до доводки он уже был байтовым. Добавлен регрессионный пример с кириллицей на 40 959, 40 960 и 40 961 байт.
- В roadmap и [D08](../decisions.md#d08-снятие-исключения-плана-интерфейса) условие снятия исключения привязано к current/G2. По строкам 3 и 5 защищённого плана G2 уже выполнен, поэтому CLI/API обход удалён. План не редактировался.
- Ссылки на ignored data/reports в features/plans/data дают WARN; в исторических материалах — INFO. Проверки шапок и ссылок сохранены; history/archive теперь отклоняют статус current.
- Повторы принятых вводных заменены ссылками на decisions в constraints, roadmap и историческом current-state. Исторический контекст оставлен кратким, без нового пересказа решения.
- В [testing](../testing.md#размер-контекста-без-запуска-сессий) добавлена исполняемая команда размеров и отдельная короткая процедура будущего сравнения usage на двух коммитах. Новый постоянный скрипт для разового измерения не создавался.

## Результаты проверок

`python3 -B -m unittest discover -s tests/docs -v`: 14 tests passed. Проверяются байтовая граница, уровни ссылок на локальные отчёты, отсутствие CLI-исключения, шапки и индекс, обычные ссылки/якоря и сохранение защиты исторических документов. Это только тесты документационного инструмента.

`scripts/check-docs` запускался **без --exclude**, exit code 1: 86 документов, 5 ошибок, 1 предупреждение, 3 INFO. Все ошибки и предупреждение относятся к защищённому `docs/interface-v2-plan.md`:

- отсутствует машинная шапка;
- три старых цели: `point-analysis.md`, `project-vision.md`, `trips.md#единое-пространство-на-главной`;
- документ не достижим из основного индекса;
- размер выше мягкого корневого порога 40 KiB.

Эти пункты **остались**: исправление плана запрещено текущим заданием. Проверка не объявляется успешной и не обходится новым исключением. Удалённый флаг проверяется отдельным тестом: argparse отклоняет его.

`git diff --check` и `git diff --cached --check`: успешно. Индекс сравнен с начальным patch и не изменён. Контрольные суммы всех 476 защищённых файлов, включая план интерфейса, совпали с началом задания.

Полный вывод checker:

```text
ERROR: docs/interface-v2-plan.md: missing front matter
ERROR: docs/interface-v2-plan.md: missing local target point-analysis.md
ERROR: docs/interface-v2-plan.md: missing local target project-vision.md
ERROR: docs/interface-v2-plan.md: missing local target trips.md#единое-пространство-на-главной
ERROR: docs/interface-v2-plan.md: not reachable from docs/README.md
WARN: docs/interface-v2-plan.md: larger than 40 KiB
INFO: docs/archive/laravel-skeleton-changelog.md: historical reference outside checkout (not checked)
INFO: docs/history/map-visual-interaction-2026-10-23.md: local generated evidence/input (not checked)
INFO: experiments/ors-routing-poc/REPORT.md: local generated evidence/input (not checked)
Documentation: 86 files, 5 errors, 1 warnings, 3 informational notes
```

### 4a. Архив не в игноре

`git check-ignore -v docs/archive/*`: stdout/stderr пустые, exit code 1 означает отсутствие совпадений. Проверены четыре объекта: README, Laravel changelog, архив PROJECT, каталог Stage. Изменение .gitignore не требуется и не предлагалось.

### 4b. Старые пути вне docs

Список 62 переименований взят из строк `R` текущего `git status --short`. По их старым именам выполнен поиск через rg вне data/vendor/node_modules/docs; отдельно включены скрытые конфиги с исключением .git.

Найдено семь совпадающих строк. Шесть используют уже новые пути в README, AGENTS и двух experiments README; это совпадения имени файла, а не устаревшие ссылки. Реальная устаревшая запись одна: `.gitattributes:10`, `CHANGELOG.md export-ignore`. Это конфигурация вне разрешённых правок: **осталось**, не менялось. В комментариях кода и тестах приложения устаревшие ссылки не найдены. Править документационные ссылки вне защищённого плана не потребовалось.

### 4c. Дубли решений

По заданному точному шаблону rg вне decisions совпадений не осталось (exit code 1, 0 строк). Изменены две строки календарных вводных в constraints, ячейка E8 в roadmap и два пересказа в историческом current-state. Вместо копий — ссылки D01–D05; неизвестные сведения и исторический статус снимка не переобъявлялись.

### 4d. Шапки и текущие документы

Шапки независимо проверены во всех тематических папках: features — 16, data — 7, plans — 6, research — 11, history — 31, archive — 4. Во всех есть status/updated/verified; history/archive имеют только history или superseded. Дефектов в этих папках не найдено. Корневой защищённый план без шапки перечислен отдельно выше.

Поиск `status: current` возвращает 34 файла: 30 действующих контрактов/runbooks/основных документов и четыре навигационных индекса. В history/archive/research таких файлов нет; действующие плановые документы имеют plan/hypothesis, а plans/README — текущий навигационный индекс.

### 4e. Точечные расхождения

Проверялся текст документов; это не новая runtime-приёмка.

| Пункт | Результат | Основное место и строка |
|---|---|---|
| L01–L20, число записей | Исправлено: 20 записей, L20 явно исторический выполненный пункт | [constraints](../plans/project-constraints.md), строка 9 |
| Walking в основной части продукта | Исправлено: оба режима в сценарии и таблице | [product](../product.md), строки 24 и 37 |
| Walking в гипотезах | Исправлено: старый No-Go отделён от последующего ORS street | [hypotheses](../plans/product-hypotheses.md), строка 48 |
| L07 и отложенный E1 | Исправлено: ссылка на D06, без обязательных новых сессий | [constraints](../plans/project-constraints.md), строка 23 |
| Прежняя рекомендация об аудитории | Исправлено: superseded и ссылка D01 о замене рекомендации | [opportunities](../research/product-opportunities.md), строки 2 и 11 |

## Размеры и оставшиеся сообщения

В features/ и plans/ **нет файлов выше 40 960 байт**. Порог не повышался, исключений по размеру не добавлялось. Существующих Markdown-ссылок на ignored data/reports в features/plans/data не найдено; их тексты из-за этой проверки не менялись. Есть 34 буквальных упоминания путей в кодовых примерах и командах: они не являются Markdown-ссылками, checker не удостоверяет наличие этих входов.

Одно предупреждение остаётся у корневого защищённого плана: 160 106 байт UTF-8. Три INFO — прежняя внешняя ссылка в архивном Laravel changelog, локальные скриншоты исторического map-visual-interaction и локальный ORS отчёт, упомянутый experiments/ors-routing-poc/REPORT. Содержимое локальных свидетельств не читалось.

### Измерение контекста

Команда из testing выполнена локально, без Codex-сессий; результат — размеры файлов, не токены и не стоимость. Все прямые Markdown-ссылки AGENTS — кандидаты чтения по задаче, не обязательный пакет.

```text
file	UTF-8 bytes	characters
AGENTS.md	12292	7170
docs/README.md	9795	5985
docs/architecture.md	11313	7237
docs/changelog.md	2148	1416
docs/data-schema.md	14413	9306
docs/features/area-analysis.md	12583	7715
docs/features/coverage.md	13607	8788
docs/features/trips.md	23042	13912
docs/frontend-structure.md	23609	14991
docs/product.md	9387	5388
docs/runbook-local.md	7262	5019
docs/testing.md	32233	21349
Typical set: AGENTS.md + docs/README.md + docs/features/trips.md
TOTAL	45129	27067
```

Сам будущий замер usage описан в [testing](../testing.md#будущий-замер-реальных-токенов); он в этом задании не выполнялся.

## Будущие коммиты: план, команды не выполнялись

### 1. Только перемещения

Предложенное сообщение: `docs: organize documentation by purpose`.

Все 62 чистых tracked-переименования уже находятся в индексе с исходными blobs: numstat даёт 0 добавлений/удалений. Для первого коммита **git add не нужен и не должен выполняться**: добавление текущих версий перенесённых файлов захватит правки текста. Это точный план для существующего индекса, а не универсальная команда пересоздания индекса. Обычным git add заново получить «только переименования» из этих смешанных файлов нельзя без дополнительной работы с индексом. Она в этом задании запрещена и не выполнялась.

Перед будущим первым коммитом только проверить:

```bash
git diff --cached --check
git diff --cached --numstat
git diff --cached --summary
```

Первый коммит только структурный: исправления внутренних ссылок появятся следующим шагом, успешная проверка промежуточного дерева не заявляется.

Архив PROJECT не входит в этот шаг: исходник был ignored, поэтому Git не имеет его исходного blob для tracked-переименования.

### 2. Содержательная документация и AGENTS

Предложенное сообщение: `docs: clarify contracts and decision ownership`. Следующие команды предназначены **только для состояния после отдельного первого коммита**.

Целые файлы без смешения с интерфейсом или документацией checker:

```bash
git add -- \
  README.md \
  docs/architecture.md \
  docs/archive/README.md \
  docs/archive/laravel-skeleton-changelog.md \
  docs/archive/project-spec-2026-10.md \
  docs/archive/stages-0-22.md \
  docs/data-schema.md \
  docs/data/README.md \
  docs/data/local-routing.md \
  docs/data/osm-addresses.md \
  docs/data/osm-areas.md \
  docs/data/osm-buildings.md \
  docs/data/osm-linear.md \
  docs/data/transport-import.md \
  docs/features/README.md \
  docs/features/address-search.md \
  docs/features/area-analysis.md \
  docs/features/car-street-choice.md \
  docs/features/coverage.md \
  docs/features/local-routing-diagnostics-contract.md \
  docs/features/map-area-layers.md \
  docs/features/map-linear-layers.md \
  docs/features/map-stops-layer.md \
  docs/features/point-address.md \
  docs/features/trip-privacy.md \
  docs/features/walking-backend.md \
  docs/history/comparison-layout-2026-10-22.md \
  docs/history/comparison-layout-2026-10-24.md \
  docs/history/comparison-link-r3-2026-10-25.md \
  docs/history/comparison-map-accessibility-2026-10-22.md \
  docs/history/comparison-personal-trips-2026-10-24.md \
  docs/history/comparison-transfer-2026-10-22.md \
  docs/history/comparison-workspace-2026-10-23.md \
  docs/history/current-state-2026-10-26.md \
  docs/history/frontend-loader-r1-2026-10-25.md \
  docs/history/local-routing-action-notice-2026-10-21.md \
  docs/history/local-routing-candidate-choice-2026-10-21.md \
  docs/history/local-routing-clicks-2026-10-23.md \
  docs/history/local-routing-decision-2026-10-21.md \
  docs/history/local-routing-failure-messages-2026-10-21.md \
  docs/history/local-routing-integration-2026-10-21.md \
  docs/history/local-routing-mobile-summary-2026-10-22.md \
  docs/history/local-routing-privacy-access-fixes-2026-10-21.md \
  docs/history/local-routing-snap-2026-10-21.md \
  docs/history/map-controls-ui-2026-10-20.md \
  docs/history/map-layers-final-check-2026-10-20.md \
  docs/history/map-object-context-2026-10-24.md \
  docs/history/map-visual-interaction-2026-10-23.md \
  docs/history/overview-interests-2026-10-24.md \
  docs/history/point-address-2026-10-23.md \
  docs/history/profile-map-workspace-2026-10-23.md \
  docs/history/profile-sidebar-2026-10-23.md \
  docs/history/trip-overlay-r4-2026-10-25.md \
  docs/history/trips-scenario-2026-10-24.md \
  docs/history/trips-state-r2-2026-10-25.md \
  docs/plans/README.md \
  docs/plans/product-hypotheses.md \
  docs/plans/project-constraints.md \
  docs/plans/project-vision.md \
  docs/plans/user-check-plan.md \
  docs/product.md \
  docs/research/README.md \
  docs/research/criteria-research-audit.md \
  docs/research/git-history-organization-plan.md \
  docs/research/grocery-poc.md \
  docs/research/local-routing-audit.md \
  docs/research/poi-coverage-audit.md \
  docs/research/product-criteria-review.md \
  docs/research/product-opportunities.md \
  docs/research/refactoring-r1-r4-independent-audit.md \
  docs/research/structure-quality-audit.md \
  docs/research/ui-ux-review.md \
  docs/runbook-local.md \
  experiments/local-routing-poc/README.md \
  experiments/ors-routing-poc/REPORT.md \
  experiments/routing-clicks/README.md
```

Новые смешанные файлы сначала обозначить intent-to-add, затем выбрать только содержательные части документации:

```bash
git add -N -- \
  docs/changelog.md \
  docs/decisions.md \
  docs/history/README.md
git add -p -- \
  AGENTS.md \
  docs/README.md \
  docs/browser-smoke.md \
  docs/changelog.md \
  docs/decisions.md \
  docs/features/address-comparison.md \
  docs/features/address-profile.md \
  docs/features/point-analysis.md \
  docs/features/trips.md \
  docs/frontend-structure.md \
  docs/history/README.md \
  docs/plans/roadmap.md \
  docs/testing.md
```

В интерактивных hunks оставить на третий коммит код/описание checker, байтовые лимиты, сообщения INFO/WARN, снятие --exclude, процедуру измерения и ссылку на этот отчёт. Существующие интерфейсные правки семи документов ниже не включать ни в один из этих трёх коммитов. Если hunk совмещает перенос ссылки с интерфейсным текстом, нужен ручной `e`/разделение; один обычный git add файла здесь небезопасен. До фиксации проверить staged diff.

### 3. Проверяющий скрипт, регрессии и их документация

Предложенное сообщение: `test: validate documentation boundaries and context sizes`. Только после второго коммита:

```bash
git add -- \
  scripts/check-docs \
  tests/docs/test_check_docs.py \
  docs/history/documentation-reorganization-review-2026-10-27.md
git add -p -- \
  AGENTS.md \
  docs/README.md \
  docs/testing.md \
  docs/plans/roadmap.md \
  docs/decisions.md \
  docs/changelog.md \
  docs/history/README.md
```

Выбрать только оставленные checker-hunks; в docs/testing.md особенно не захватить оставшийся интерфейсный текст. Затем повторить только tests/docs, scripts/check-docs и diff --check. Полный checker обязан показать нерешённые ошибки защищённого плана, пока нет отдельного разрешённого исправления.

### Где разделение требует ручного выбора

Смешение документационной реорганизации и checker: `AGENTS.md`, `docs/README.md`, `docs/testing.md`, `docs/plans/roadmap.md`, `docs/decisions.md`, `docs/changelog.md`, `docs/history/README.md`.

Существующий интерфейсный WIP вместе с переносом ссылок/шапками: `docs/features/address-comparison.md`, `docs/features/address-profile.md`, `docs/browser-smoke.md`, `docs/frontend-structure.md`, `docs/features/point-analysis.md`, `docs/testing.md`, `docs/features/trips.md`.

Автоматически разделить все три коммита командами добавления целых файлов нельзя. Команды `git add -p` выше являются точными точками ручного выбора, а не обещанием автоматического разделения. Приложение, его тесты, весь experiments/interface-v2 и interface-v2-plan не включать. Ни одна команда staging/commit из этого плана в доводке не выполнялась.
