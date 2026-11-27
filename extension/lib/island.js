// Сама «капля»: форма, состояния, вкладки и жесты.
//
// Состояния:
//   compact  — пилюля в панели на месте часов (время; если что-то «живое» — по бокам от него);
//   peek     — при наведении: пилюля чуть шире и показывает бегущую строку (например, трек);
//   activity — короткое событие: уведомление, трек, файлы на полке… потом снова compact;
//   hud      — громкость / яркость тонкой полоской прямо в капле;
//   drop     — над каплей тащат файлы: «отпустите, чтобы положить на полку»;
//   expanded — капля «стекает» из панели; под ней отделяется капелька вкладок.
//
// Все размеры ведут пружины (spring.js): смена состояния посреди движения не даёт рывков.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
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
const TABS_GAP = 10;        // расстояние между каплей и капелькой вкладок
const COLLAPSE_DELAY = 650;
const HOVER_EXPAND_DELAY = 220;
const PEEK_DELAY = 260;

// Подобраны под ощущение Dynamic Island: ~0,5 с на раскрытие, лёгкий «перелёт» по высоте.
const SPRING_W = {stiffness: 190, damping: 21};
const SPRING_H = {stiffness: 165, damping: 16.5};
const SPRING_M = {stiffness: 200, damping: 26};
const SPRING_T = {stiffness: 150, damping: 15};  // вкладки отрываются с заметным «пружинением»

const LAYERS = ['compact', 'activity', 'hud', 'drop', 'expanded'];

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
        this._timeouts = new Map();
        this._tabsActor = null;
        this.locked = false;
        this.peekProvider = null;   // () => строка для бегущей строки при наведении или null
        this.onScroll = null;
        this.onExpand = null;       // () => перед раскрытием (выбрать вкладку)

        this._bg = new St.DrawingArea({style_class: 'droplet-bg'});
        this._bg.connect('repaint', area => this._repaint(area));
        this.add_child(this._bg);

        // всё содержимое — в отдельном слое, который обрезается по телу капли
        this._content = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.add_child(this._content);

        // --- свёрнутая: [слева] [время или бегущая строка] [справа]
        this._clock = new GnomeDesktop.WallClock();
        this._clockLabel = new St.Label({style_class: 'droplet-clock', y_align: Clutter.ActorAlign.CENTER});
        this._clock.connectObject('notify::clock', () => this._syncClock(), this);
        this._marquee = new St.Widget({style_class: 'droplet-marquee', clip_to_allocation: true, y_align: Clutter.ActorAlign.CENTER, layout_manager: new Clutter.FixedLayout()});
        this._marqueeLabel = new St.Label({style_class: 'droplet-marquee-text'});
        this._marquee.add_child(this._marqueeLabel);
        this._center = new St.Bin({y_align: Clutter.ActorAlign.CENTER, child: this._clockLabel});
        this._compact = new St.BoxLayout({style_class: 'droplet-compact', y_align: Clutter.ActorAlign.CENTER});
        this._leading = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._trailing = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._compact.add_child(this._leading);
        this._compact.add_child(this._center);
        this._compact.add_child(this._trailing);
        this._content.add_child(this._compact);
        this._syncClock();

        this._activity = new St.BoxLayout({style_class: 'droplet-activity', opacity: 0, visible: false});
        this._content.add_child(this._activity);

        this._hud = new St.BoxLayout({style_class: 'droplet-hud', opacity: 0, visible: false});
        this._content.add_child(this._hud);

        this._drop = vbox({style_class: 'droplet-drop', opacity: 0, visible: false});
        this._drop.add_child(new St.Icon({icon_name: 'folder-download-symbolic', style_class: 'droplet-drop-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._dropLabel = new St.Label({text: 'Отпустите, чтобы положить на полку', style_class: 'droplet-drop-label', x_align: Clutter.ActorAlign.CENTER});
        this._drop.add_child(this._dropLabel);
        this._content.add_child(this._drop);

        this._expanded = vbox({style_class: 'droplet-expanded', opacity: 0, visible: false});
        this._content.add_child(this._expanded);

        // размеры считаются после добавления на экран (start())
        this._w = new Spring(0, SPRING_W);
        this._h = new Spring(this._panel, SPRING_H);
        this._m = new Spring(0, SPRING_M);
        this._t = new Spring(0, SPRING_T);   // 0 — вкладки спрятаны в капле, 1 — отделились
        this._animator = new Animator(this, dt => this._frame(dt));

        this.connect('notify::hover', () => this._onHover());
        this.connect('button-release-event', (_a, e) => this._onClick(e));
        this.connect('scroll-event', (_a, e) => this._onScroll(e));
        this.connect('key-press-event', (_a, e) => this._onKey(e));
        this.connect('destroy', () => this._onDestroy());
        Main.layoutManager.connectObject('monitors-changed', () => this._kick(true), this);
        settings.connectObject('changed::shape', () => this._kick(), this);
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

    /** Виджет с наивысшим приоритетом показывает себя по бокам от времени. */
    setCompact(leading, trailing) {
        const swap = (bin, actor) => {
            if (bin.child === actor)
                return;
            const old = bin.child;
            if (old)
                bin.set_child(null);
            actor?.get_parent()?.remove_child(actor);
            bin.set_child(actor ?? null);
        };
        swap(this._leading, leading);
        swap(this._trailing, trailing);
        this._kick();
    }

    /** Содержимое раскрытой капли. */
    setExpandedContent(actor) {
        this._expanded.destroy_all_children();
        if (actor)
            this._expanded.add_child(actor);
        this._kick();
    }

    /** Капелька вкладок под раскрытой каплей (рисуется вместе с каплей). */
    setTabs(actor) {
        if (this._tabsActor) {
            this.remove_child(this._tabsActor);
            this._tabsActor = null;
        }
        if (actor) {
            this._tabsActor = actor;
            actor.opacity = 0;
            this.add_child(actor);
        }
        this._kick();
    }

    /** Содержимое поменяло размер — пересчитать форму. */
    relayout() {
        this._kick();
    }

    _iconActor(icon, style = 'droplet-activity-icon') {
        if (!icon || icon instanceof Clutter.Actor)
            return icon ?? null;
        return typeof icon === 'string'
            ? new St.Icon({icon_name: icon, style_class: style})
            : new St.Icon({gicon: icon, style_class: style});
    }

    /**
     * Короткое событие в капле.
     * @param {object} a  icon (актёр | Gio.Icon | имя), title, subtitle, progress (0…1),
     *                    accent (цвет CSS), duration (мс), onClick, private (не показывать на блокировке)
     * @returns {boolean} показано ли
     */
    showActivity(a) {
        if (!this._started || this._state === 'expanded' || this._state === 'drop')
            return false;
        if (this.locked && a.private)
            return false;
        this._activity.destroy_all_children();
        const icon = this._iconActor(a.icon);
        if (icon)
            this._activity.add_child(icon);
        const text = vbox({y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const title = new St.Label({text: a.title ?? '', style_class: 'droplet-activity-title'});
        title.clutter_text.ellipsize = 3; // END
        text.add_child(title);
        if (a.subtitle) {
            const sub = new St.Label({text: a.subtitle, style_class: 'droplet-activity-subtitle'});
            sub.clutter_text.ellipsize = 3;
            text.add_child(sub);
        }
        if (a.progress !== undefined && a.progress !== null)
            text.add_child(this._bar(a.progress, a.accent, 'droplet-progress'));
        this._activity.add_child(text);

        this._activityOnClick = a.onClick ?? null;
        this._setState('activity');
        this._addTimeout('activity', a.duration ?? 2600, () => {
            if (this._state === 'activity')
                this._setState('compact');
        });
        return true;
    }

    _bar(value, accent, style) {
        const track = new St.Widget({style_class: style, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const fill = new St.Widget({style_class: `${style}-fill`});
        if (accent)
            fill.style = `background-color: ${accent};`;
        track.add_child(fill);
        track._fill = fill;
        track._value = Math.max(0, Math.min(1, value));
        track.connect('notify::allocation', () => {
            fill.height = track.height;
            fill.width = Math.round(track.width * track._value);
        });
        return track;
    }

    /** Громкость / яркость тонкой полоской в капле (вместо окошка GNOME). */
    showHud({icon, level, label}) {
        if (!this._started || this._state === 'expanded' || this._state === 'drop')
            return false;
        const value = Math.max(0, Math.min(1, level));
        if (this._state === 'hud' && this._hudBar) {
            // повторное нажатие — плавно двигаем полоску, а не перестраиваем
            this._hudIcon.icon_name = typeof icon === 'string' ? icon : this._hudIcon.icon_name;
            if (icon && typeof icon !== 'string')
                this._hudIcon.gicon = icon;
            this._hudBar._value = value;
            this._hudBar._fill.ease({width: Math.round(this._hudBar.width * value), duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._hudValue.text = label ?? `${Math.round(level * 100)}`;
        } else {
            this._hud.destroy_all_children();
            this._hudIcon = this._iconActor(icon ?? 'audio-volume-high-symbolic', 'droplet-hud-icon');
            this._hud.add_child(this._hudIcon);
            this._hudBar = this._bar(value, null, 'droplet-hud-bar');
            this._hud.add_child(this._hudBar);
            this._hudValue = new St.Label({text: label ?? `${Math.round(level * 100)}`, style_class: 'droplet-hud-value', y_align: Clutter.ActorAlign.CENTER});
            this._hud.add_child(this._hudValue);
            this._setState('hud');
        }
        this._addTimeout('hud', 1500, () => {
            if (this._state === 'hud')
                this._setState('compact');
        });
        return true;
    }

    /** Над каплей тащат файлы. */
    setDropHover(on, count = 0) {
        if (on) {
            this._dropLabel.text = count > 1 ? `Отпустите — ${count} файла(ов) на полку` : 'Отпустите, чтобы положить на полку';
            if (this._state !== 'drop')
                this._setState('drop');
        } else if (this._state === 'drop') {
            this._setState('compact');
        }
    }

    // ------------------------------------------------------------------ состояния

    expand() {
        if (this._state === 'expanded')
            return;
        this.onExpand?.();
        this._setState('expanded');
    }

    collapse() {
        if (this._state !== 'compact')
            this._setState('compact');
    }

    _setState(state) {
        if (state === this._state)
            return;
        const prev = this._state;
        this._state = state;
        if (prev === 'compact')
            this._setPeek(false);
        if (state === 'compact' && this.hover)
            this._addTimeout('peek', PEEK_DELAY, () => this._state === 'compact' && this.hover && this._setPeek(true));
        const layer = n => this[`_${n}`];
        for (const name of LAYERS) {
            if (name === state)
                this._fadeIn(layer(name));
            else if (name === prev)
                this._fadeOut(layer(name));
        }
        if (this._tabsActor) {
            this._tabsActor.remove_all_transitions();
            this._tabsActor.ease({
                opacity: state === 'expanded' ? 255 : 0,
                delay: state === 'expanded' ? 160 : 0,
                duration: state === 'expanded' ? 260 : 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._watchOutsideClicks(state === 'expanded');
        if (state !== 'expanded')
            this.releaseKeyboard();
        this.emit('state-changed', state);
        this._kick();
    }

    // проявление с лёгким увеличением → содержимое «всплывает» из капли
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
                if (this[`_${this._state}`] !== layer)
                    layer.visible = false;
            },
        });
    }

    // ------------------------------------------------------------------ «подглядывание»

    _setPeek(on) {
        const text = on ? this.peekProvider?.() : null;
        if (GLib.getenv('DROPLET_DEBUG'))
            log(`droplet: peek on=${on} text=${text} state=${this._state}`);
        const next = text ? this._marquee : this._clockLabel;
        if (this._center.child === next) {
            if (text)
                this._marqueeLabel.text = text;
            return;
        }
        this._marqueeLabel.remove_all_transitions();
        this._marqueeLabel.translation_x = 0;
        if (text)
            this._marqueeLabel.text = text;
        next.opacity = 0;
        this._center.set_child(next);
        next.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (text)
            this._addTimeout('marquee', 700, () => this._scrollMarquee());
        this._kick();
        // размер нового содержимого известен только после раскладки — пересчитаем ещё раз
        this._addTimeout('peek-relayout', 60, () => this._kick());
    }

    /** Бегущая строка: если текст длиннее окна — медленно уезжает влево и возвращается. */
    _scrollMarquee() {
        if (this._center.child !== this._marquee)
            return;
        const [, natural] = this._marqueeLabel.get_preferred_width(-1);
        const over = natural - this._marquee.width;
        if (over <= 4)
            return;
        const label = this._marqueeLabel;
        label.ease({
            translation_x: -over,
            duration: over * 28,
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => this._addTimeout('marquee', 1200, () => {
                label.ease({
                    translation_x: 0, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => this._addTimeout('marquee', 1500, () => this._scrollMarquee()),
                });
            }),
        });
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
        const fit = actor => this._natural(actor);
        switch (this._state) {
        case 'expanded': {
            const [w, h0] = fit(this._expanded);
            const h = h0 + (this._floating() ? 4 : 0);
            const [tw] = this._tabsActor ? fit(this._tabsActor) : [0];
            return [Math.min(Math.max(w, tw + 40, 360), maxW), Math.max(h, this._panel + 60)];
        }
        case 'activity': {
            const [w, h] = fit(this._activity);
            return [Math.min(Math.max(w + 22, 220), maxW), Math.max(this._panel, h)];
        }
        case 'hud':
            return [Math.max(fit(this._hud)[0] + 8, 300), this._panel];
        case 'drop': {
            const [w, h] = fit(this._drop);
            return [Math.max(w + 40, 380), this._panel + h + 18];
        }
        default: {
            const [w] = fit(this._compact);
            const grow = this.hover && this._center.child !== this._marquee ? HOVER_GROW : 0;
            return [w + COMPACT_PAD + grow, this._panel];
        }
        }
    }

    _retarget() {
        const [w, h] = this._targetSize();
        this._w.target = w;
        this._h.target = h;
        this._m.target = h > this._panel + 2 ? 1 : 0;
        this._t.target = this._state === 'expanded' && this._tabsActor ? 1 : 0;
    }

    /** Пересчитать цель и разбудить анимацию. `snap` — без анимации (при старте). */
    _kick(snap = false) {
        if (!this._w || !this._started || !this.get_stage())
            return;
        this._retarget();
        if (snap) {
            for (const s of [this._w, this._h, this._m, this._t])
                s.snap();
            this._apply();
            return;
        }
        this._animator.start();
    }

    _frame(dt) {
        // цель пересчитывается каждый кадр: содержимое могло измениться (текст, картинка)
        this._retarget();
        for (const s of [this._w, this._h, this._m, this._t])
            s.step(dt);
        this._apply();
        return ![this._w, this._h, this._m, this._t].every(s => s.settled);
    }

    /** Форма «остров» (парит) или «вырез» (прилегает к краю экрана). */
    _floating() {
        return this._settings.get_string('shape') === 'island';
    }

    _tabsGeometry(W, H) {
        if (!this._tabsActor)
            return null;
        const t = Math.max(0, this._t.value);
        if (t <= 0.001)
            return null;
        const [tw, th] = this._natural(this._tabsActor);
        // капелька выходит из-под капли и отрывается вниз
        const y = H - th + (th + TABS_GAP) * t;
        const w = tw * Math.min(1, 0.55 + 0.45 * t);
        return {x: FILLET + (W - w) / 2, y, w, h: th, tw};
    }

    _apply() {
        const mon = this._monitor();
        if (!mon)
            return;
        const W = Math.max(1, this._w.value);
        const H = Math.max(1, this._h.value);
        const tabs = this._tabsGeometry(W, H);
        this._tabsGeo = tabs;
        const totalW = Math.round(W + 2 * FILLET);
        // в покое в свёрнутом виде — ровно высота панели, чтобы не перекрывать окна под ней
        const moving = !(this._h.settled && this._m.settled) || this._m.value > 0.01;
        const extra = tabs ? Math.max(0, tabs.y + tabs.h - H) + 4 : 0;
        const totalH = Math.round(H + Math.max(moving ? WOBBLE_ROOM : 0, extra));
        this.set_position(Math.round(mon.x + (mon.width - totalW) / 2), mon.y);
        this.set_size(totalW, totalH);
        this._bg.set_size(totalW, totalH);
        this._bg.queue_repaint();

        const place = (layer, y) => {
            if (!layer.visible)
                return;
            const [lw, lh] = this._natural(layer);
            layer.set_position(Math.round(FILLET + (W - lw) / 2), Math.round(y(lh)));
        };
        place(this._compact, lh => (this._panel - lh) / 2);
        place(this._activity, lh => Math.max(0, (H - lh) / 2));
        place(this._hud, lh => (this._panel - lh) / 2);
        place(this._drop, () => this._panel + 4);
        place(this._expanded, () => (this._floating() ? 4 : 0));
        this._content.set_position(0, 0);
        this._content.set_size(totalW, totalH);
        this._content.set_clip(FILLET, 0, W, H);

        if (this._tabsActor) {
            if (tabs) {
                this._tabsActor.visible = true;
                this._tabsActor.set_position(Math.round(FILLET + (W - tabs.tw) / 2), Math.round(tabs.y));
            } else {
                this._tabsActor.visible = false;
            }
        }
    }

    _repaint(area) {
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        const wobble = Math.max(-9, Math.min(9, this._h.velocity * 0.012));
        drawDroplet(cr, {
            width,
            height: Math.min(height, Math.max(1, this._h.value)),
            fillet: FILLET,
            panel: this._panel,
            morph: this._m.value,
            radius: EXPANDED_RADIUS,
            wobble,
            tabs: this._tabsGeo,
            floating: this._floating(),
            color: [0, 0, 0, 1],
        });
        cr.$dispose();
    }

    // ------------------------------------------------------------------ жесты

    _onHover() {
        if (GLib.getenv('DROPLET_DEBUG'))
            log(`droplet: hover=${this.hover} state=${this._state}`);
        this._clearTimeout('collapse');
        this._clearTimeout('hover-expand');
        this._clearTimeout('peek');
        if (this.hover) {
            if (this._state === 'compact') {
                this._addTimeout('peek', PEEK_DELAY, () => this._state === 'compact' && this.hover && this._setPeek(true));
                if (this._settings.get_boolean('expand-on-hover'))
                    this._addTimeout('hover-expand', HOVER_EXPAND_DELAY + 300, () => this.expand());
            }
        } else {
            this._setPeek(false);
            if (this._state === 'expanded')
                this._watchLeave();
        }
        this._kick();
    }

    /**
     * Курсор ушёл с раскрытой капли. Сворачиваем, только если он действительно отошёл:
     * при смене вкладки капля меняет размер и может «уехать» из-под курсора — это не уход.
     */
    _watchLeave() {
        const MARGIN = 70;
        let away = 0;
        this._addTimeout('collapse', 120, function tick() {
            if (this._state !== 'expanded' || this.hover)
                return;
            const [px, py] = global.get_pointer();
            const [ax, ay] = this.get_transformed_position();
            const [aw, ah] = this.get_size();
            const near = px > ax - MARGIN && px < ax + aw + MARGIN && py < ay + ah + MARGIN;
            away = near ? 0 : away + 120;
            if (away >= COLLAPSE_DELAY && !this._holdOpen && !this._grab)
                this.collapse();
            else
                this._addTimeout('collapse', 120, tick.bind(this));
        }.bind(this));
    }

    /** Пока открыто меню виджета или идёт перетаскивание, капля не сворачивается. */
    holdOpen(hold) {
        this._holdOpen = hold;
        if (!hold && !this.hover && this._state === 'expanded')
            this._watchLeave();
    }

    /** Клавиатура для полей ввода (заметки): GNOME отдаёт её только при модальном захвате. */
    grabKeyboard(focusActor) {
        if (!this._grab) {
            this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.NORMAL});
        }
        focusActor?.grab_key_focus();
    }

    releaseKeyboard() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onClick(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            if (this.locked)
                return Clutter.EVENT_STOP;
            this.collapse();
            Main.panel.statusArea.dateMenu?.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (this._state === 'activity' && this._activityOnClick) {
            const fn = this._activityOnClick;
            this.collapse();
            fn();
        } else if (this._state !== 'expanded') {
            this.expand();
        }
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape && this._state === 'expanded') {
            this.collapse();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
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
                // в новых GNOME у события нет get_source(); актёра под курсором даёт сцена
                const src = global.stage.get_event_actor?.(e) ?? e.get_source?.() ?? null;
                if (GLib.getenv('DROPLET_DEBUG'))
                    log(`droplet: press on ${src} at ${e.get_coords()} island=${this.get_transformed_position()} size=${this.get_size()}`);
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
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(key, id);
    }

    _clearTimeout(key) {
        const id = this._timeouts.get(key);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(key);
    }

    _onDestroy() {
        for (const id of this._timeouts.values())
            GLib.source_remove(id);
        this._timeouts.clear();
        this.releaseKeyboard();
        this._watchOutsideClicks(false);
        this._settings.disconnectObject(this);
        this._animator?.destroy();
        this._animator = null;
        this._clock = null;
    }
});
