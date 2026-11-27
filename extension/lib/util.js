// Совместимость между версиями GNOME Shell.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

// В GNOME 48 у St.BoxLayout появилось свойство orientation, а vertical устарело.
const HAS_ORIENTATION = (() => {
    try {
        new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL}).destroy();
        return true;
    } catch (e) {
        return false;
    }
})();

/** Вертикальный St.BoxLayout в любой версии GNOME. */
export function vbox(params = {}) {
    return HAS_ORIENTATION
        ? new St.BoxLayout({...params, orientation: Clutter.Orientation.VERTICAL})
        : new St.BoxLayout({...params, vertical: true});
}
