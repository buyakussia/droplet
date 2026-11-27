// Набор виджетов: создаёт включённые в настройках, собирает раскрытую каплю
// (шапка + страница активной вкладки + капелька вкладок) и решает,
// кто показывается в свёрнутом виде и в «подглядывании».

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WIDGETS} from './catalog.js';
import {DropWatcher} from './drop.js';
import {OsdOverride} from './osd.js';
import * as Sound from './sound.js';
import {StatusWatcher} from './status.js';
import {TabBar} from './tabbar.js';
import {vbox} from './util.js';
import {AudioWidget} from './widgets/audio.js';
import {CalendarWidget} from './widgets/calendar.js';
import {ClipboardWidget} from './widgets/clipboard.js';
import {MediaWidget} from './widgets/media.js';
import {NotesWidget} from './widgets/notes.js';
import {PomodoroWidget} from './widgets/pomodoro.js';
import {ShelfWidget} from './widgets/shelf.js';
import {SystemWidget} from './widgets/system.js';

const CLASSES = {
    media: MediaWidget, calendar: CalendarWidget, audio: AudioWidget, shelf: ShelfWidget,
    clipboard: ClipboardWidget, notes: NotesWidget, pomodoro: PomodoroWidget, system: SystemWidget,
};

export class Registry {
    constructor(island, settings, extension) {
        this._island = island;
        this._settings = settings;
        this._extension = extension;
        this._widgets = new Map();
        this._active = null;

        this._status = new StatusWatcher(island, settings);
        this._osd = new OsdOverride(island, settings);
        this._drop = new DropWatcher(island, uris => this._widgets.get('shelf')?.addUris(uris));

        this._tabs = new TabBar();
        this._tabs.connect('activate', (_t, id) => this.showTab(id));
        island.setTabs(this._tabs);

        island.peekProvider = () => this._compactOwner()?.peekText?.() ?? null;
        island.onExpand = () => {
            // раскрываем на «живом» виджете (таймер, музыка), иначе — на последней вкладке
            const owner = this._compactOwner();
            const last = this._settings.get_string('active-tab');
            this.showTab(owner?.id ?? (this._visible().includes(last) ? last : this._visible()[0]), true);
        };
        island.onScroll = delta => this._nudgeVolume(delta);

        settings.connectObject('changed::widgets', () => this._build(), this);
        island.connectObject('state-changed', (_i, state) => {
            for (const w of this._widgets.values())
                w.onStateChanged?.(state);
            if (state === 'expanded')
                this._syncDate();
        }, this);
        Main.sessionMode.connectObject('updated', () => this._syncLock(), this);

        this._build();
        this._syncLock();
    }

    // ------------------------------------------------------------------ виджеты

    _ctx(id) {
        return {
            id,
            island: this._island,
            settings: this._settings,
            compactChanged: () => this._updateCompact(),
            relayout: () => this._island.relayout(),
            showTab: tab => {
                this._island.expand();
                this.showTab(tab);
            },
        };
    }

    _build() {
        this._destroyWidgets();
        for (const id of this._settings.get_strv('widgets')) {
            const Cls = CLASSES[id];
            if (!Cls || this._widgets.has(id))
                continue;
            try {
                const w = new Cls(this._ctx(id));
                w.id = id;
                this._widgets.set(id, w);
            } catch (e) {
                logError(e, `droplet: widget ${id}`);
            }
        }
        this._buildLayout();
        this._updateCompact();
    }

    /** Вкладки, которые можно показывать сейчас (на экране блокировки — только безопасные). */
    _visible() {
        return [...this._widgets.values()]
            .filter(w => !this._island.locked || w.lockSafe)
            .map(w => w.id);
    }

    _buildLayout() {
        const root = vbox({style_class: 'droplet-layout'});
        const head = new St.BoxLayout({style_class: 'droplet-head'});
        this._date = new St.Label({style_class: 'droplet-date', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._date);
        this._settingsButton = new St.Button({
            style_class: 'droplet-head-button',
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
            accessible_name: 'Настройки капли',
            can_focus: true,
        });
        this._settingsButton.connect('clicked', () => {
            this._island.collapse();
            this._extension.openPreferences();
        });
        head.add_child(this._settingsButton);
        root.add_child(head);

        this._pageBin = new St.Bin({style_class: 'droplet-page', x_align: Clutter.ActorAlign.CENTER});
        root.add_child(this._pageBin);
        if (!this._widgets.size)
            this._pageBin.set_child(new St.Label({text: 'Включите виджеты в настройках капли', style_class: 'droplet-dim'}));
        this._island.setExpandedContent(root);
        this._syncTabs();
        this._syncDate();
    }

    _syncTabs() {
        const ids = this._visible();
        this._tabs.setTabs(ids.map(id => {
            const meta = WIDGETS.find(x => x.id === id);
            return {id, icon: meta?.icon ?? 'view-grid-symbolic', title: meta?.title ?? id};
        }));
        // на экране блокировки вкладок нет: капля раскрывается сразу в плеер или таймер
        const showTabs = ids.length > 1 && !this._island.locked;
        this._tabs.visible = showTabs;
        this._island.setTabs(showTabs ? this._tabs : null);
        const want = ids.includes(this._active) ? this._active
            : ids.includes(this._settings.get_string('active-tab')) ? this._settings.get_string('active-tab') : ids[0];
        this._active = null;
        if (want)
            this.showTab(want, true);
    }

    /** Показать вкладку: страница плавно сменяется, а капля перетекает под её размер. */
    showTab(id, instant = false) {
        const w = this._widgets.get(id);
        if (!w || (this._island.locked && !w.lockSafe))
            return;
        if (this._active === id && this._pageBin.child === w.page)
            return;
        const prev = this._widgets.get(this._active);
        prev?.onPageShown?.(false);
        this._active = id;
        if (!this._island.locked)
            this._settings.set_string('active-tab', id);
        const page = w.page;
        page.get_parent()?.remove_child(page);
        this._pageBin.set_child(page);
        page.remove_all_transitions();
        page.set_pivot_point(0.5, 0);
        if (!instant) {
            page.opacity = 0;
            page.scale_x = page.scale_y = 0.97;
            page.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            page.opacity = 255;
            page.scale_x = page.scale_y = 1;
        }
        this._tabs.setActive(id);
        w.onPageShown?.(true);
        this._island.relayout();
    }

    _syncDate() {
        if (this._date)
            this._date.text = GLib.DateTime.new_now_local().format('%A, %-d %B');
    }

    _compactOwner() {
        let best = null, prio = 0;
        for (const w of this._widgets.values()) {
            if (this._island.locked && !w.lockSafe)
                continue;
            const p = w.compactPriority?.() ?? 0;
            if (p > prio) {
                prio = p;
                best = w;
            }
        }
        return best;
    }

    _updateCompact() {
        const best = this._compactOwner();
        this._island.setCompact(best?.compactLeading ?? null, best?.compactTrailing ?? null);
    }

    _nudgeVolume(delta) {
        const sink = Sound.defaultSink();
        if (!sink)
            return;
        const frac = Math.max(0, Math.min(1, Sound.streamFrac(sink) + 0.05 * Math.sign(delta)));
        Sound.setStreamFrac(sink, frac);
        this._island.showHud({icon: Sound.volumeIcon(frac), level: frac, label: `${Math.round(frac * 100)}`});
    }

    // ------------------------------------------------------------------ экран блокировки

    _syncLock() {
        const locked = Main.sessionMode.isLocked;
        if (locked === this._island.locked)
            return;
        this._island.locked = locked;
        this._island.collapse();
        this._settingsButton.visible = !locked;
        this._syncTabs();
        this._updateCompact();
    }

    // ------------------------------------------------------------------ служебное

    _destroyWidgets() {
        // сначала виджеты (они уничтожают свои страницы), потом пустая раскладка
        this._island.setCompact(null, null);
        this._pageBin?.set_child(null);
        for (const w of this._widgets.values()) {
            try {
                w.destroy();
            } catch (e) {
                logError(e, 'droplet: destroy widget');
            }
        }
        this._widgets.clear();
        this._island.setExpandedContent(null);
        this._date = null;
        this._pageBin = null;
        this._active = null;
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._island.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._drop.destroy();
        this._osd.destroy();
        this._status.destroy();
        this._island.setTabs(null);
        this._tabs.destroy();
        this._destroyWidgets();
        this._island.peekProvider = null;
        this._island.onExpand = null;
        this._island.onScroll = null;
    }
}
