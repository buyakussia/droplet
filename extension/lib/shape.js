// Форма капли. Рисуется вручную (cairo), чтобы плавно перетекать между
// «пилюлей в панели» и «каплей, стекающей из панели».

/**
 * @param {Cairo.Context} cr
 * @param {object} p
 *   width, height — размер области рисования;
 *   fillet — запас по бокам под вогнутые скругления;
 *   panel — высота верхней панели;
 *   morph — 0: пилюля внутри панели, 1: капля, вытекающая из панели;
 *   radius — радиус нижних углов раскрытой капли;
 *   wobble — смещение середины нижнего края (жидкость «провисает» при движении);
 *   color — [r, g, b, a]
 */
export function drawDroplet(cr, p) {
    const {width, height, fillet, panel, morph, radius, wobble, color} = p;
    const x0 = fillet, x1 = width - fillet;
    const w = x1 - x0;
    if (w <= 1 || height <= 1)
        return;

    const lerp = (a, b, t) => a + (b - a) * t;
    const m = Math.max(0, Math.min(1, morph));

    // пилюля держится с небольшим отступом внутри панели; капля прилегает к верхнему краю
    const inset = lerp(3, 0, m);
    const top = inset;
    const bottom = height - lerp(inset, 0, m);
    const h = bottom - top;
    const pill = Math.min(h, w) / 2;
    const rTop = Math.min(lerp(pill, 0, m), w / 2);
    const rBottom = Math.min(lerp(pill, radius, m), h / 2, w / 2);

    // вогнутые скругления там, где капля отрывается от нижнего края панели
    const below = bottom - panel;
    const f = Math.max(0, Math.min(fillet, below - rBottom, fillet * m));

    cr.newPath();
    cr.moveTo(x0 + rTop, top);
    cr.lineTo(x1 - rTop, top);
    if (rTop > 0)
        cr.arc(x1 - rTop, top + rTop, rTop, -Math.PI / 2, 0);

    if (f > 0.5) {
        cr.lineTo(x1, panel);
        cr.lineTo(x1 + f, panel);
        cr.curveTo(x1 + f * 0.45, panel, x1, panel + f * 0.45, x1, panel + f);
    }
    cr.lineTo(x1, bottom - rBottom);
    if (rBottom > 0)
        cr.arc(x1 - rBottom, bottom - rBottom, rBottom, 0, Math.PI / 2);

    // нижний край слегка «провисает» в движении — ощущение жидкости
    const midY = bottom + wobble;
    cr.curveTo(x1 - rBottom - (w - 2 * rBottom) * 0.25, midY,
        x0 + rBottom + (w - 2 * rBottom) * 0.25, midY,
        x0 + rBottom, bottom);
    if (rBottom > 0)
        cr.arc(x0 + rBottom, bottom - rBottom, rBottom, Math.PI / 2, Math.PI);

    if (f > 0.5) {
        cr.lineTo(x0, panel + f);
        cr.curveTo(x0, panel + f * 0.45, x0 - f * 0.45, panel, x0 - f, panel);
        cr.lineTo(x0, panel);
    }
    cr.lineTo(x0, top + rTop);
    if (rTop > 0)
        cr.arc(x0 + rTop, top + rTop, rTop, Math.PI, Math.PI * 1.5);
    cr.closePath();

    cr.setSourceRGBA(...color);
    cr.fill();
}
