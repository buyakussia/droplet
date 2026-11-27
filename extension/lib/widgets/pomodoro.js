// Вкладка «Таймер Pomodoro»: фокус → перерыв → фокус… Пока идёт таймер, в свёрнутой капле
// видны кольцо прогресса и обратный отсчёт; по окончании — звук и событие в капле.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {vbox} from '../util.js';

const PHASES = {
    focus: {title: 'Фокус', color: [1, 0.42, 0.33]},
    break: {title: 'Перерыв', color: [0.2, 0.78, 0.35]},
    long: {title: 'Длинный перерыв', color: [0.35, 0.6, 1]},
};

function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function ring(size, getState) {
    const area = new St.DrawingArea({style_class: 'droplet-ring', width: size, height: size, y_align: Clutter.ActorAlign.CENTER});
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const {frac, color} = getState();
        const lw = Math.max(2, size * 0.11);
        const r = Math.min(w, h) / 2 - lw / 2;
        cr.setLineWidth(lw);
        cr.setLineCap(1); // ROUND
        cr.setSourceRGBA(1, 1, 1, 0.14);
        cr.arc(w / 2, h / 2, r, 0, Math.PI * 2);
        cr.stroke();
        if (frac > 0) {
            cr.setSourceRGBA(...color, 1);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
            cr.stroke();
        }
        cr.$dispose();
    });
    return area;
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
        this._done = 0;     // завершённых фокусов в цикле
        this._timer = 0;

        const state = () => ({frac: this._frac(), color: PHASES[this._phase].color});
        this.compactLeading = ring(18, state);
        this._compactTime = new St.Label({style_class: 'droplet-pomo-compact', y_align: Clutter.ActorAlign.CENTER});
        this.compactTrailing = this._compactTime;

        this.page = new St.BoxLayout({style_class: 'droplet-page-pomodoro'});
        const ringBox = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'droplet-pomo-ringbox'});
        this._bigRing = ring(132, state);
        ringBox.add_child(this._bigRing);
        const center = vbox({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._time = new St.Label({style_class: 'droplet-pomo-time', x_align: Clutter.ActorAlign.CENTER});
        this._phaseLabel = new St.Label({style_class: 'droplet-pomo-phase', x_align: Clutter.ActorAlign.CENTER});
        center.add_child(this._time);
        center.add_child(this._phaseLabel);
        ringBox.add_child(center);
        this.page.add_child(ringBox);

        const side = vbox({style_class: 'droplet-pomo-side', y_align: Clutter.ActorAlign.CENTER});
        this._dots = new St.BoxLayout({style_class: 'droplet-pomo-dots'});
        side.add_child(this._dots);

        // как в Droppy: пока таймер стоит — выбрать этап и длительность
        this._setup = vbox({style_class: 'droplet-pomo-setup'});
        this._phaseChips = new St.BoxLayout({style_class: 'droplet-pomo-chips'});
        this._minChips = new St.BoxLayout({style_class: 'droplet-pomo-chips'});
        this._setup.add_child(this._phaseChips);
        this._setup.add_child(this._minChips);
        side.add_child(this._setup);
        const buttons = new St.BoxLayout({style_class: 'droplet-pomo-buttons'});
        const mk = (icon, tip, fn, cls = 'droplet-round-button') => {
            const b = new St.Button({style_class: cls, child: new St.Icon({icon_name: icon}), accessible_name: tip, can_focus: true});
            b.connect('clicked', fn);
            buttons.add_child(b);
            return b;
        };
        this._startBtn = mk('media-playback-start-symbolic', 'Старт / пауза', () => this._toggle(), 'droplet-round-button big accent');
        mk('view-refresh-symbolic', 'Сбросить', () => this._reset());
        mk('media-skip-forward-symbolic', 'Следующий этап', () => this._finish(true));
        side.add_child(buttons);
        this._hint = new St.Label({style_class: 'droplet-dim'});
        side.add_child(this._hint);
        this.page.add_child(side);
        this._sync();
    }

    _duration(phase) {
        const s = this._ctx.settings;
        const min = phase === 'focus' ? s.get_int('pomodoro-focus') : phase === 'long' ? s.get_int('pomodoro-long') : s.get_int('pomodoro-break');
        return min * 60;
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
        if (!this._running) {
            this._running = true;
            this._paused = false;
            this._endAt = GLib.get_monotonic_time() + this._left * 1e6;
        } else if (this._paused) {
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
        this._phase = 'focus';
        this._done = 0;
        this._left = this._duration('focus');
        this._tickSetup();
        this._sync();
        this._ctx.compactChanged();
    }

    _finish(skipped = false) {
        const was = this._phase;
        if (was === 'focus') {
            this._done += 1;
            const every = this._ctx.settings.get_int('pomodoro-every');
            this._phase = this._done % every === 0 ? 'long' : 'break';
        } else {
            this._phase = 'focus';
        }
        this._left = this._duration(this._phase);
        // после фокуса перерыв начинается сам; после перерыва ждём, пока человек нажмёт «Старт»
        const autostart = was === 'focus' && this._running;
        this._running = autostart;
        this._paused = false;
        this._endAt = GLib.get_monotonic_time() + this._left * 1e6;
        if (!skipped) {
            try {
                global.display.get_sound_player().play_from_theme('complete', 'Pomodoro', null);
            } catch (e) {}
            this._ctx.island.showActivity({
                icon: 'alarm-symbolic',
                title: was === 'focus' ? 'Фокус окончен' : 'Перерыв окончен',
                subtitle: was === 'focus' ? `${PHASES[this._phase].title} — ${this._duration(this._phase) / 60} мин` : 'Нажмите, чтобы начать фокус',
                accent: 'rgb(255,107,84)',
                duration: 4000,
                onClick: () => this._ctx.showTab('pomodoro'),
            });
        }
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
        const rem = this._remaining();
        this._time.text = fmt(rem);
        this._compactTime.text = fmt(rem);
        this._phaseLabel.text = PHASES[this._phase].title + (this._paused ? ' · пауза' : '');
        this._startBtn.child.icon_name = this._running && !this._paused ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        const every = this._ctx.settings.get_int('pomodoro-every');
        this._dots.destroy_all_children();
        for (let i = 0; i < every; i++) {
            const d = new St.Widget({style_class: 'droplet-pomo-dot'});
            if (i < this._done % every || (this._done && this._done % every === 0 && this._phase === 'long'))
                d.add_style_pseudo_class('checked');
            this._dots.add_child(d);
        }
        this._hint.text = this._running ? '' : 'Нажмите ▶, чтобы начать';
        this._setup.visible = !this._running;
        if (!this._running)
            this._fillSetup();
        this.compactLeading.queue_repaint();
        this._bigRing.queue_repaint();
    }

    _chip(label, active, fn) {
        const b = new St.Button({style_class: 'droplet-chip droplet-pomo-chip', label, can_focus: true});
        if (active)
            b.add_style_pseudo_class('checked');
        b.connect('clicked', fn);
        return b;
    }

    _fillSetup() {
        this._phaseChips.destroy_all_children();
        this._minChips.destroy_all_children();
        const focus = this._phase === 'focus';
        this._phaseChips.add_child(this._chip('Фокус', focus, () => this._choosePhase('focus')));
        this._phaseChips.add_child(this._chip('Перерыв', !focus, () => this._choosePhase('break')));
        const key = focus ? 'pomodoro-focus' : this._phase === 'long' ? 'pomodoro-long' : 'pomodoro-break';
        const options = focus ? [15, 25, 45, 60] : this._phase === 'long' ? [10, 15, 20, 30] : [5, 10, 15];
        const current = this._ctx.settings.get_int(key);
        for (const m of options) {
            this._minChips.add_child(this._chip(`${m}`, m === current, () => {
                this._ctx.settings.set_int(key, m);
                this._left = m * 60;
                this._sync();
            }));
        }
    }

    _choosePhase(phase) {
        this._phase = phase;
        this._left = this._duration(phase);
        this._sync();
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this.compactLeading.destroy();
        this.compactTrailing.destroy();
        this.page.destroy();
    }
}
