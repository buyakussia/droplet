// Вкладка «Календарь и погода»: сегодняшняя дата, ближайшие события из календарей GNOME
// (Evolution / онлайн-аккаунты) и погода из приложения «Погода».

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Weather from 'resource:///org/gnome/shell/misc/weather.js';

import {vbox} from '../util.js';

const DAY = 24 * 3600 * 1000;

function startOfDay(d) {
    const r = new Date(d.getTime());
    r.setHours(0, 0, 0, 0);
    return r;
}

function timeOf(d) {
    return GLib.DateTime.new_from_unix_local(Math.floor(d.getTime() / 1000)).format('%H:%M');
}

export class CalendarWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this.lockSafe = false;
        this.compactLeading = null;
        this.compactTrailing = null;

        this.page = new St.BoxLayout({style_class: 'droplet-page-calendar'});
        const day = vbox({style_class: 'droplet-cal-day', y_align: Clutter.ActorAlign.START});
        this._weekday = new St.Label({style_class: 'droplet-cal-weekday'});
        this._dayNum = new St.Label({style_class: 'droplet-cal-num'});
        this._month = new St.Label({style_class: 'droplet-cal-month'});
        day.add_child(this._weekday);
        day.add_child(this._dayNum);
        day.add_child(this._month);
        this.page.add_child(day);

        const right = vbox({style_class: 'droplet-cal-right', x_expand: true});
        this._events = vbox({style_class: 'droplet-cal-events'});
        right.add_child(this._events);
        this._weather = new St.BoxLayout({style_class: 'droplet-weather', visible: false});
        this._wIcon = new St.Icon({style_class: 'droplet-weather-icon'});
        this._wTemp = new St.Label({style_class: 'droplet-weather-temp', y_align: Clutter.ActorAlign.CENTER});
        this._wPlace = new St.Label({style_class: 'droplet-weather-place', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._wPlace.clutter_text.ellipsize = 3;
        this._weather.add_child(this._wIcon);
        this._weather.add_child(this._wTemp);
        this._weather.add_child(this._wPlace);
        right.add_child(this._weather);
        this.page.add_child(right);

        try {
            this._source = new Calendar.DBusEventSource();
            this._source.connectObject('changed', () => this._syncEvents(), this);
        } catch (e) {
            this._source = null;
        }
        try {
            this._weatherClient = new Weather.WeatherClient();
            this._weatherClient.connectObject('changed', () => this._syncWeather(), this);
        } catch (e) {
            this._weatherClient = null;
        }
        this._sync();
    }

    compactPriority() {
        return 0;
    }

    _sync() {
        const now = GLib.DateTime.new_now_local();
        this._weekday.text = now.format('%A');
        this._dayNum.text = now.format('%-d');
        this._month.text = now.format('%B');
        this._from = startOfDay(new Date());
        this._to = new Date(this._from.getTime() + 2 * DAY);
        this._source?.requestRange(this._from, this._to);
        this._syncEvents();
        this._weatherClient?.update();
        this._syncWeather();
    }

    _syncEvents() {
        this._events.destroy_all_children();
        const now = Date.now();
        const list = (this._source?.getEvents(this._from, this._to) ?? [])
            .filter(e => e.end.getTime() > now)
            .sort((a, b) => a.date - b.date)
            .slice(0, 4);
        if (!list.length) {
            const msg = this._source?.hasCalendars === false ? 'Календари не подключены' : 'Сегодня и завтра — без событий';
            this._events.add_child(new St.Label({text: msg, style_class: 'droplet-dim'}));
        }
        const tomorrow = this._from.getTime() + DAY;
        for (const e of list) {
            const row = new St.BoxLayout({style_class: 'droplet-cal-event'});
            row.add_child(new St.Widget({style_class: 'droplet-cal-dot', y_align: Clutter.ActorAlign.CENTER}));
            const col = vbox({x_expand: true});
            const title = new St.Label({text: e.summary || 'Без названия', style_class: 'droplet-cal-title'});
            title.clutter_text.ellipsize = 3;
            col.add_child(title);
            const allDay = e.end - e.date >= DAY - 1000 && e.date.getHours() === 0;
            const when = allDay ? 'весь день' : `${timeOf(e.date)} – ${timeOf(e.end)}`;
            col.add_child(new St.Label({text: e.date.getTime() >= tomorrow ? `завтра, ${when}` : when, style_class: 'droplet-cal-time'}));
            row.add_child(col);
            this._events.add_child(row);
        }
        this._ctx.relayout();
    }

    _syncWeather() {
        const c = this._weatherClient;
        const info = c?.available && c.hasLocation ? c.info : null;
        if (!info || !info.is_valid?.()) {
            this._weather.visible = false;
            return;
        }
        this._weather.visible = true;
        this._wIcon.icon_name = info.get_symbolic_icon_name();
        this._wTemp.text = info.get_temp_summary();
        this._wPlace.text = info.get_location_name?.() ?? '';
        this._ctx.relayout();
    }

    onPageShown(shown) {
        if (shown)
            this._sync();
    }

    destroy() {
        this._source?.disconnectObject(this);
        this._source?.destroy?.();
        this._weatherClient?.disconnectObject(this);
        this._weatherClient = null;
        this.page.destroy();
    }
}
