// Вкладка «Заметки»: маленький блокнот прямо в капле. Текст сохраняется сам.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {vbox} from '../util.js';

export class NotesWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this.lockSafe = false;
        this.compactLeading = null;
        this.compactTrailing = null;
        this._saveId = 0;

        this.page = vbox({style_class: 'droplet-page-notes'});
        const head = new St.BoxLayout({style_class: 'droplet-card-head'});
        head.add_child(new St.Icon({icon_name: 'document-edit-symbolic', style_class: 'droplet-card-icon'}));
        head.add_child(new St.Label({text: 'Заметки', style_class: 'droplet-card-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const copy = new St.Button({style_class: 'droplet-chip', label: 'Копировать', can_focus: true});
        copy.connect('clicked', () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._entry.text));
        head.add_child(copy);
        this.page.add_child(head);

        this._entry = new St.Entry({
            style_class: 'droplet-notes-entry',
            hint_text: 'Запишите мысль…',
            can_focus: true,
            x_expand: true,
        });
        const text = this._entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = 2; // WORD_CHAR
        this._entry.text = ctx.settings.get_string('notes');
        text.connect('text-changed', () => this._scheduleSave());
        // GNOME отдаёт клавиатуру панели только при захвате — берём его по щелчку в поле
        this._entry.connect('button-press-event', () => {
            ctx.island.grabKeyboard(text);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('key-focus-in', () => ctx.island.grabKeyboard(null));
        // St.Entry ставит текст по центру своей высоты, поэтому высоту даёт «лист» вокруг,
        // а поле растёт вместе с текстом и прижато к верху
        this._sheet = vbox({style_class: 'droplet-notes-sheet', reactive: true});
        this._entry.y_align = Clutter.ActorAlign.START;
        this._sheet.add_child(this._entry);
        this._sheet.connect('button-press-event', () => {
            ctx.island.grabKeyboard(text);
            return Clutter.EVENT_STOP;
        });
        this.page.add_child(this._sheet);
        this.page.add_child(new St.Label({text: 'Esc — свернуть каплю', style_class: 'droplet-hint'}));
    }

    compactPriority() {
        return 0;
    }

    _scheduleSave() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._saveId = 0;
            this._ctx.settings.set_string('notes', this._entry.text);
            return GLib.SOURCE_REMOVE;
        });
        this._ctx.relayout();
    }

    onPageShown(shown) {
        if (!shown)
            this._ctx.island.releaseKeyboard();
    }

    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._ctx.settings.set_string('notes', this._entry.text);
        }
        this.page.destroy();
    }
}
