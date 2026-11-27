// События, которые капля коротко показывает сама: уведомления и заряд батареи.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const UPOWER = 'org.freedesktop.UPower';
const DISPLAY_DEVICE = '/org/freedesktop/UPower/devices/DisplayDevice';
const STATE_CHARGING = 1, STATE_DISCHARGING = 2, STATE_FULL = 4;

function stripMarkup(text) {
    return (text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export class StatusWatcher {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        // уведомления
        const tray = Main.messageTray;
        tray.connectObject('source-added', (_t, source) => this._watchSource(source), this);
        for (const source of tray.getSources?.() ?? [])
            this._watchSource(source);

        // батарея
        this._battery = null;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, UPOWER, DISPLAY_DEVICE,
            'org.freedesktop.UPower.Device', null, (_o, res) => {
                try {
                    this._battery = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    return;
                }
                this._lastState = this._prop('State');
                this._lastPct = this._prop('Percentage');
                this._battery.connect('g-properties-changed', () => this._onBattery());
            });
    }

    _watchSource(source) {
        source.connectObject('notification-added', (_s, n) => this._onNotification(source, n), this);
    }

    _onNotification(source, n) {
        if (!this._settings.get_boolean('show-notifications') || !this._desktop.get_boolean('show-banners'))
            return;
        // тихие уведомления GNOME и так не показывает; отключённые для приложения — тоже
        if (n.urgency === MessageTray.Urgency.LOW || source.policy?.showBanners === false)
            return;
        const title = stripMarkup(n.title);
        if (!title)
            return;
        // уведомление может исчезнуть раньше, чем по нему щёлкнут в капле
        let alive = true;
        n.connectObject('destroy', () => (alive = false), this);
        const shown = this._island.showActivity({
            icon: n.gicon ?? source.icon ?? 'preferences-system-notifications-symbolic',
            title,
            subtitle: stripMarkup(n.body ?? n.bannerBodyText),
            duration: 3600,
            onClick: () => {
                // приложение получает «уведомление нажато» и само открывает нужное окно;
                // activate() не зовём: у некоторых уведомлений он уничтожает их дважды
                if (alive)
                    n.emit('activated');
                else
                    Main.panel.statusArea.dateMenu?.menu.open();
            },
        });
        // показали в капле — стандартный баннер не нужен (уведомление остаётся в списке);
        // критичные GNOME всё равно покажет сам
        if (shown && this._settings.get_boolean('replace-banners') && n.urgency !== MessageTray.Urgency.CRITICAL)
            n.acknowledged = true;
    }

    _prop(name) {
        return this._battery?.get_cached_property(name)?.deepUnpack();
    }

    _onBattery() {
        if (!this._settings.get_boolean('show-battery') || !this._prop('IsPresent'))
            return;
        const state = this._prop('State');
        const pct = Math.round(this._prop('Percentage') ?? 0);
        const prevState = this._lastState, prevPct = this._lastPct ?? pct;
        this._lastState = state;
        this._lastPct = pct;
        const show = (icon, title, subtitle, accent) => this._island.showActivity({
            icon, title, subtitle, progress: pct / 100, accent, duration: 2800,
        });
        if (state === STATE_CHARGING && prevState !== STATE_CHARGING)
            show('battery-good-charging-symbolic', `Заряжается · ${pct}%`, null, '#34c759');
        else if (state === STATE_FULL && prevState !== STATE_FULL)
            show('battery-full-charged-symbolic', 'Полностью заряжено', null, '#34c759');
        else if (state === STATE_DISCHARGING && [20, 10, 5].some(l => pct <= l && prevPct > l))
            show('battery-caution-symbolic', `Низкий заряд · ${pct}%`, 'Подключите зарядку', '#ff453a');
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources?.() ?? [])
            source.disconnectObject(this);
        this._battery = null;
        this._desktop = null;
    }
}
