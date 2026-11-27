// Вкладка «Система»: процессор, память, видеокарта (если доступна), диск, батарея, сеть.
// Данные читаются из /proc и /sys раз в 1,5 с — и только пока вкладка открыта.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {vbox} from '../util.js';

function read(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

function human(bytes) {
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0;
    while (bytes >= 1024 && i < u.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes < 10 && i ? bytes.toFixed(1) : Math.round(bytes)} ${u[i]}`;
}

function findGpuBusy() {
    for (let i = 0; i < 4; i++) {
        const p = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
        if (GLib.file_test(p, GLib.FileTest.EXISTS))
            return p;
    }
    return null;
}

function findBattery() {
    try {
        const dir = Gio.File.new_for_path('/sys/class/power_supply');
        const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null))) {
            const name = info.get_name();
            if ((read(`/sys/class/power_supply/${name}/type`) ?? '').trim() === 'Battery')
                return `/sys/class/power_supply/${name}`;
        }
    } catch (e) {}
    return null;
}

class Tile {
    constructor(icon, title, accent) {
        this.actor = vbox({style_class: 'droplet-stat', x_expand: true});
        const head = new St.BoxLayout({style_class: 'droplet-stat-head'});
        head.add_child(new St.Icon({icon_name: icon, style_class: 'droplet-stat-icon'}));
        head.add_child(new St.Label({text: title, style_class: 'droplet-stat-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this.value = new St.Label({style_class: 'droplet-stat-value', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this.value);
        this.actor.add_child(head);
        this.track = new St.Widget({style_class: 'droplet-stat-bar', x_expand: true});
        this.fill = new St.Widget({style_class: 'droplet-stat-fill', style: `background-color: ${accent};`});
        this.track.add_child(this.fill);
        this.actor.add_child(this.track);
        this.sub = new St.Label({style_class: 'droplet-stat-sub'});
        this.actor.add_child(this.sub);
        this._frac = 0;
        this.track.connect('notify::allocation', () => this._place(false));
    }

    set(frac, value, sub = '') {
        this._frac = Math.max(0, Math.min(1, frac));
        this.value.text = value;
        this.sub.text = sub;
        this._place(true);
    }

    _place(animate) {
        const w = Math.round(this.track.width * this._frac);
        this.fill.height = this.track.height;
        if (animate)
            this.fill.ease({width: w, duration: 500, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this.fill.width = w;
    }
}

export class SystemWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this.lockSafe = false;
        this.compactLeading = null;
        this.compactTrailing = null;
        this._timer = 0;
        this._gpu = findGpuBusy();
        this._battery = findBattery();

        this.page = vbox({style_class: 'droplet-page-system'});
        const grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({column_spacing: 8, row_spacing: 8, column_homogeneous: true}),
            style_class: 'droplet-stats',
        });
        const layout = grid.layout_manager;
        this._tiles = {
            cpu: new Tile('computer-symbolic', 'ЦП', '#ff9f6b'),
            ram: new Tile('drive-multidisk-symbolic', 'Память', '#64d2ff'),
            gpu: new Tile('video-display-symbolic', 'ГП', '#bf5af2'),
            disk: new Tile('drive-harddisk-symbolic', 'Диск', '#ffd60a'),
            battery: new Tile('battery-good-symbolic', 'Батарея', '#30d158'),
            net: new Tile('network-wireless-symbolic', 'Сеть', '#0a84ff'),
        };
        const order = ['cpu', 'ram', 'gpu', 'disk', 'battery', 'net']
            .filter(k => (k !== 'gpu' || this._gpu) && (k !== 'battery' || this._battery));
        order.forEach((k, i) => layout.attach(this._tiles[k].actor, i % 3, Math.floor(i / 3), 1, 1));
        this.page.add_child(grid);
        this._prevCpu = null;
        this._prevNet = null;
    }

    compactPriority() {
        return 0;
    }

    _cpu() {
        const line = (read('/proc/stat') ?? '').split('\n')[0];
        const v = line.split(/\s+/).slice(1).map(Number);
        const idle = v[3] + (v[4] || 0);
        const total = v.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total === prev.total)
            return 0;
        return 1 - (idle - prev.idle) / (total - prev.total);
    }

    _mem() {
        const m = {};
        for (const l of (read('/proc/meminfo') ?? '').split('\n')) {
            const [k, v] = l.split(':');
            if (v)
                m[k] = parseInt(v) * 1024;
        }
        const total = m.MemTotal ?? 1;
        const used = total - (m.MemAvailable ?? 0);
        return {used, total};
    }

    _net() {
        let rx = 0, tx = 0;
        for (const l of (read('/proc/net/dev') ?? '').split('\n').slice(2)) {
            const [name, rest] = l.split(':');
            if (!rest || name.trim() === 'lo')
                continue;
            const v = rest.trim().split(/\s+/).map(Number);
            rx += v[0];
            tx += v[8];
        }
        const now = GLib.get_monotonic_time();
        const prev = this._prevNet;
        this._prevNet = {rx, tx, now};
        if (!prev)
            return {down: 0, up: 0};
        const dt = (now - prev.now) / 1e6 || 1;
        return {down: (rx - prev.rx) / dt, up: (tx - prev.tx) / dt};
    }

    _update() {
        const t = this._tiles;
        const cpu = this._cpu();
        t.cpu.set(cpu, `${Math.round(cpu * 100)}%`, `${GLib.get_num_processors()} потоков`);
        const mem = this._mem();
        t.ram.set(mem.used / mem.total, `${Math.round(mem.used / mem.total * 100)}%`, `${human(mem.used)} из ${human(mem.total)}`);
        if (this._gpu) {
            const g = parseInt(read(this._gpu) ?? '0') / 100;
            t.gpu.set(g, `${Math.round(g * 100)}%`, 'загрузка');
        }
        try {
            const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::free', null);
            const size = info.get_attribute_uint64('filesystem::size');
            const free = info.get_attribute_uint64('filesystem::free');
            t.disk.set((size - free) / size, `${Math.round((size - free) / size * 100)}%`, `свободно ${human(free)}`);
        } catch (e) {}
        if (this._battery) {
            const cap = parseInt(read(`${this._battery}/capacity`) ?? '0');
            const status = (read(`${this._battery}/status`) ?? '').trim();
            const word = {Charging: 'заряжается', Discharging: 'от батареи', Full: 'заряжена', 'Not charging': 'не заряжается'}[status] ?? status;
            t.battery.set(cap / 100, `${cap}%`, word);
        }
        const net = this._net();
        const peak = Math.max(net.down, net.up);
        t.net.set(Math.min(1, peak / (10 * 1024 * 1024)), `↓ ${human(net.down)}/с`, `↑ ${human(net.up)}/с`);
        this._ctx.relayout();
    }

    _run(on) {
        if (on && !this._timer) {
            this._update();
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    onPageShown(shown) {
        this._shown = shown;
        this._run(shown);
    }

    onStateChanged(state) {
        this._run(state === 'expanded' && this._shown);
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this.page.destroy();
    }
}
