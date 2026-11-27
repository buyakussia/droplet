// Виджет «Звук»: громкость и быстрый выбор устройства вывода
// (наушники, колонки, HDMI, Bluetooth). Использует тот же микшер, что и меню GNOME.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {vbox} from '../util.js';

const ICONS = ['audio-volume-muted-symbolic', 'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic', 'audio-volume-high-symbolic'];

function volumeIcon(frac, muted) {
    if (muted || frac <= 0)
        return ICONS[0];
    return ICONS[Math.min(3, 1 + Math.floor(frac * 3))];
}

export class AudioWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this._control = Volume.getMixerControl();
        this._stream = null;
        this._silent = true; // не показывать «устройство сменилось» сразу после запуска
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this._silent = false;
            return GLib.SOURCE_REMOVE;
        });

        this.compactLeading = null;
        this.compactTrailing = null;

        this.card = vbox({style_class: 'droplet-card droplet-audio'});
        const head = new St.BoxLayout({style_class: 'droplet-card-head'});
        this._icon = new St.Icon({icon_name: ICONS[2], style_class: 'droplet-card-icon'});
        head.add_child(this._icon);
        head.add_child(new St.Label({text: 'Звук', style_class: 'droplet-card-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._percent = new St.Label({style_class: 'droplet-card-value', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._percent);
        this.card.add_child(head);

        this._slider = new Slider.Slider(0);
        this._slider.add_style_class_name('droplet-slider');
        this._slider.connect('notify::value', () => this._onSlider());
        this._slider.connect('drag-begin', () => this._ctx.island.holdOpen(true));
        this._slider.connect('drag-end', () => this._ctx.island.holdOpen(false));
        this.card.add_child(this._slider);

        this._devices = vbox({style_class: 'droplet-devices'});
        const scroll = new St.ScrollView({style_class: 'droplet-devices-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        scroll.set_child(this._devices);
        this.card.add_child(scroll);

        this._control.connectObject(
            'state-changed', () => this._sync(),
            'default-sink-changed', () => this._bindStream(),
            'output-added', () => this._fillDevices(),
            'output-removed', () => this._fillDevices(),
            'active-output-update', (_c, id) => this._onActiveDevice(id),
            this);
        this._bindStream();
        this._fillDevices();

        // колесо мыши над свёрнутой каплей — громкость
        ctx.island.onScroll = delta => this.nudge(delta);
    }

    compactPriority() {
        return 0;
    }

    _max() {
        return this._control.get_vol_max_norm();
    }

    _bindStream() {
        this._stream?.disconnectObject(this);
        this._stream = this._control.get_default_sink();
        this._stream?.connectObject('notify::volume', () => this._sync(), 'notify::is-muted', () => this._sync(), this);
        this._sync();
    }

    _frac() {
        const s = this._stream;
        return s ? s.volume / this._max() : 0;
    }

    _sync() {
        const s = this._stream;
        const frac = this._frac();
        this._syncing = true;
        this._slider.value = Math.min(1, frac);
        this._syncing = false;
        this._percent.text = s ? `${Math.round(frac * 100)}%` : '';
        this._icon.icon_name = volumeIcon(frac, s?.is_muted);
    }

    _onSlider() {
        if (this._syncing || !this._stream)
            return;
        const s = this._stream;
        const v = this._slider.value * this._max();
        if (s.is_muted && v > 0)
            s.change_is_muted(false);
        s.volume = v;
        s.push_volume();
    }

    /** Громкость колесом над каплей: ±5% и короткий индикатор в капле. */
    nudge(delta) {
        const s = this._stream;
        if (!s)
            return;
        const frac = Math.max(0, Math.min(1, this._frac() + 0.05 * Math.sign(delta)));
        if (s.is_muted)
            s.change_is_muted(false);
        s.volume = frac * this._max();
        s.push_volume();
        this._ctx.island.showActivity({
            icon: volumeIcon(frac, false),
            title: `Громкость ${Math.round(frac * 100)}%`,
            progress: frac,
            duration: 1200,
        });
    }

    _outputs() {
        // в Gvc нет списка устройств — перебираем id (их немного и они небольшие)
        const list = [];
        for (let id = 0; id < 256; id++) {
            const d = this._control.lookup_output_id(id);
            if (d)
                list.push(d);
        }
        return list;
    }

    _activeId() {
        const sink = this._control.get_default_sink();
        const dev = sink ? this._control.lookup_device_from_stream(sink) : null;
        return dev ? dev.get_id() : -1;
    }

    _fillDevices() {
        this._devices.destroy_all_children();
        const active = this._activeId();
        for (const d of this._outputs()) {
            const row = new St.Button({style_class: 'droplet-device', can_focus: true, x_expand: true});
            const box = new St.BoxLayout();
            const gicon = d.get_gicon?.();
            box.add_child(gicon
                ? new St.Icon({gicon, style_class: 'droplet-device-icon'})
                : new St.Icon({icon_name: d.get_icon_name() || 'audio-speakers-symbolic', style_class: 'droplet-device-icon'}));
            const label = new St.Label({text: d.get_description() || d.get_origin() || '?', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = 3;
            box.add_child(label);
            const check = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'droplet-device-check', opacity: d.get_id() === active ? 255 : 0});
            box.add_child(check);
            row.set_child(box);
            if (d.get_id() === active)
                row.add_style_class_name('active');
            row.connect('clicked', () => this._control.change_output(d));
            this._devices.add_child(row);
        }
        if (!this._devices.get_n_children())
            this._devices.add_child(new St.Label({text: 'Нет устройств вывода', style_class: 'droplet-dim'}));
    }

    _onActiveDevice(id) {
        this._fillDevices();
        const d = this._control.lookup_output_id(id);
        if (!d || this._silent || this._ctx.island.state === 'expanded')
            return;
        const gicon = d.get_gicon?.();
        this._ctx.island.showActivity({
            icon: gicon ?? (d.get_icon_name() || 'audio-speakers-symbolic'),
            title: d.get_description() || 'Звук',
            subtitle: 'Устройство вывода звука',
            duration: 2400,
        });
    }

    onStateChanged(state) {
        if (state === 'expanded')
            this._fillDevices();
    }

    destroy() {
        this._control.disconnectObject(this);
        this._stream?.disconnectObject(this);
        if (this._ctx.island.onScroll)
            this._ctx.island.onScroll = null;
        this.card.destroy();
    }
}
