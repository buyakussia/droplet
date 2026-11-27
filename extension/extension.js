// Droplet — «капля» в стиле Dynamic Island на месте часов GNOME.
// Работает и на экране блокировки (session-modes: unlock-dialog): там видны только
// безопасные вкладки (плеер, таймер), а уведомления и файлы скрыты.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Island} from './lib/island.js';
import {Registry} from './lib/registry.js';
import {dropSession} from './lib/art.js';

/**
 * Добавить каплю поверх окон. В GNOME 46–47 нужно явно попросить, чтобы она принимала щелчки
 * (affectsInputRegion); в новых версиях этого параметра нет — там это поведение по умолчанию.
 * GNOME сначала добавляет актёра и только потом проверяет параметры, поэтому при ошибке
 * убираем его и пробуем снова.
 */
function addTopChrome(actor) {
    const variants = [
        {affectsInputRegion: true, trackFullscreen: true},
        {trackFullscreen: true},
    ];
    let error = null;
    for (const params of variants) {
        try {
            Main.layoutManager.addTopChrome(actor, params);
            return;
        } catch (e) {
            error = e;
            actor.get_parent()?.remove_child(actor);
        }
    }
    throw error;
}

export default class DropletExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._island = new Island(this._settings);
        addTopChrome(this._island);
        this._registry = new Registry(this._island, this._settings, this);
        this._island.start();

        // только для автоматических тестов: режим экрана блокировки
        if (Number(GLib.getenv('DROPLET_TEST_LOCK') ?? 0) > 0) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(GLib.getenv('DROPLET_TEST_LOCK')), () => {
                Main.sessionMode.pushMode('unlock-dialog');
                return GLib.SOURCE_REMOVE;
            });
        }
        // только для автоматических тестов: вызвать системное окошко громкости
        if (Number(GLib.getenv('DROPLET_TEST_OSD') ?? 0) > 0) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(GLib.getenv('DROPLET_TEST_OSD')), () => {
                const icon = Gio.ThemedIcon.new('audio-volume-medium-symbolic');
                if (Main.osdWindowManager.show.length >= 5 || Main.osdWindowManager.showOne === undefined)
                    Main.osdWindowManager.show(-1, icon, null, 0.45, 1);
                else
                    Main.osdWindowManager.showAll(icon, null, 0.45, 1);
                return GLib.SOURCE_REMOVE;
            });
        }

        // часы GNOME прячем, но не убираем: их меню (календарь и уведомления)
        // открывается правым кликом по капле и кнопкой в раскрытой капле
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu?.container.set_opacity(0);
    }

    disable() {
        this._dateMenu?.container.set_opacity(255);
        this._dateMenu = null;
        this._registry?.destroy();
        this._registry = null;
        // destroy() сам убирает каплю из слоёв GNOME (и останавливает анимацию до этого)
        this._island?.destroy();
        this._island = null;
        dropSession();
        this._settings = null;
    }
}
