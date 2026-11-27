// Вкладка «Музыка и видео» (в стиле Alcove): обложка, название, прогресс со временем
// с обеих сторон, «перемешать», управление и выбор устройства вывода прямо в плеере.
// В свёрнутой капле — мини-обложка и «живой» эквалайзер, при наведении — бегущая строка.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {PlayerManager} from '../mpris.js';
import {resolveArt} from '../art.js';
import * as Sound from '../sound.js';
import {vbox} from '../util.js';

function fmt(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function artStyle(path, radius) {
    return path
        ? `background-image: url("file://${path}"); background-size: cover; border-radius: ${radius}px;`
        : `border-radius: ${radius}px;`;
}

/** Эквалайзер из полосок, которые «танцуют», пока играет музыка. */
export class Equalizer {
    constructor(bars = 4, style = 'droplet-eq') {
        this.actor = new St.BoxLayout({style_class: style, y_align: Clutter.ActorAlign.CENTER});
        this._bars = [...Array(bars)].map(() => {
            const b = new St.Widget({style_class: 'droplet-eq-bar', y_align: Clutter.ActorAlign.CENTER});
            b.set_pivot_point(0.5, 0.5);
            b.scale_y = 0.25;
            this.actor.add_child(b);
            return b;
        });
        this._timer = 0;
        this.actor.connect('destroy', () => this.stop());
    }

    start() {
        if (this._timer)
            return;
        const tick = () => {
            for (const b of this._bars) {
                b.ease({
                    scale_y: 0.25 + Math.random() * 0.75,
                    duration: 170 + Math.random() * 90,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            }
            return GLib.SOURCE_CONTINUE;
        };
        tick();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, tick);
    }

    stop() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        for (const b of this._bars)
            b.ease({scale_y: 0.25, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
}

export class MediaWidget {
    constructor(ctx) {
        this._ctx = ctx;
        this.lockSafe = true; // плеер можно показывать на экране блокировки
        this._player = null;
        this._lastTrack = null;
        this._started = GLib.get_monotonic_time();

        // --- свёрнутый вид
        this.compactLeading = new St.Widget({style_class: 'droplet-mini-art', y_align: Clutter.ActorAlign.CENTER});
        this._eq = new Equalizer();
        this.compactTrailing = this._eq.actor;

        // --- страница
        this.page = vbox({style_class: 'droplet-page-media'});
        const top = new St.BoxLayout({style_class: 'droplet-media-top'});
        this._art = new St.Widget({style_class: 'droplet-art', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._art);
        const titles = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'droplet-media-title', text: 'Ничего не играет'});
        this._title.clutter_text.ellipsize = 3;
        this._artist = new St.Label({style_class: 'droplet-media-artist', text: 'Запустите музыку или видео'});
        this._artist.clutter_text.ellipsize = 3;
        titles.add_child(this._title);
        titles.add_child(this._artist);
        top.add_child(titles);
        this._pageEq = new Equalizer(4, 'droplet-eq droplet-eq-page');
        top.add_child(this._pageEq.actor);
        this.page.add_child(top);

        const prog = new St.BoxLayout({style_class: 'droplet-media-progress'});
        this._elapsed = new St.Label({style_class: 'droplet-time', text: '', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({style_class: 'droplet-progress droplet-seek', x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true, track_hover: true});
        this._fill = new St.Widget({style_class: 'droplet-progress-fill'});
        this._track.add_child(this._fill);
        this._track.connect('button-press-event', (a, e) => {
            const p = this._player;
            if (!p?.length || !p.canSeek)
                return Clutter.EVENT_PROPAGATE;
            const [x] = e.get_coords();
            const [ax] = a.get_transformed_position();
            p.seekTo(p.length * Math.max(0, Math.min(1, (x - ax) / a.width)));
            this._syncProgress();
            return Clutter.EVENT_STOP;
        });
        this._remaining = new St.Label({style_class: 'droplet-time droplet-time-right', text: '', y_align: Clutter.ActorAlign.CENTER});
        prog.add_child(this._elapsed);
        prog.add_child(this._track);
        prog.add_child(this._remaining);
        this.page.add_child(prog);

        const ctrl = new St.BoxLayout({style_class: 'droplet-media-controls', x_align: Clutter.ActorAlign.CENTER});
        const btn = (icon, fn, style = 'droplet-round-button') => {
            const b = new St.Button({style_class: style, child: new St.Icon({icon_name: icon}), can_focus: true});
            b.connect('clicked', fn);
            ctrl.add_child(b);
            return b;
        };
        this._shuffle = btn('media-playlist-shuffle-symbolic', () => this._player?.setShuffle(!this._player.shuffle), 'droplet-round-button small');
        this._prev = btn('media-skip-backward-symbolic', () => this._player?.previous());
        this._play = btn('media-playback-start-symbolic', () => this._player?.playPause(), 'droplet-round-button big');
        this._next = btn('media-skip-forward-symbolic', () => this._player?.next());
        this._output = btn('audio-speakers-symbolic', () => this._toggleOutputs(), 'droplet-round-button small');
        this.page.add_child(ctrl);

        // список устройств вывода, раскрывается кнопкой справа
        this._outputs = vbox({style_class: 'droplet-devices droplet-media-outputs', visible: false});
        this.page.add_child(this._outputs);
        Sound.mixer().connectObject('active-output-update', () => this._syncOutputIcon(), this);
        this._syncOutputIcon();

        this._manager = new PlayerManager(p => this._onPlayers(p));
        this._progressTimer = 0;
        this._onPlayers(null);
    }

    compactPriority() {
        return this._player?.playing ? 100 : 0;
    }

    /** Бегущая строка при наведении на каплю. */
    peekText() {
        const p = this._player;
        if (!p?.title)
            return null;
        return p.artist ? `${p.title} — ${p.artist}` : p.title;
    }

    _syncOutputIcon() {
        const active = Sound.outputs().find(d => d.get_id() === Sound.activeOutputId());
        const icon = active ? Sound.deviceIcon(active) : 'audio-speakers-symbolic';
        if (typeof icon === 'string')
            this._output.child.icon_name = icon;
        else
            this._output.child.gicon = icon;
        if (this._outputs.visible)
            this._fillOutputs();
    }

    _toggleOutputs() {
        const show = !this._outputs.visible;
        if (show)
            this._fillOutputs();
        this._outputs.visible = show;
        if (show) {
            this._outputs.opacity = 0;
            this._outputs.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._ctx.relayout();
    }

    _fillOutputs() {
        this._outputs.destroy_all_children();
        const active = Sound.activeOutputId();
        for (const d of Sound.outputs()) {
            const row = new St.Button({style_class: 'droplet-device', can_focus: true, x_expand: true});
            const box = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.FILL});
            const icon = Sound.deviceIcon(d);
            box.add_child(typeof icon === 'string'
                ? new St.Icon({icon_name: icon, style_class: 'droplet-device-icon'})
                : new St.Icon({gicon: icon, style_class: 'droplet-device-icon'}));
            const label = new St.Label({text: Sound.deviceName(d), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = 3;
            box.add_child(label);
            box.add_child(new St.Icon({icon_name: 'object-select-symbolic', style_class: 'droplet-device-check', opacity: d.get_id() === active ? 255 : 0}));
            row.set_child(box);
            if (d.get_id() === active)
                row.add_style_class_name('active');
            row.connect('clicked', () => {
                Sound.setOutput(d);
                this._toggleOutputs();
            });
            this._outputs.add_child(row);
        }
        if (!this._outputs.get_n_children())
            this._outputs.add_child(new St.Label({text: 'Нет устройств вывода', style_class: 'droplet-dim'}));
    }

    _onPlayers(active) {
        const prev = this._player;
        this._player = active;
        const p = active;
        const playing = Boolean(p?.playing);

        this._title.text = p?.title || 'Ничего не играет';
        this._artist.text = p ? (p.artist || p.album || p.identity) : 'Запустите музыку или видео';
        this._play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        const enable = (b, on) => {
            b.reactive = Boolean(on);
            b.opacity = on ? 255 : 80;
        };
        enable(this._prev, p?.canPrev);
        enable(this._next, p?.canNext);
        enable(this._play, p);
        this._shuffle.visible = p?.shuffle !== null && p?.shuffle !== undefined;
        if (p?.shuffle)
            this._shuffle.add_style_pseudo_class('checked');
        else
            this._shuffle.remove_style_pseudo_class('checked');
        this.page.remove_style_class_name('idle');
        if (!p)
            this.page.add_style_class_name('idle');

        const url = p?.artUrl ?? '';
        if (url !== this._artUrl) {
            this._artUrl = url;
            resolveArt(url).then(path => {
                if (this._artUrl !== url || !this.page)
                    return;
                this._art.style = artStyle(path, 12);
                this.compactLeading.style = artStyle(path, 6);
            }).catch(() => {});
        }

        if (playing) {
            this._eq.start();
            this._pageEq.start();
        } else {
            this._eq.stop();
            this._pageEq.stop();
        }

        // новый трек — коротко показать его в капле (кроме первых секунд после запуска)
        const key = p ? `${p.busName}|${p.trackId}|${p.title}` : null;
        const fresh = GLib.get_monotonic_time() - this._started > 3e6;
        if (p && playing && key !== this._lastTrack && p.title && fresh && prev !== undefined &&
            this._ctx.settings.get_boolean('media-activity')) {
            const art = new St.Widget({style_class: 'droplet-activity-art'});
            resolveArt(p.artUrl).then(path => (art.style = artStyle(path, 8))).catch(() => {});
            this._ctx.island.showActivity({
                icon: art,
                title: p.title,
                subtitle: p.artist,
                duration: 2600,
                onClick: () => this._ctx.showTab('media'),
            });
        }
        if (key && playing)
            this._lastTrack = key;

        this._syncProgress();
        this._updateTimer();
        this._ctx.compactChanged();
    }

    _syncProgress() {
        const p = this._player;
        if (!p || !p.length) {
            this._fill.width = 0;
            this._elapsed.text = this._remaining.text = '';
            return;
        }
        const pos = p.currentPosition();
        this._elapsed.text = fmt(pos);
        this._remaining.text = `-${fmt(p.length - pos)}`;
        const w = this._track.get_stage() ? this._track.width : 0;
        if (w > 0) {
            this._fill.height = this._track.height;
            this._fill.width = Math.round(w * Math.min(1, pos / p.length));
        }
    }

    /** Прогресс обновляется раз в секунду и только когда страница видна. */
    _updateTimer() {
        const need = Boolean(this._player?.playing) && this._shown && this._ctx.island.state === 'expanded';
        if (need && !this._progressTimer) {
            this._progressTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._syncProgress();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!need && this._progressTimer) {
            GLib.source_remove(this._progressTimer);
            this._progressTimer = 0;
        }
    }

    onPageShown(shown) {
        this._shown = shown;
        if (shown)
            this._player?.refreshPosition();
        else if (this._outputs.visible)
            this._outputs.visible = false;
        this._syncProgress();
        this._updateTimer();
    }

    onStateChanged(state) {
        if (state === 'expanded')
            this._player?.refreshPosition();
        else if (this._outputs.visible)
            this._outputs.visible = false;
        this._syncProgress();
        this._updateTimer();
    }

    destroy() {
        if (this._progressTimer)
            GLib.source_remove(this._progressTimer);
        Sound.mixer().disconnectObject(this);
        this._manager.destroy();
        this.compactLeading.destroy();
        this.compactTrailing.destroy();
        this.page.destroy();
        this.page = null;
    }
}
