// Набор виджетов: создаёт включённые в настройках, собирает раскрытую каплю
// (шапка с датой + карточки по порядку) и решает, кто показывается в свёрнутом виде.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AudioWidget} from './widgets/audio.js';
import {MediaWidget} from './widgets/media.js';
import {ShelfWidget} from './widgets/shelf.js';
import {StatusWatcher} from './status.js';
import {vbox} from './util.js';

const CLASSES = {media: MediaWidget, audio: AudioWidget, shelf: ShelfWidget};

export class Registry {
    constructor(island, settings, extension) {
        this._island = island;
        this._settings = settings;
        this._extension = extension;
        this._widgets = [];
        this._status = new StatusWatcher(island, settings);
        settings.connectObject('changed::widgets', () => this._build(), this);
        island.connectObject('state-changed', (_i, state) => {
            for (const w of this._widgets)
                w.onStateChanged?.(state);
            if (state === 'expanded')
                this._syncDate();
        }, this);
        this._build();
    }

    _ctx() {
        return {island: this._island, settings: this._settings, compactChanged: () => this._updateCompact()};
    }

    _build() {
        this._destroyWidgets();
        for (const id of this._settings.get_strv('widgets')) {
            const Cls = CLASSES[id];
            if (!Cls)
                continue;
            try {
                this._widgets.push(new Cls(this._ctx()));
            } catch (e) {
                logError(e, `droplet: widget ${id}`);
            }
        }
        this._island.setExpandedContent(this._layout());
        this._updateCompact();
    }

    _layout() {
        const root = vbox({style_class: 'droplet-layout'});

        // шапка в полосе панели: дата слева, кнопки справа
        const head = new St.BoxLayout({style_class: 'droplet-head'});
        this._date = new St.Label({style_class: 'droplet-date', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._date);
        const button = (icon, tip, fn) => {
            const b = new St.Button({style_class: 'droplet-head-button', child: new St.Icon({icon_name: icon}), accessible_name: tip, can_focus: true});
            b.connect('clicked', fn);
            head.add_child(b);
        };
        button('x-office-calendar-symbolic', 'Календарь и уведомления', () => {
            this._island.collapse();
            Main.panel.statusArea.dateMenu?.menu.open();
        });
        button('emblem-system-symbolic', 'Настройки капли', () => {
            this._island.collapse();
            this._extension.openPreferences();
        });
        root.add_child(head);
        this._syncDate();

        const row = new St.BoxLayout({style_class: 'droplet-cards'});
        for (const w of this._widgets)
            row.add_child(w.card);
        if (!this._widgets.length)
            row.add_child(new St.Label({text: 'Включите виджеты в настройках капли', style_class: 'droplet-dim'}));
        root.add_child(row);
        return root;
    }

    _syncDate() {
        if (this._date)
            this._date.text = GLib.DateTime.new_now_local().format('%A, %-d %B');
    }

    _updateCompact() {
        let best = null, prio = 0;
        for (const w of this._widgets) {
            const p = w.compactPriority?.() ?? 0;
            if (p > prio) {
                prio = p;
                best = w;
            }
        }
        this._island.setCompact(best?.compactLeading ?? null, best?.compactTrailing ?? null);
    }

    _destroyWidgets() {
        // сначала виджеты (они уничтожают свои карточки), потом пустая раскладка
        this._island.setCompact(null, null);
        for (const w of this._widgets) {
            try {
                w.destroy();
            } catch (e) {
                logError(e, 'droplet: destroy widget');
            }
        }
        this._island.setExpandedContent(null);
        this._widgets = [];
        this._date = null;
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._island.disconnectObject(this);
        this._destroyWidgets();
        this._status.destroy();
    }
}
