// Прозрачная верхняя панель GNOME. Как только окно касается панели (развёрнуто или придвинуто
// вплотную), панель снова становится непрозрачной — чтобы её было удобно читать.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CLASS = 'droplet-transparent';

export class PanelStyle {
    constructor(settings) {
        this._settings = settings;
        this._idle = 0;
        settings.connectObject('changed::transparent-panel', () => this._queue(), this);
        global.display.connectObject('window-created', (_d, w) => this._watchWindow(w), this);
        global.workspace_manager.connectObject('active-workspace-changed', () => this._queue(), this);
        global.window_manager.connectObject('switch-workspace', () => this._queue(), this);
        Main.overview.connectObject('showing', () => this._queue(), 'hidden', () => this._queue(), this);
        Main.sessionMode.connectObject('updated', () => this._queue(), this);
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);
        this._update();
    }

    _watchWindow(win) {
        if (!win)
            return;
        win.connectObject(
            'position-changed', () => this._queue(),
            'size-changed', () => this._queue(),
            'notify::minimized', () => this._queue(),
            'workspace-changed', () => this._queue(),
            'unmanaged', () => {
                win.disconnectObject(this);
                this._queue();
            },
            this);
        this._queue();
    }

    _queue() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Касается ли какое-нибудь окно панели на основном мониторе. */
    _touching() {
        const panelBottom = Main.panel.get_transformed_position()[1] + Main.panel.height;
        const ws = global.workspace_manager.get_active_workspace();
        return ws.list_windows().some(w =>
            w.is_on_primary_monitor() &&
            w.showing_on_its_workspace() &&
            !w.is_hidden() &&
            !w.minimized &&
            w.get_window_type() !== Meta.WindowType.DESKTOP &&
            w.get_frame_rect().y <= panelBottom + 4);
    }

    _update() {
        const want = this._settings.get_boolean('transparent-panel') &&
            !Main.sessionMode.isLocked && !this._touching();
        if (want)
            Main.panel.add_style_class_name(CLASS);
        else
            Main.panel.remove_style_class_name(CLASS);
    }

    destroy() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._settings.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        for (const actor of global.get_window_actors())
            actor.meta_window?.disconnectObject(this);
        Main.panel.remove_style_class_name(CLASS);
    }
}
