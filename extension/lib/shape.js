import Cairo from 'cairo';

// Форма капли. Рисуется вручную (cairo), чтобы плавно перетекать между
// «пилюлей в панели» и «каплей, стекающей из панели».
// Под раскрытой каплей живёт вторая капелька — панель вкладок; пока они близко,
// между ними тянется жидкая «перемычка», как у отрывающейся капли воды.

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {Cairo.Context} cr
 * @param {object} p
 *   width — ширина области рисования; height — высота тела капли;
 *   fillet — запас по бокам под вогнутые скругления;
 *   panel — высота верхней панели;
 *   morph — 0: пилюля внутри панели, 1: капля, вытекающая из панели;
 *   radius — радиус нижних углов раскрытой капли;
 *   wobble — «провисание» середины нижнего края в движении;
 *   tabs — {x, y, w, h} капелька вкладок или null;
 *   color — [r, g, b, a]
 */
export function drawDroplet(cr, p) {
    const {width, height, fillet, panel, morph, radius, wobble, tabs, color, floating} = p;
    const x0 = fillet, x1 = width - fillet;
    const w = x1 - x0;
    if (w <= 1 || height <= 1)
        return;
    const m = Math.max(0, Math.min(1, morph));

    // «вырез»: пилюля в панели превращается в каплю, прилегающую к верхнему краю;
    // «остров»: капля всегда парит с отступом и скруглена со всех сторон, как Dynamic Island
    const inset = floating ? 3 : lerp(3, 0, m);
    const top = inset;
    const bottom = height - (floating ? 0 : lerp(inset, 0, m));
    const h = bottom - top;
    const pill = Math.min(h, w) / 2;
    const rTop = Math.min(floating ? lerp(pill, radius, m) : lerp(pill, 0, m), h / 2, w / 2);
    const rBottom = Math.min(lerp(pill, radius, m), h / 2, w / 2);

    // вогнутые скругления там, где капля отрывается от нижнего края панели (только «вырез»)
    const below = bottom - panel;
    const f = floating ? 0 : Math.max(0, Math.min(fillet, below - rBottom, fillet * m));

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

    // тело капли: в раскрытом виде низ мягко растворяется, как у Droppy
    fillBody(cr, color, top, bottom, m);

    if (tabs && tabs.w > 2 && tabs.h > 2) {
        cr.newPath();
        const r = tabs.h / 2;
        // капелька вкладок
        cr.moveTo(tabs.x + r, tabs.y);
        cr.lineTo(tabs.x + tabs.w - r, tabs.y);
        cr.arc(tabs.x + tabs.w - r, tabs.y + r, r, -Math.PI / 2, Math.PI / 2);
        cr.lineTo(tabs.x + r, tabs.y + tabs.h);
        cr.arc(tabs.x + r, tabs.y + r, r, Math.PI / 2, Math.PI * 1.5);
        cr.closePath();

        // жидкая перемычка: чем ближе капельки, тем она толще; на расстоянии рвётся
        const gap = tabs.y - bottom;
        const reach = 9;   // в покое (зазор 10) перемычки нет — только в момент отрыва
        if (gap > -tabs.h && gap < reach) {
            const k = 1 - Math.max(0, gap) / reach;           // 1 — слиты, 0 — оторвались
            const cx = tabs.x + tabs.w / 2;
            const neck = Math.max(2, Math.min(tabs.w, w) * 0.22 * k);
            const spread = neck * 1.9;
            const yTop = bottom - 1, yBot = tabs.y + 1;
            const mid = (yTop + yBot) / 2;
            cr.moveTo(cx - spread, yTop);
            cr.curveTo(cx - neck * 0.9, yTop, cx - neck * 0.55, mid, cx - neck * 0.6, mid);
            cr.curveTo(cx - neck * 0.55, mid, cx - neck * 0.9, yBot, cx - spread, yBot);
            cr.lineTo(cx + spread, yBot);
            cr.curveTo(cx + neck * 0.9, yBot, cx + neck * 0.55, mid, cx + neck * 0.6, mid);
            cr.curveTo(cx + neck * 0.55, mid, cx + neck * 0.9, yTop, cx + spread, yTop);
            cr.closePath();
        }

        // капелька вкладок — тёмно-серая полупрозрачная, как в Droppy
        cr.setSourceRGBA(0.16, 0.16, 0.17, 0.92);
        cr.setFillRule(0); // WINDING: части сливаются в одну фигуру
        cr.fill();
    }
}

function fillBody(cr, color, top, bottom, m) {
    const [r, g, b, a] = color;
    const fade = 30 * Math.max(0, Math.min(1, m));
    if (fade < 1) {
        cr.setSourceRGBA(r, g, b, a);
    } else {
        const pat = new Cairo.LinearGradient(0, top, 0, bottom);
        pat.addColorStopRGBA(0, r, g, b, a);
        pat.addColorStopRGBA(Math.max(0, (bottom - top - fade) / (bottom - top)), r, g, b, a);
        pat.addColorStopRGBA(1, r + 0.07, g + 0.07, b + 0.07, a * 0.86);
        cr.setSource(pat);
    }
    cr.setFillRule(0);
    cr.fill();
}
