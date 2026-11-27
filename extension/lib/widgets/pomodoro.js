// Вкладка «Таймер Pomodoro» в стиле Droppy.
//   Стоит: «Фокус / Перерыв», шкала-линейка для выбора минут, «Старт» и большой оранжевый отсчёт.
//   Идёт:  плоская строка — пауза, отмена, «Фокус 24:58».
// В свёрнутой капле — кольцо прогресса и оранжевое время; по окончании — звук и событие.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {vbox} from '../util.js';

const ORANGE = [1, 0.62, 0.04];
const PHASES = {
    focus: {title: 'Фокус', key: 'pomodoro-focus', min: 5, max: 60},
    break: {title: 'Перерыв', key: 'pomodoro-break', min: 1, max: 30},
    long: {title: 'Длинный перерыв', key: 'pomodoro-long', min: 5, max: 45},
};

function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function ring(size, getFrac) {
    const area = new St.DrawingArea({width: size, height: size, y_align: Clutter.ActorAlign.CENTER});
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const lw = Math.max(2, size * 0.13);
        const r = Math.min(w, h) / 2 - lw / 2;
        cr.setLineWidth(lw);
        cr.setLineCap(1);
        cr.setSourceRGBA(1, 1, 1, 0.16);
        cr.arc(w / 2, h / 2, r, 0, Math.PI * 2);
        cr.stroke();
        const frac = getFrac();
        if (frac > 0) {
            cr.setSourceRGBA(...ORANGE, 1);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
            cr.stroke();
        }
        cr.$dispose();
    });
    return area;
}

/** Шкала-линейка: деления по минутам, подписи через 5, оранжевый указатель. Тянуть, щёлкать, крутить. */
class Ruler {
    constructor(onChange) {
        this._onChange = onChange;
        this._min = 5;
        this._max = 60;
        this._value = 25;
        this.actor = new St.DrawingArea({style_class: 'droplet-ruler', reactive: true, x_expand: true});
        this.actor.connect('repaint', a => this._paint(a));
        this.actor.connect('button-press-event', (_a, e) => {
            this._grab = global.stage.grab(this.actor);
            this._fromEvent(e);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('motion-event', (_a, e) => {
            if (this._grab)
                this._fromEvent(e);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('button-release-event', () => {
            this._grab?.dismiss();
            this._grab = null;
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('scroll-event', (_a, e) => {
            const d = e.get_scroll_direction();
            const step = d === Clutter.ScrollDirection.UP || d === Clutter.ScrollDirection.RIGHT ? 1
                : d === Clutter.ScrollDirection.DOWN || d === Clutter.ScrollDirection.LEFT ? -1
                    : Math.sign(-(e.get_scroll_delta?.()[1] ?? 0));
            if (step)
                this._set(this._value + step);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('destroy', () => this._grab?.dismiss());
    }

    setRange(min, max, value) {
        this._min = min;
        this._max = max;
        this._value = Math.max(min, Math.min(max, value));
        this.actor.queue_repaint();
    }

    _x(v, w) {
        const pad = 12;
        return pad + (w - 2 * pad) * (v - this._min) / (this._max - this._min);
    }

    _fromEvent(e) {
        const [x] = e.get_coords();
        const [ax] = this.actor.get_transformed_position();
        const w = this.actor.width, pad = 12;
        const v = Math.round(this._min + (x - ax - pad) / (w - 2 * pad) * (this._max - this._min));
        this._set(v);
    }

    _set(v) {
        v = Math.max(this._min, Math.min(this._max, v));
        if (v === this._value)
            return;
        this._value = v;
        this.actor.queue_repaint();
        this._onChange(v);
    }

    _paint(a) {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const labelStep = this._max - this._min > 30 ? 5 : 5;
        for (let v = this._min; v <= this._max; v++) {
            const x = Math.round(this._x(v, w)) + 0.5;
            const major = v % labelStep === 0;
            const near = Math.abs(v - this._value);
            const alpha = near === 0 ? 1 : Math.max(0.22, 0.75 - near * 0.05);
            cr.setSourceRGBA(...(near === 0 ? ORANGE : [1, 1, 1]), alpha);
            cr.setLineWidth(near === 0 ? 2 : 1);
            cr.moveTo(x, h - (major ? 18 : 12));
            cr.lineTo(x, h - 4);
            cr.stroke();
            if (major) {
                cr.selectFontFace('Sans', 0, v === this._value ? 1 : 0);
                cr.setFontSize(10);
                const t = String(v);
                const ext = cr.textExtents(t);
                cr.setSourceRGBA(...(v === this._value ? ORANGE : [1, 1, 1]), v === this._value ? 1 : 0.5);
                cr.moveTo(x - ext.width / 2 - ext.xBearing, 11);
                cr.showText(t);
            }
        }
        // указатель-треугольник
        const x = this._x(this._value, w);
        cr.setSourceRGBA(...ORANGE, 1);
        cr.moveTo(x - 4, h);
        cr.lineTo(x + 4, h);
        cr.lineTo(x, h - 5);
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }
}

export class PomodoroWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this.lockSafe = true;
        this._phase = 'focus';
        this._running = false;
        this._paused = false;
        this._left = this._duration('focus');
        this._endAt = 0;
        this._done = 0;
        this._timer = 0;

        // --- свёрнутая капля: кольцо и оранжевое время
        this.compactLeading = ring(16, () => this._frac());
        this._compactTime = new St.Label({style_class: 'droplet-pomo-compact', y_align: Clutter.ActorAlign.CENTER});
        this.compactTrailing = this._compactTime;

        // --- страница
        this.page = vbox({style_class: 'droplet-page-pomodoro'});

        // настройка (таймер стоит)
        this._setup = vbox({style_class: 'droplet-pomo-setup'});
        this._chips = new St.BoxLayout({style_class: 'droplet-pomo-chips', x_align: Clutter.ActorAlign.CENTER});
        this._setup.add_child(this._chips);
        this._ruler = new Ruler(v => {
            this._ctx.settings.set_int(PHASES[this._phase].key, v);
            this._left = v * 60;
            this._sync();
        });
        this._setup.add_child(this._ruler.actor);
        const bottom = new St.BoxLayout({style_class: 'droplet-pomo-bottom'});
        this._start = new St.Button({style_class: 'droplet-pomo-start', label: 'Старт', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._start.connect('clicked', () => this._toggle());
        bottom.add_child(this._start);
        const reset = new St.Button({style_class: 'droplet-pomo-icon', child: new St.Icon({icon_name: 'view-refresh-symbolic'}), can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        reset.connect('clicked', () => this._reset());
        bottom.add_child(reset);
        bottom.add_child(new St.Widget({x_expand: true}));
        this._bigTime = new St.Label({style_class: 'droplet-pomo-big', y_align: Clutter.ActorAlign.CENTER});
        bottom.add_child(this._bigTime);
        this._setup.add_child(bottom);
        this.page.add_child(this._setup);

        // отсчёт (таймер идёт)
        this._runRow = new St.BoxLayout({style_class: 'droplet-pomo-run'});
        this._pauseBtn = new St.Button({style_class: 'droplet-pomo-pause', child: new St.Icon({icon_name: 'media-playback-pause-symbolic'}), can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._pauseBtn.connect('clicked', () => this._toggle());
        this._runRow.add_child(this._pauseBtn);
        const stop = new St.Button({style_class: 'droplet-pomo-icon', child: new St.Icon({icon_name: 'window-close-symbolic'}), can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        stop.connect('clicked', () => this._reset());
        this._runRow.add_child(stop);
        this._runRow.add_child(new St.Widget({x_expand: true}));
        this._runPhase = new St.Label({style_class: 'droplet-pomo-runphase', y_align: Clutter.ActorAlign.END});
        this._runRow.add_child(this._runPhase);
        this._runTime = new St.Label({style_class: 'droplet-pomo-big', y_align: Clutter.ActorAlign.CENTER});
        this._runRow.add_child(this._runTime);
        this.page.add_child(this._runRow);

        this._sync();
    }

    _duration(phase) {
        return this._ctx.settings.get_int(PHASES[phase].key) * 60;
    }

    _remaining() {
        if (this._running && !this._paused)
            return Math.max(0, (this._endAt - GLib.get_monotonic_time()) / 1e6);
        return this._left;
    }

    _frac() {
        const total = this._duration(this._phase);
        return total ? 1 - this._remaining() / total : 0;
    }

    compactPriority() {
        return this._running ? 120 : 0;
    }

    _toggle() {
        if (!this._running || this._paused) {
            this._running = true;
            this._paused = false;
            this._endAt = GLib.get_monotonic_time() + this._left * 1e6;
        } else {
            this._left = this._remaining();
            this._paused = true;
        }
        this._tickSetup();
        this._sync();
        this._ctx.compactChanged();
    }

    _reset() {
        this._running = false;
        this._paused = false;
        this._left = this._duration(this._phase);
        this._tickSetup();
        this._sync();
        this._ctx.compactChanged();
    }

    _choosePhase(phase) {
        if (this._running)
            return;
        this._phase = phase;
        this._left = this._duration(phase);
        this._sync();
    }

    _finish() {
        const was = this._phase;
        if (was === 'focus') {
            this._done += 1;
            const every = this._ctx.settings.get_int('pomodoro-every');
            this._phase = this._done % every === 0 ? 'long' : 'break';
        } else {
            this._phase = 'focus';
        }
        this._left = this._duration(this._phase);
        const autostart = was === 'focus';
        this._running = autostart;
        this._paused = false;
        this._endAt = GLib.get_monotonic_time() + this._left * 1e6;
        try {
            global.display.get_sound_player().play_from_theme('complete', 'Pomodoro', null);
        } catch (e) {}
        this._ctx.island.showActivity({
            icon: 'alarm-symbolic',
            title: was === 'focus' ? 'Фокус окончен' : 'Перерыв окончен',
            subtitle: was === 'focus' ? `${PHASES[this._phase].title} — ${this._duration(this._phase) / 60} мин` : 'Нажмите, чтобы начать фокус',
            accent: 'rgb(255,159,10)',
            duration: 4000,
            onClick: () => this._ctx.showTab('pomodoro'),
        });
        this._tickSetup();
        this._sync();
        this._ctx.compactChanged();
    }

    _tickSetup() {
        const need = this._running && !this._paused;
        if (need && !this._timer) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                if (this._remaining() <= 0)
                    this._finish();
                else
                    this._sync();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!need && this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    _sync() {
        const rem = fmt(this._remaining());
        const ph = PHASES[this._phase];
        this._compactTime.text = rem;
        this._bigTime.text = rem;
        this._runTime.text = rem;
        this._runPhase.text = this._paused ? 'Пауза' : ph.title;
        this._pauseBtn.child.icon_name = this._paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';

        const setupShown = !this._running;
        if (this._setup.visible !== setupShown || this._runRow.visible === setupShown) {
            this._setup.visible = setupShown;
            this._runRow.visible = !setupShown;
            this._ctx.relayout();
        }
        if (setupShown) {
            this._chips.destroy_all_children();
            for (const [id, label] of [['focus', 'Фокус'], ['break', 'Перерыв']]) {
                const on = id === this._phase || (id === 'break' && this._phase === 'long');
                const b = new St.Button({style_class: 'droplet-pomo-chip', label, can_focus: true});
                if (on)
                    b.add_style_pseudo_class('checked');
                b.connect('clicked', () => this._choosePhase(id));
                this._chips.add_child(b);
            }
            this._ruler.setRange(ph.min, ph.max, this._ctx.settings.get_int(ph.key));
        }
        this.compactLeading.queue_repaint();
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this.compactLeading.destroy();
        this.compactTrailing.destroy();
        this.page.destroy();
    }
}
