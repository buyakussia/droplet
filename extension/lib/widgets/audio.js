// Вкладка «Звук»: общая громкость, устройства вывода (колонки, наушники, HDMI, Bluetooth)
// и громкость отдельно для каждого играющего приложения. Микшер — тот же, что в меню GNOME.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import * as Sound from '../sound.js';
import {vbox} from '../util.js';

function sliderRow(icon, title, holdOpen) {
    const row = vbox({style_class: 'droplet-mixer-row'});
    const head = new St.BoxLayout({style_class: 'droplet-mixer-head'});
    const ic = typeof icon === 'string'
        ? new St.Icon({icon_name: icon, style_class: 'droplet-mixer-icon'})
        : new St.Icon({gicon: icon, style_class: 'droplet-mixer-icon'});
    head.add_child(ic);
    const label = new St.Label({text: title, x_expand: true, style_class: 'droplet-mixer-name', y_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.ellipsize = 3;
    head.add_child(label);
    const value = new St.Label({style_class: 'droplet-card-value', y_align: Clutter.ActorAlign.CENTER});
    head.add_child(value);
    row.add_child(head);
    const slider = new Slider.Slider(0);
    slider.add_style_class_name('droplet-slider');
    slider.connect('drag-begin', () => holdOpen(true));
    slider.connect('drag-end', () => holdOpen(false));
    row.add_child(slider);
    return {row, slider, value, icon: ic};
}

export class AudioWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this.lockSafe = false;
        this._control = Sound.mixer();
        this._stream = null;
        this._apps = new Map();
        this._silent = true; // не показывать «устройство сменилось» сразу после запуска
        this._silentId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this._silent = false;
            this._silentId = 0;
            return GLib.SOURCE_REMOVE;
        });
        const hold = on => ctx.island.holdOpen(on);

        this.page = vbox({style_class: 'droplet-page-audio'});
        const scroll = new St.ScrollView({style_class: 'droplet-audio-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        const col = vbox({style_class: 'droplet-audio-col'});
        scroll.set_child(col);
        this.page.add_child(scroll);

        this._master = sliderRow('audio-volume-high-symbolic', 'Громкость', hold);
        this._master.slider.connect('notify::value', () => {
            if (!this._syncing)
                Sound.setStreamFrac(this._stream, this._master.slider.value);
        });
        col.add_child(this._master.row);

        col.add_child(new St.Label({text: 'Выход', style_class: 'droplet-section'}));
        this._devices = vbox({style_class: 'droplet-devices'});
        col.add_child(this._devices);

        this._appsTitle = new St.Label({text: 'Приложения', style_class: 'droplet-section'});
        col.add_child(this._appsTitle);
        this._appsBox = vbox({style_class: 'droplet-apps'});
        col.add_child(this._appsBox);

        this._control.connectObject(
            'state-changed', () => this._sync(),
            'default-sink-changed', () => this._bindStream(),
            'output-added', () => this._fillDevices(),
            'output-removed', () => this._fillDevices(),
            'active-output-update', (_c, id) => this._onActiveDevice(id),
            'stream-added', () => this._fillApps(),
            'stream-removed', () => this._fillApps(),
            this);
        this._bindStream();
        this._fillDevices();
        this._fillApps();
    }

    compactPriority() {
        return 0;
    }

    _bindStream() {
        this._stream?.disconnectObject(this);
        this._stream = Sound.defaultSink();
        this._stream?.connectObject('notify::volume', () => this._sync(), 'notify::is-muted', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const frac = Sound.streamFrac(this._stream);
        this._syncing = true;
        this._master.slider.value = Math.min(1, frac);
        this._syncing = false;
        this._master.value.text = this._stream ? `${Math.round(frac * 100)}%` : '';
        this._master.icon.icon_name = Sound.volumeIcon(frac, this._stream?.is_muted);
    }

    _fillDevices() {
        this._devices.destroy_all_children();
        const active = Sound.activeOutputId();
        for (const d of Sound.outputs()) {
            const row = new St.Button({style_class: 'droplet-device', can_focus: true, x_expand: true});
            const box = new St.BoxLayout();
            const icon = Sound.deviceIcon(d);
            box.add_child(typeof icon === 'string'
                ? new St.Icon({icon_name: icon, style_class: 'droplet-device-icon'})
                : new St.Icon({gicon: icon, style_class: 'droplet-device-icon'}));
            const label = new St.Label({text: Sound.deviceName(d), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = 3;
            box.add_child(label);
            box.add_child(new St.Icon({icon_name: 'object-select-symbolic', style_class: 'droplet-device-check', opacity: d.get_id() === active ? 255 : 0}));
            row.set_child(box);
            if (d.get_id() === active)
                row.add_style_class_name('active');
            row.connect('clicked', () => Sound.setOutput(d));
            this._devices.add_child(row);
        }
        if (!this._devices.get_n_children())
            this._devices.add_child(new St.Label({text: 'Нет устройств вывода', style_class: 'droplet-dim'}));
        this._ctx.relayout();
    }

    _appIcon(stream) {
        const id = stream.get_application_id?.();
        const app = id ? Shell.AppSystem.get_default().lookup_app(`${id}.desktop`) : null;
        if (app)
            return app.get_icon();
        return stream.get_icon_name() || 'application-x-executable-symbolic';
    }

    _fillApps() {
        for (const {stream} of this._apps.values())
            stream.disconnectObject(this);
        this._apps.clear();
        this._appsBox.destroy_all_children();
        for (const stream of Sound.appStreams()) {
            const r = sliderRow(this._appIcon(stream), stream.get_name() || stream.get_description() || 'Приложение',
                on => this._ctx.island.holdOpen(on));
            r.row.add_style_class_name('app');
            const sync = () => {
                const f = Sound.streamFrac(stream);
                r.syncing = true;
                r.slider.value = Math.min(1, f);
                r.syncing = false;
                r.value.text = `${Math.round(f * 100)}%`;
            };
            r.slider.connect('notify::value', () => {
                if (!r.syncing)
                    Sound.setStreamFrac(stream, r.slider.value);
                r.value.text = `${Math.round(r.slider.value * 100)}%`;
            });
            stream.connectObject('notify::volume', sync, this);
            sync();
            this._appsBox.add_child(r.row);
            this._apps.set(stream.get_id(), {stream, row: r});
        }
        const has = this._apps.size > 0;
        this._appsTitle.visible = true;
        if (!has)
            this._appsBox.add_child(new St.Label({text: 'Сейчас ничего не играет', style_class: 'droplet-dim'}));
        this._ctx.relayout();
    }

    _onActiveDevice(id) {
        this._fillDevices();
        const d = this._control.lookup_output_id(id);
        if (!d || this._silent || this._ctx.island.state === 'expanded')
            return;
        this._ctx.island.showActivity({
            icon: Sound.deviceIcon(d),
            title: Sound.deviceName(d),
            subtitle: 'Устройство вывода звука',
            duration: 2400,
        });
    }

    onPageShown(shown) {
        if (shown) {
            this._fillDevices();
            this._fillApps();
        }
    }

    destroy() {
        if (this._silentId)
            GLib.source_remove(this._silentId);
        this._control.disconnectObject(this);
        this._stream?.disconnectObject(this);
        for (const {stream} of this._apps.values())
            stream.disconnectObject(this);
        this.page.destroy();
    }
}
