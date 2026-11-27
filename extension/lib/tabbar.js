// Капелька вкладок под раскрытой каплей (как в Droppy).
// Подсветка активной вкладки перетекает к выбранному значку на пружине.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Animator, Spring} from './spring.js';

export const TabBar = GObject.registerClass({
    Signals: {'activate': {param_types: [GObject.TYPE_STRING]}},
}, class TabBar extends St.Widget {
    _init() {
        super._init({style_class: 'droplet-tabs', layout_manager: new Clutter.FixedLayout(), reactive: true});
        this._indicator = new St.Widget({style_class: 'droplet-tab-indicator'});
        this.add_child(this._indicator);
        this._box = new St.BoxLayout({style_class: 'droplet-tab-box'});
        this.add_child(this._box);
        this._buttons = new Map();
        this._active = null;
        this._x = new Spring(0, {stiffness: 260, damping: 22});
        this._w = new Spring(0, {stiffness: 260, damping: 22});
        this._animator = new Animator(this, dt => {
            this._x.step(dt);
            this._w.step(dt);
            this._place();
            return !(this._x.settled && this._w.settled);
        });
        this._box.connect('notify::allocation', () => this._moveTo(this._active, true));
        this.connect('destroy', () => this._animator.destroy());
    }

    vfunc_get_preferred_width(forHeight) {
        return this._box.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(forWidth) {
        return this._box.get_preferred_height(forWidth);
    }

    setTabs(tabs) {
        this._box.destroy_all_children();
        this._buttons.clear();
        for (const {id, icon, title} of tabs) {
            const b = new St.Button({
                style_class: 'droplet-tab',
                child: new St.Icon({icon_name: icon}),
                accessible_name: title,
                can_focus: true,
            });
            b.connect('clicked', () => this.emit('activate', id));
            this._box.add_child(b);
            this._buttons.set(id, b);
        }
    }

    setActive(id) {
        const prev = this._active;
        this._active = id;
        for (const [k, b] of this._buttons) {
            if (k === id)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        this._moveTo(id, prev === null);
    }

    _moveTo(id, snap) {
        const b = this._buttons.get(id);
        if (!b || !b.get_stage())
            return;
        const box = b.get_allocation_box();
        this._x.target = box.x1;
        this._w.target = box.x2 - box.x1;
        if (snap || this._w.value === 0) {
            this._x.snap();
            this._w.snap();
            this._place();
        } else {
            this._animator.start();
        }
    }

    _place() {
        const h = this._box.height;
        // подсветка слегка «растягивается» в полёте — как капля жидкости
        const stretch = Math.min(14, Math.abs(this._x.velocity) * 0.02);
        this._indicator.set_position(Math.round(this._x.value - stretch / 2), 0);
        this._indicator.set_size(Math.round(this._w.value + stretch), h);
    }
});
