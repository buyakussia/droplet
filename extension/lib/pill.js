// Ползунок-пилюля как в Droppy: вся строка — ползунок. Заливка показывает уровень,
// поверх — значок, название и процент. Тянуть мышью, крутить колесом.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class PillSlider {
    /**
     * @param {object} p icon (имя | Gio.Icon), title, value (0…1), onChange(v), onDrag(bool)
     */
    constructor({icon, title, value = 0, onChange, onDrag}) {
        this._onChange = onChange;
        this._onDrag = onDrag;
        this._value = value;
        this.actor = new St.Widget({
            style_class: 'droplet-pill',
            reactive: true,
            track_hover: true,
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({style_class: 'droplet-pill-fill', x_align: Clutter.ActorAlign.START, y_expand: true});
        this.actor.add_child(this._fill);
        const row = new St.BoxLayout({style_class: 'droplet-pill-row', x_expand: true});
        this._icon = typeof icon === 'string'
            ? new St.Icon({icon_name: icon, style_class: 'droplet-pill-icon'})
            : new St.Icon({gicon: icon, style_class: 'droplet-pill-icon'});
        row.add_child(this._icon);
        this._title = new St.Label({text: title, style_class: 'droplet-pill-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title.clutter_text.ellipsize = 3;
        row.add_child(this._title);
        this._percent = new St.Label({style_class: 'droplet-pill-value', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._percent);
        this.actor.add_child(row);

        this.actor.connect('notify::allocation', () => this._place(false));
        this.actor.connect('button-press-event', (_a, e) => this._press(e));
        this.actor.connect('motion-event', (_a, e) => this._motion(e));
        this.actor.connect('button-release-event', () => this._release());
        this.actor.connect('scroll-event', (_a, e) => this._scroll(e));
        this.actor.connect('destroy', () => this._release());
        this.set(value, false);
    }

    get value() {
        return this._value;
    }

    setIcon(name) {
        this._icon.icon_name = name;
    }

    /** Значение снаружи (например, громкость поменяли клавишами). */
    set(value, animate = true) {
        this._value = Math.max(0, Math.min(1, value));
        this._percent.text = `${Math.round(this._value * 100)}%`;
        this._place(animate && !this._grab);
    }

    _place(animate) {
        if (!this.actor.get_stage())
            return;
        const w = Math.round(this.actor.width * this._value);
        if (animate)
            this._fill.ease({width: w, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this._fill.width = w;
    }

    _fromEvent(e) {
        const [x] = e.get_coords();
        const [ax] = this.actor.get_transformed_position();
        const v = Math.max(0, Math.min(1, (x - ax) / Math.max(1, this.actor.width)));
        this._value = v;
        this._percent.text = `${Math.round(v * 100)}%`;
        this._place(false);
        this._onChange?.(v);
    }

    _press(e) {
        if (e.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this.actor);
        this._onDrag?.(true);
        this.actor.add_style_pseudo_class('active');
        this._fromEvent(e);
        return Clutter.EVENT_STOP;
    }

    _motion(e) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._fromEvent(e);
        return Clutter.EVENT_STOP;
    }

    _release() {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._grab.dismiss();
        this._grab = null;
        this.actor.remove_style_pseudo_class('active');
        this._onDrag?.(false);
        return Clutter.EVENT_STOP;
    }

    _scroll(e) {
        const dir = e.get_scroll_direction();
        let d = 0;
        if (dir === Clutter.ScrollDirection.UP)
            d = 1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            d = -1;
        else if (dir === Clutter.ScrollDirection.SMOOTH)
            d = -e.get_scroll_delta()[1];
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        this.set(this._value + 0.05 * Math.sign(d));
        this._onChange?.(this._value);
        return Clutter.EVENT_STOP;
    }
}
