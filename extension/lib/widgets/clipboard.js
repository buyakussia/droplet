// Вкладка «Буфер обмена»: последние записи из приложения Clipboard History
// (~/.local/share/clipboard-history). Щелчок — снова положить запись в буфер.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {vbox} from '../util.js';

const DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipboard-history']);
const INDEX = GLib.build_filenamev([DIR, 'index.json']);
const SHOW = 8;

export class ClipboardWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this.lockSafe = false;
        this.compactLeading = null;
        this.compactTrailing = null;

        this.page = vbox({style_class: 'droplet-page-clipboard'});
        const head = new St.BoxLayout({style_class: 'droplet-card-head'});
        head.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'droplet-card-icon'}));
        head.add_child(new St.Label({text: 'Буфер обмена', style_class: 'droplet-card-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const all = new St.Button({style_class: 'droplet-chip', label: 'Вся история', can_focus: true});
        all.connect('clicked', () => {
            this._ctx.island.collapse();
            try {
                Gio.Subprocess.new(['clipboard-history', '--toggle'], Gio.SubprocessFlags.NONE);
            } catch (e) {}
        });
        head.add_child(all);
        this.page.add_child(head);
        this._list = vbox({style_class: 'droplet-clip-list'});
        this.page.add_child(this._list);

        this._monitor = Gio.File.new_for_path(INDEX).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => {
            if (this._shown)
                this._fill();
        });
        this._fill();
    }

    compactPriority() {
        return 0;
    }

    _items() {
        try {
            const [, bytes] = GLib.file_get_contents(INDEX);
            const items = JSON.parse(new TextDecoder().decode(bytes));
            return Array.isArray(items) ? items : [];
        } catch (e) {
            return null;
        }
    }

    _fill() {
        this._list.destroy_all_children();
        const items = this._items();
        if (items === null) {
            this._list.add_child(new St.Label({
                text: 'Нужно приложение Clipboard History\n(устанавливается вместе с Lens)',
                style_class: 'droplet-dim droplet-center',
            }));
        } else if (!items.length) {
            this._list.add_child(new St.Label({text: 'Пока пусто — скопируйте что-нибудь', style_class: 'droplet-dim'}));
        }
        for (const item of (items ?? []).slice(0, SHOW))
            this._list.add_child(this._row(item));
        this._ctx.relayout();
    }

    _row(item) {
        const b = new St.Button({style_class: 'droplet-clip-row', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.FILL});
        if (item.kind === 'image') {
            const thumb = GLib.build_filenamev([DIR, 'blobs', `${item.hash}.thumb.png`]);
            const full = GLib.build_filenamev([DIR, 'blobs', `${item.hash}.png`]);
            const path = GLib.file_test(thumb, GLib.FileTest.EXISTS) ? thumb : full;
            box.add_child(new St.Widget({style_class: 'droplet-clip-thumb', style: `background-image: url("file://${path}"); background-size: cover;`}));
            box.add_child(new St.Label({text: `Картинка ${item.width}×${item.height}`, style_class: 'droplet-clip-text', y_align: Clutter.ActorAlign.CENTER}));
        } else {
            const text = (item.text ?? '').replace(/\s+/g, ' ').trim();
            const l = new St.Label({text: text.slice(0, 160), style_class: 'droplet-clip-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            l.clutter_text.ellipsize = 3;
            box.add_child(l);
        }
        if (item.pinned)
            box.add_child(new St.Icon({icon_name: 'view-pin-symbolic', style_class: 'droplet-clip-pin'}));
        b.set_child(box);
        b.connect('clicked', () => this._copy(item));
        return b;
    }

    _copy(item) {
        const cb = St.Clipboard.get_default();
        if (item.kind === 'image') {
            try {
                const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([DIR, 'blobs', `${item.hash}.png`]));
                cb.set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
            } catch (e) {
                return;
            }
        } else {
            cb.set_text(St.ClipboardType.CLIPBOARD, item.text ?? '');
        }
        this._ctx.island.collapse();
        this._ctx.island.showActivity({
            icon: 'edit-copy-symbolic',
            title: 'Скопировано',
            subtitle: 'Вставьте сочетанием Ctrl+V',
            duration: 1500,
        });
    }

    onPageShown(shown) {
        this._shown = shown;
        if (shown)
            this._fill();
    }

    destroy() {
        this._monitor.cancel();
        this.page.destroy();
    }
}
