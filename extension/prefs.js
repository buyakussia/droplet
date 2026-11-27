// Настройки капли: какие виджеты показывать и в каком порядке, поведение.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {WIDGETS} from './lib/catalog.js';

export default class DropletPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 640);
        const page = new Adw.PreferencesPage({title: 'Капля', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // ---------------------------------------------------------------- виджеты
        const group = new Adw.PreferencesGroup({
            title: 'Виджеты',
            description: 'Карточки в раскрытой капле. Порядок — стрелками.',
        });
        page.add(group);
        let rows = [];
        const order = () => {
            const enabled = settings.get_strv('widgets');
            const rest = WIDGETS.map(w => w.id).filter(id => !enabled.includes(id));
            return [...enabled.filter(id => WIDGETS.some(w => w.id === id)), ...rest];
        };
        const fill = () => {
            for (const r of rows)
                group.remove(r);
            rows = [];
            const ids = order();
            const enabled = settings.get_strv('widgets');
            ids.forEach((id, i) => {
                const w = WIDGETS.find(x => x.id === id);
                const row = new Adw.ActionRow({title: w.title, subtitle: w.subtitle});
                row.add_prefix(new Gtk.Image({icon_name: w.icon}));
                const move = (icon, delta, sensitive) => {
                    const b = new Gtk.Button({icon_name: icon, valign: Gtk.Align.CENTER, sensitive, css_classes: ['flat']});
                    b.connect('clicked', () => {
                        const list = order();
                        const [x] = list.splice(i, 1);
                        list.splice(i + delta, 0, x);
                        const on = settings.get_strv('widgets');
                        settings.set_strv('widgets', list.filter(v => on.includes(v)));
                        fill();
                    });
                    row.add_suffix(b);
                };
                move('go-up-symbolic', -1, i > 0);
                move('go-down-symbolic', 1, i < ids.length - 1);
                const sw = new Gtk.Switch({active: enabled.includes(id), valign: Gtk.Align.CENTER});
                sw.connect('notify::active', () => {
                    const on = new Set(settings.get_strv('widgets'));
                    sw.active ? on.add(id) : on.delete(id);
                    settings.set_strv('widgets', order().filter(v => on.has(v)));
                });
                row.add_suffix(sw);
                row.set_activatable_widget(sw);
                group.add(row);
                rows.push(row);
            });
        };
        fill();

        // ---------------------------------------------------------------- поведение
        const behavior = new Adw.PreferencesGroup({title: 'Поведение'});
        page.add(behavior);
        const sw = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', 0);
            behavior.add(row);
        };
        sw('expand-on-hover', 'Раскрывать при наведении', 'Иначе — по щелчку. Правый щелчок открывает календарь и уведомления');
        sw('show-notifications', 'Уведомления в капле', 'Коротко показывать новые уведомления');
        sw('replace-banners', 'Вместо баннеров GNOME', 'Не дублировать уведомление стандартным всплывающим окном (оно останется в списке уведомлений)');
        sw('media-activity', 'Новый трек', 'Коротко показывать название при смене трека');
        sw('show-battery', 'Батарея', 'Зарядка, полный заряд и низкий заряд');

        const shelf = new Adw.PreferencesGroup({title: 'Полка файлов'});
        page.add(shelf);
        const limit = Adw.SpinRow.new_with_range(1, 50, 1);
        limit.title = 'Сколько файлов держать';
        settings.bind('shelf-limit', limit, 'value', 0);
        shelf.add(limit);
    }
}
