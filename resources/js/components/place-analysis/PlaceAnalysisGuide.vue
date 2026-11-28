<script setup lang="ts">
import { CircleHelp } from '@lucide/vue'

defineProps<{ topic: 'air' | 'satellite' }>()
</script>

<template>
    <details class="pa-guide">
        <summary><CircleHelp :size="16" aria-hidden="true" /> Как это работает</summary>
        <div class="pa-guide__body">
            <template v-if="topic === 'air'">
                <h3>Как читать график воздуха</h3>
                <p>Выберите станцию на карте или в списке. График показывает её почасовые измерения. Точные значения есть в таблице «Часовые значения и пропуски».</p>
                <figure>
                    <div class="pa-guide__example" aria-hidden="true">
                        <div class="pa-guide__example-cell"><span class="pa-guide__bar"></span></div>
                        <div class="pa-guide__example-cell"><span class="pa-guide__bar is-zero"></span></div>
                        <div class="pa-guide__example-cell"><span class="pa-guide__missing"></span></div>
                        <span>Значение</span><span>Ноль</span><span>Пропуск</span>
                    </div>
                    <figcaption>Условный график. Столбец — измерение за час. Отметка на линии — измеренный ноль, разрыв — пропуск. В таблице указано, был ли час без записи или в записи не было значения.</figcaption>
                </figure>
                <p><strong>PM2,5</strong> — частицы до 2,5 мкм. <strong>PM₁₀</strong> — частицы до 10 мкм, включая более мелкие. Оба показателя измеряются в мкг/м³ — это масса частиц в кубометре воздуха.</p>
                <p><strong>Вместе</strong> показывает оба ряда за одни и те же часы на общей шкале.</p>
                <p><strong>Почему станция может быть только в списке?</strong> Для станции без известных координат график доступен из списка.</p>
            </template>
            <template v-else>
                <h3>Как читать снимок и NDVI</h3>
                <p>Выберите дату. «Снимок» покажет спутниковое изображение, а «NDVI» раскрасит его по индексу растительности. Расшифровка цветов выбранного слоя — в легенде карты.</p>
                <figure>
                    <div class="pa-guide__example" aria-hidden="true">
                        <div class="pa-guide__example-cell"><span class="pa-guide__pixel"></span></div>
                        <div class="pa-guide__example-cell"><span class="pa-guide__pixel is-high"></span></div>
                        <div class="pa-guide__example-cell"><span class="pa-guide__missing"></span></div>
                        <span>Ниже</span><span>Выше</span><span>Нет данных</span>
                    </div>
                    <figcaption>Условные пиксели. NDVI изменяется от −1 до 1. Высокие значения обычно связаны с активной растительностью. Пропуски показаны отдельно от низких значений.</figcaption>
                </figure>
                <p><strong>Средний NDVI</strong> рассчитывается по пригодным пикселям круга и выражается числом от −1 до 1. Процент рядом показывает долю пригодных данных в круге. NDVI сам по себе не показывает долю растительности.</p>
                <p>Прозрачные пиксели означают пропуск или исключение, например из-за облаков. При увеличении пиксели становятся крупнее, детализация снимка остаётся прежней.</p>
            </template>
        </div>
    </details>
</template>

<style scoped>
.pa-guide {
    margin-bottom: 12px;
    border: 1px solid var(--pa-border);
    border-radius: 9px;
    background: #f5f8f5;
    color: var(--pa-ink);
    font-size: 13px;
    line-height: 1.5;
}
.pa-guide > summary {
    cursor: pointer;
    padding: 9px 12px;
    color: var(--pa-accent);
    font-weight: 650;
}
.pa-guide > summary svg { display: inline-block; margin: 0 4px; vertical-align: text-bottom; }
.pa-guide__body { padding: 0 12px 12px; }
.pa-guide__body :is(h3, p, figure) { margin: 0 0 8px; }
.pa-guide__body :last-child { margin-bottom: 0; }
.pa-guide figure { padding: 8px; border-radius: 6px; background: #fff; }
.pa-guide figcaption { color: var(--pa-muted); font-size: 12px; }
.pa-guide__example {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2px 4px;
    margin-bottom: 8px;
    text-align: center;
}
.pa-guide__example-cell {
    display: grid;
    height: 26px;
    align-items: end;
    justify-items: center;
    border-bottom: 1px solid var(--pa-border);
}
.pa-guide__bar { width: 48%; height: 20px; background: var(--pa-accent); }
.pa-guide__bar.is-zero { height: 3px; }
.pa-guide__pixel, .pa-guide__missing { width: 48%; height: 20px; align-self: center; border-radius: 3px; }
.pa-guide__pixel { background: #c8d3d6; }
.pa-guide__pixel.is-high { background: #34734e; }
.pa-guide__missing { border: 1px dashed var(--pa-muted); }
</style>
