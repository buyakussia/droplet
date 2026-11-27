// Перетаскивание файлов на каплю. GNOME сообщает о любом перетаскивании (Meta.Dnd), а сами
// перетаскиваемые данные можно прочитать из DnD-выделения. Когда курсор над каплей —
// она раскрывается в «зону сброса»; если кнопку отпустили над ней — файлы идут на полку.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const HOT_W = 420;   // зона вокруг капли, в которой ловим файлы
const HOT_H = 120;

export class DropWatcher {
    constructor(island, onFiles) {
        this._island = island;
        this._onFiles = onFiles;
        this._over = false;
        this._uris = null;
        this._dnd = global.backend?.get_dnd?.();
        this._dnd?.connectObject(
            'dnd-enter', () => this._reset(),
            'dnd-position-change', (_d, x, y) => this._onMove(x, y),
            'dnd-leave', () => this._onLeave(),
            this);
    }

    _reset() {
        this._over = false;
        this._uris = null;
    }

    _hot(x, y) {
        const mon = global.display.get_monitor_geometry(global.display.get_primary_monitor());
        const cx = mon.x + mon.width / 2;
        return Math.abs(x - cx) < HOT_W / 2 && y >= mon.y && y < mon.y + HOT_H;
    }

    _onMove(x, y) {
        if (this._island.locked)
            return;
        const over = this._hot(x, y);
        if (over && !this._uris)
            this._read();
        if (over !== this._over) {
            this._over = over;
            this._island.setDropHover(over && (this._uris === null || this._uris.length > 0), this._uris?.length ?? 0);
        }
    }

    _read() {
        this._uris = [];
        const sel = global.display.get_selection();
        const type = Meta.SelectionType.SELECTION_DND;
        const mimes = sel.get_mimetypes(type);
        if (!mimes.includes('text/uri-list'))
            return;
        const out = Gio.MemoryOutputStream.new_resizable();
        sel.transfer_async(type, 'text/uri-list', -1, out, null, (s, res) => {
            try {
                s.transfer_finish(res);
                out.close(null);
                const text = new TextDecoder().decode(out.steal_as_bytes().get_data());
                this._uris = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('file://'));
                if (this._over)
                    this._island.setDropHover(this._uris.length > 0, this._uris.length);
            } catch (e) {
                this._uris = [];
            }
        });
    }

    _onLeave() {
        // «уход» перетаскивания над каплей = файлы отпустили на неё
        const dropped = this._over && this._uris?.length;
        this._island.setDropHover(false);
        if (dropped) {
            const uris = this._uris;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._onFiles(uris);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._reset();
    }

    destroy() {
        this._dnd?.disconnectObject(this);
        this._dnd = null;
    }
}
