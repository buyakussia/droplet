// Громкость и яркость в капле вместо стандартного окошка GNOME.
// Подменяем методы osdWindowManager и возвращаем их при выключении.
// Сигнатуры разные: GNOME 46 — show(monitor, icon, label, level, max);
// GNOME 48+ — show(icon, label, levels) + showOne / showAll.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class OsdOverride {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        const mgr = Main.osdWindowManager;
        this._mgr = mgr;
        this._orig = {};
        for (const name of ['show', 'showOne', 'showAll']) {
            if (typeof mgr[name] !== 'function')
                continue;
            this._orig[name] = mgr[name];
            const orig = mgr[name];
            const self = this;
            mgr[name] = function (...args) {
                if (self._handle(name, args))
                    return undefined;
                return orig.apply(this, args);
            };
        }
    }

    _handle(name, args) {
        if (!this._settings.get_boolean('hud'))
            return false;
        let icon, label, level, max;
        if (name === 'showOne' || (name === 'show' && typeof args[0] === 'number')) {
            [, icon, label, level, max] = args;
        } else if (name === 'showAll') {
            [icon, label, level, max] = args;
        } else {
            // GNOME 48+: show(icon, label, levels) — уровни по мониторам
            let levels;
            [icon, label, levels] = args;
            const entry = levels && Object.values(levels).find(Boolean);
            level = entry?.level;
            max = entry?.maxLevel;
        }
        if (level === undefined || level === null)
            return false; // например, Caps Lock без уровня — пусть покажет GNOME
        if (!max || max < 0)
            max = 1;
        const frac = Math.min(1, level / max);
        return this._island.showHud({icon, level: frac, label: `${Math.round(level * 100)}`});
    }

    destroy() {
        for (const [name, fn] of Object.entries(this._orig))
            this._mgr[name] = fn;
        this._orig = {};
    }
}
