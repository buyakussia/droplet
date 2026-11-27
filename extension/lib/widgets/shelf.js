// Виджет «Полка файлов»: всё, что вы копируете в файловом менеджере (Ctrl+C), появляется
// в капле. Отсюда файл можно открыть, показать в папке или снова положить в буфер и вставить
// в другую папку.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import {vbox} from '../util.js';

const MIME_GNOME = 'x-special/gnome-copied-files';
const MIME_URIS = 'text/uri-list';

function parseUris(text, gnome) {
    let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (gnome && (lines[0] === 'copy' || lines[0] === 'cut'))
        lines = lines.slice(1);
    return lines.filter(l => !l.startsWith('#') && l.includes('://'));
}

export class ShelfWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this._settings = ctx.settings;
        this._ignoreUntil = 0;
        this.compactLeading = null;
        this.compactTrailing = null;

        this.card = vbox({style_class: 'droplet-card droplet-shelf'});
        const head = new St.BoxLayout({style_class: 'droplet-card-head'});
        head.add_child(new St.Icon({icon_name: 'folder-documents-symbolic', style_class: 'droplet-card-icon'}));
        this._title = new St.Label({text: 'Полка', style_class: 'droplet-card-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._title);
        this._copyAll = new St.Button({style_class: 'droplet-chip', label: 'Копировать всё', can_focus: true});
        this._copyAll.connect('clicked', () => this._copy(this._files()));
        head.add_child(this._copyAll);
        this._clear = new St.Button({style_class: 'droplet-chip', label: 'Очистить', can_focus: true});
        this._clear.connect('clicked', () => this._settings.set_strv('shelf-files', []));
        head.add_child(this._clear);
        this.card.add_child(head);

        this._grid = new St.Widget({
            style_class: 'droplet-shelf-grid',
            layout_manager: new Clutter.FlowLayout({column_spacing: 6, row_spacing: 6, homogeneous: true, max_column_width: 82}),
            x_expand: true,
        });
        this.card.add_child(this._grid);
        this._empty = new St.Label({text: 'Скопируйте файлы (Ctrl+C) —\nони появятся здесь', style_class: 'droplet-dim droplet-shelf-empty'});
        this.card.add_child(this._empty);

        this._settings.connectObject('changed::shelf-files', () => this._fill(), this);
        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed', (_s, type, source) => this._onOwner(type, source), this);
        this._fill();
    }

    compactPriority() {
        return 0;
    }

    _files() {
        return this._settings.get_strv('shelf-files');
    }

    _onOwner(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
            return;
        if (GLib.get_monotonic_time() < this._ignoreUntil)
            return;
        const mimes = source.get_mimetypes();
        const mime = mimes.includes(MIME_GNOME) ? MIME_GNOME : mimes.includes(MIME_URIS) ? MIME_URIS : null;
        if (!mime)
            return;
        St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, mime, (_c, bytes) => {
            const data = bytes?.get_data?.() ?? bytes;
            if (!data || !data.length)
                return;
            const uris = parseUris(new TextDecoder().decode(data), mime === MIME_GNOME)
                .filter(u => u.startsWith('file://'));
            if (uris.length)
                this._add(uris);
        });
    }

    _add(uris) {
        const limit = Math.max(1, this._settings.get_int('shelf-limit'));
        const rest = this._files().filter(u => !uris.includes(u));
        this._settings.set_strv('shelf-files', [...uris, ...rest].slice(0, limit));

        const first = Gio.File.new_for_uri(uris[0]);
        const n = uris.length;
        const word = n % 10 === 1 && n % 100 !== 11 ? 'файл' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'файла' : 'файлов');
        this._ctx.island.showActivity({
            icon: this._icon(first),
            title: n === 1 ? first.get_basename() : `${n} ${word} на полке`,
            subtitle: n === 1 ? 'На полке — нажмите, чтобы открыть' : 'Нажмите, чтобы открыть полку',
            duration: 2200,
            onClick: () => this._ctx.island.expand(),
        });
    }

    _icon(file) {
        try {
            const info = file.query_info('standard::icon,thumbnail::path', Gio.FileQueryInfoFlags.NONE, null);
            const thumb = info.get_attribute_byte_string('thumbnail::path');
            if (thumb)
                return Gio.FileIcon.new(Gio.File.new_for_path(thumb));
            return info.get_icon();
        } catch (e) {
            return Gio.ThemedIcon.new('text-x-generic');
        }
    }

    /** Положить файлы в буфер обмена, чтобы вставить их в другой папке. */
    _copy(uris) {
        if (!uris.length)
            return;
        this._ignoreUntil = GLib.get_monotonic_time() + 1e6;
        const text = `copy\n${uris.join('\n')}`;
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, MIME_GNOME,
            new GLib.Bytes(new TextEncoder().encode(text)));
        this._ctx.island.collapse();
        this._ctx.island.showActivity({
            icon: 'edit-copy-symbolic',
            title: uris.length === 1 ? 'Файл скопирован' : `Скопировано файлов: ${uris.length}`,
            subtitle: 'Вставьте его в нужную папку (Ctrl+V)',
            duration: 1800,
        });
    }

    _open(uri) {
        this._ctx.island.collapse();
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(e, 'droplet: open');
        }
    }

    _showInFolder(uri) {
        this._ctx.island.collapse();
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _remove(uri) {
        this._settings.set_strv('shelf-files', this._files().filter(u => u !== uri));
    }

    _tile(uri) {
        const file = Gio.File.new_for_uri(uri);
        const tile = new St.Button({style_class: 'droplet-tile', can_focus: true, reactive: true, track_hover: true});
        const box = vbox({x_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({gicon: this._icon(file), style_class: 'droplet-tile-icon', x_align: Clutter.ActorAlign.CENTER}));
        const name = new St.Label({text: file.get_basename() ?? uri, style_class: 'droplet-tile-name', x_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.ellipsize = 2; // MIDDLE
        box.add_child(name);

        // кнопки появляются при наведении
        const actions = new St.BoxLayout({style_class: 'droplet-tile-actions', opacity: 0, x_align: Clutter.ActorAlign.CENTER});
        const mini = (icon, tip, fn) => {
            const b = new St.Button({style_class: 'droplet-mini-button', child: new St.Icon({icon_name: icon}), accessible_name: tip});
            b.connect('clicked', fn);
            actions.add_child(b);
        };
        mini('edit-copy-symbolic', 'Скопировать', () => this._copy([uri]));
        mini('folder-open-symbolic', 'Показать в папке', () => this._showInFolder(uri));
        mini('window-close-symbolic', 'Убрать с полки', () => this._remove(uri));
        box.add_child(actions);
        tile.set_child(box);
        tile.connect('notify::hover', () => actions.ease({opacity: tile.hover ? 255 : 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD}));
        tile.connect('clicked', () => this._open(uri));
        return tile;
    }

    _fill() {
        this._grid.destroy_all_children();
        const files = this._files().filter(u => Gio.File.new_for_uri(u).query_exists(null));
        for (const uri of files)
            this._grid.add_child(this._tile(uri));
        const has = files.length > 0;
        this._grid.visible = has;
        this._empty.visible = !has;
        this._copyAll.visible = has;
        this._clear.visible = has;
        this._title.text = has ? `Полка · ${files.length}` : 'Полка';
    }

    onStateChanged(state) {
        if (state === 'expanded')
            this._fill();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._selection.disconnectObject(this);
        this.card.destroy();
    }
}
