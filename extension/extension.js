// Droplet — «капля» в стиле Dynamic Island на месте часов GNOME.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Island} from './lib/island.js';
import {Registry} from './lib/registry.js';
import {dropSession} from './lib/art.js';

export default class DropletExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._island = new Island(this._settings);
        Main.layoutManager.addTopChrome(this._island, {affectsInputRegion: true, trackFullscreen: true});
        this._registry = new Registry(this._island, this._settings, this);
        this._island.start();

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
