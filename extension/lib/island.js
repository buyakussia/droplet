// Сама «капля»: форма, состояния и жесты.
//
// Состояния:
//   compact  — пилюля в панели на месте часов (время, а если играет музыка — обложка и эквалайзер);
//   activity — короткое событие: уведомление, наушники подключены, заряд… потом снова compact;
//   expanded — капля «стекает» из панели вниз и показывает виджеты.
//
// Все размеры ведут пружины (spring.js), поэтому смена состояния посреди движения
// не даёт рывков: форма просто меняет направление, сохраняя скорость.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Animator, Spring} from './spring.js';
import {drawDroplet} from './shape.js';
import {vbox} from './util.js';

const FILLET = 16;          // запас по бокам под вогнутые скругления
const WOBBLE_ROOM = 12;     // запас снизу под «провисание» края
const EXPANDED_RADIUS = 32;
const COMPACT_PAD = 26;
const HOVER_GROW = 10;
const COLLAPSE_DELAY = 650; // мс после ухода курсора
const HOVER_EXPAND_DELAY = 220;

// Пружины: ширина чуть жёстче высоты — капля сначала «вытягивается», потом расширяется.
// Подобраны под ощущение Dynamic Island: ~0,5 с на раскрытие, лёгкий «перелёт» по высоте.
const SPRING_W = {stiffness: 190, damping: 21};
const SPRING_H = {stiffness: 165, damping: 16.5};
const SPRING_M = {stiffness: 200, damping: 26};

export const Island = GObject.registerClass({
    Signals: {'state-changed': {param_types: [GObject.TYPE_STRING]}},
}, class Island extends St.Widget {
    _init(settings) {
        super._init({
            name: 'droplet',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._settings = settings;
        this._panel = Main.panel.height;
        this._state = 'compact';
        this._compactProvider = null;
        this._timeouts = new Set();

        this._bg = new St.DrawingArea({style_class: 'droplet-bg'});
        this._bg.connect('repaint', area => this._repaint(area));
        this.add_child(this._bg);
        // всё содержимое — в отдельном слое, который обрезается по телу капли
        this._content = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.add_child(this._content);

        // время — как у часов GNOME (учитывает 12/24 ч и показ даты из настроек)
        this._clock = new GnomeDesktop.WallClock();
        this._clockLabel = new St.Label({style_class: 'droplet-clock', y_align: Clutter.ActorAlign.CENTER});
        this._clock.connectObject('notify::clock', () => this._syncClock(), this);
        this._syncClock();

        this._compact = new St.BoxLayout({style_class: 'droplet-compact', y_align: Clutter.ActorAlign.CENTER});
        this._leading = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._trailing = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._compact.add_child(this._leading);
        this._compact.add_child(this._clockLabel);
        this._compact.add_child(this._trailing);
        this._content.add_child(this._compact);

        this._activity = new St.BoxLayout({style_class: 'droplet-activity', opacity: 0, visible: false});
        this._content.add_child(this._activity);

        this._expanded = vbox({style_class: 'droplet-expanded',
            opacity: 0,
            visible: false});
        this._content.add_child(this._expanded);

        // размеры считаются после добавления на экран (start())
        this._w = new Spring(0, SPRING_W);
        this._h = new Spring(this._panel, SPRING_H);
        this._m = new Spring(0, SPRING_M);
        this._animator = new Animator(this, dt => this._frame(dt));

        this.connect('notify::hover', () => this._onHover());
        this.connect('button-release-event', (_a, e) => this._onClick(e));
        this.connect('scroll-event', (_a, e) => this._onScroll(e));
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.connectObject('monitors-changed', () => this._kick(true), this);
    }

    /** Вызывается после добавления на сцену. */
    start() {
        this._started = true;
        this._kick(true);
    }

    get state() {
        return this._state;
    }

    // ------------------------------------------------------------------ содержимое

    _syncClock() {
        this._clockLabel.text = this._clock.clock.trim();
        this._kick();
    }

    /** Виджет с наивысшим приоритетом показывает себя по бокам от времени (обложка, эквалайзер). */
    setCompact(leading, trailing) {
        if (this._leading.child !== leading) {
            this._leading.child?.get_parent()?.remove_child(this._leading.child);
            leading?.get_parent()?.remove_child(leading);
            this._leading.set_child(leading ?? null);
        }
        if (this._trailing.child !== trailing) {
            this._trailing.child?.get_parent()?.remove_child(this._trailing.child);
            trailing?.get_parent()?.remove_child(trailing);
            this._trailing.set_child(trailing ?? null);
        }
        this._compact.remove_style_class_name('has-live');
        if (leading || trailing)
            this._compact.add_style_class_name('has-live');
        this._kick();
    }

    /** Содержимое раскрытой капли (строится реестром виджетов). */
    setExpandedContent(actor) {
        this._expanded.destroy_all_children();
        if (actor)
            this._expanded.add_child(actor);
        this._kick();
    }

    /**
     * Короткое событие в капле.
     * @param {object} a  icon (St.Widget | Gio.Icon | имя значка), title, subtitle,
     *                    progress (0…1 или null), duration (мс), accent (цвет CSS)
     */
    showActivity(a) {
        if (this._state === 'expanded' || !this._started)
            return false;
        this._activity.destroy_all_children();

        let icon = a.icon;
        if (icon && !(icon instanceof Clutter.Actor)) {
            icon = typeof icon === 'string'
                ? new St.Icon({icon_name: icon, style_class: 'droplet-activity-icon'})
                : new St.Icon({gicon: icon, style_class: 'droplet-activity-icon'});
        }
        if (icon)
            this._activity.add_child(icon);

        const text = vbox({y_align: Clutter.ActorAlign.CENTER,
            x_expand: true});
        const title = new St.Label({text: a.title ?? '', style_class: 'droplet-activity-title'});
        title.clutter_text.ellipsize = 3; // END
        text.add_child(title);
        if (a.subtitle) {
            const sub = new St.Label({text: a.subtitle, style_class: 'droplet-activity-subtitle'});
            sub.clutter_text.ellipsize = 3;
            text.add_child(sub);
        }
        if (a.progress !== undefined && a.progress !== null) {
            const track = new St.Widget({style_class: 'droplet-progress', x_expand: true});
            const fill = new St.Widget({style_class: 'droplet-progress-fill'});
            if (a.accent)
                fill.style = `background-color: ${a.accent};`;
            track.add_child(fill);
            track.connect('notify::width', () => {
                fill.width = Math.round(track.width * Math.max(0, Math.min(1, a.progress)));
                fill.height = track.height;
            });
            text.add_child(track);
        }
        this._activity.add_child(text);

        this._activityOnClick = a.onClick ?? null;
        this._setState('activity');
        this._clearTimeout('activity');
        this._addTimeout('activity', a.duration ?? 2600, () => {
            if (this._state === 'activity')
                this._setState(this.hover && this._settings.get_boolean('expand-on-hover') ? 'expanded' : 'compact');
        });
        return true;
    }

    // ------------------------------------------------------------------ состояния

    expand() {
        this._setState('expanded');
    }

    collapse() {
        if (this._state !== 'compact')
            this._setState('compact');
    }

    toggle() {
        this._state === 'expanded' ? this.collapse() : this.expand();
    }

    _setState(state) {
        if (state === this._state)
            return;
        const prev = this._state;
        this._state = state;
        const layers = {compact: this._compact, activity: this._activity, expanded: this._expanded};
        for (const [name, layer] of Object.entries(layers)) {
            if (name === state)
                this._fadeIn(layer);
            else if (name === prev)
                this._fadeOut(layer);
        }
        if (state === 'expanded')
            this._watchOutsideClicks(true);
        else
            this._watchOutsideClicks(false);
        this.emit('state-changed', state);
        this._kick();
    }

    // проявление с лёгким увеличением и расфокусом → чётко: содержимое «всплывает» из капли
    _fadeIn(layer) {
        layer.remove_all_transitions();
        layer.visible = true;
        layer.set_pivot_point(0.5, 0);
        layer.opacity = 0;
        layer.scale_x = layer.scale_y = 0.94;
        layer.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            delay: 110,
            duration: 320,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _fadeOut(layer) {
        layer.remove_all_transitions();
        layer.set_pivot_point(0.5, 0);
        layer.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._state !== this._layerName(layer))
                    layer.visible = false;
            },
        });
    }

    _layerName(layer) {
        return layer === this._compact ? 'compact' : layer === this._activity ? 'activity' : 'expanded';
    }

    // ------------------------------------------------------------------ геометрия

    /** Естественный размер: высота считается для реальной ширины (важно для сеток с переносом). */
    _natural(actor) {
        const [, w] = actor.get_preferred_width(-1);
        const [, h] = actor.get_preferred_height(w);
        return [w, h];
    }

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _targetSize() {
        const mon = this._monitor();
        const maxW = mon ? mon.width - 2 * FILLET - 40 : 1200;
        switch (this._state) {
        case 'expanded': {
            const [w, h] = this._natural(this._expanded);
            return [Math.min(Math.max(w, 360), maxW), Math.max(h, this._panel + 60)];
        }
        case 'activity': {
            const [w, h] = this._natural(this._activity);
            return [Math.min(Math.max(w + 22, 220), maxW), Math.max(this._panel, h)];
        }
        default: {
            const [w] = this._natural(this._compact);
            return [w + COMPACT_PAD + (this.hover ? HOVER_GROW : 0), this._panel];
        }
        }
    }

    /** Пересчитать цель и разбудить анимацию. `snap` — без анимации (при старте). */
    _kick(snap = false) {
        if (!this._w || !this._started || !this.get_stage())
            return;
        this._retarget();
        if (snap) {
            this._w.snap();
            this._h.snap();
            this._m.snap();
            this._apply();
            return;
        }
        this._animator.start();
    }

    _retarget() {
        const [w, h] = this._targetSize();
        this._w.target = w;
        this._h.target = h;
        this._m.target = h > this._panel + 2 ? 1 : 0;
    }

    _frame(dt) {
        // цель пересчитывается каждый кадр: содержимое могло измениться (текст, картинка)
        this._retarget();
        this._w.step(dt);
        this._h.step(dt);
        this._m.step(dt);
        this._apply();
        return !(this._w.settled && this._h.settled && this._m.settled);
    }

    _apply() {
        const mon = this._monitor();
        if (!mon)
            return;
        const W = Math.max(1, this._w.value);
        const H = Math.max(1, this._h.value);
        const totalW = Math.round(W + 2 * FILLET);
        const totalH = Math.round(H + WOBBLE_ROOM);
        this.set_position(Math.round(mon.x + (mon.width - totalW) / 2), mon.y);
        this.set_size(totalW, totalH);
        this._bg.set_size(totalW, totalH);
        this._bg.queue_repaint();

        // содержимое — по центру своей области; лишнее обрезается по форме капли
        const place = (layer, y) => {
            if (!layer.visible)
                return;
            // размер не фиксируем — иначе слой перестанет сообщать свой настоящий размер
            const [lw, lh] = this._natural(layer);
            layer.set_position(Math.round(FILLET + (W - lw) / 2), Math.round(y(lh)));
        };
        place(this._compact, lh => (this._panel - lh) / 2);
        place(this._activity, lh => Math.max(0, (H - lh) / 2));
        place(this._expanded, () => 0);
        this._content.set_position(0, 0);
        this._content.set_size(totalW, totalH);
        this._content.set_clip(FILLET, 0, W, H);
    }

    _repaint(area) {
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        // жидкость «провисает» по направлению движения и чуть пружинит обратно
        const wobble = Math.max(-9, Math.min(9, this._h.velocity * 0.012));
        drawDroplet(cr, {
            width,
            height: height - WOBBLE_ROOM,
            fillet: FILLET,
            panel: this._panel,
            morph: this._m.value,
            radius: EXPANDED_RADIUS,
            wobble,
            color: [0, 0, 0, 1],
        });
        cr.$dispose();
    }

    // ------------------------------------------------------------------ жесты

    _onHover() {
        this._clearTimeout('collapse');
        this._clearTimeout('hover-expand');
        if (this.hover) {
            if (this._state !== 'expanded' && this._settings.get_boolean('expand-on-hover'))
                this._addTimeout('hover-expand', HOVER_EXPAND_DELAY, () => this.expand());
        } else if (this._state === 'expanded') {
            this._addTimeout('collapse', COLLAPSE_DELAY, () => {
                if (!this.hover && !this._holdOpen)
                    this.collapse();
            });
        }
        this._kick();
    }

    /** Пока открыто меню виджета, капля не сворачивается от ухода курсора. */
    holdOpen(hold) {
        this._holdOpen = hold;
        if (!hold && !this.hover && this._state === 'expanded')
            this._onHover();
    }

    _onClick(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.collapse();
            Main.panel.statusArea.dateMenu?.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (this._state === 'activity' && this._activityOnClick) {
            this._activityOnClick();
            this.collapse();
        } else if (this._state !== 'expanded') {
            this.expand();
        }
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        if (this._state === 'expanded')
            return Clutter.EVENT_PROPAGATE;
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP)
            delta = 1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            delta = -1;
        else if (dir === Clutter.ScrollDirection.SMOOTH)
            delta = -event.get_scroll_delta()[1];
        if (delta && this.onScroll)
            this.onScroll(delta);
        return Clutter.EVENT_STOP;
    }

    _watchOutsideClicks(on) {
        if (on && !this._stageId) {
            this._stageId = global.stage.connect('captured-event', (_s, e) => {
                const t = e.type();
                if (t !== Clutter.EventType.BUTTON_PRESS && t !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;
                const src = e.get_source();
                if (!this._holdOpen && src && !this.contains(src))
                    this.collapse();
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (!on && this._stageId) {
            global.stage.disconnect(this._stageId);
            this._stageId = 0;
        }
    }

    // ------------------------------------------------------------------ служебное

    _addTimeout(key, ms, fn) {
        this._clearTimeout(key);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(key);
            this[`_t_${key}`] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this[`_t_${key}`] = id;
        this._timeouts.add(key);
    }

    _clearTimeout(key) {
        const id = this[`_t_${key}`];
        if (id) {
            GLib.source_remove(id);
            this[`_t_${key}`] = 0;
        }
        this._timeouts.delete(key);
    }

    _onDestroy() {
        for (const key of [...this._timeouts])
            this._clearTimeout(key);
        this._watchOutsideClicks(false);
        this._animator?.destroy();
        this._animator = null;
        this._clock = null;
    }
});
