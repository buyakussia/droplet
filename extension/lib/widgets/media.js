// Виджет «Музыка и видео»: обложка, название, прогресс и управление для любого MPRIS-плеера.
// В свёрнутой капле: мини-обложка слева и «живой» эквалайзер справа.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {PlayerManager} from '../mpris.js';
import {resolveArt} from '../art.js';
import {vbox} from '../util.js';

function fmt(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function artStyle(path, radius) {
    return path
        ? `background-image: url("file://${path}"); background-size: cover; border-radius: ${radius}px;`
        : `border-radius: ${radius}px;`;
}

/** Эквалайзер из четырёх полосок, которые «танцуют», пока играет музыка. */
class Equalizer {
    constructor() {
        this.actor = new St.BoxLayout({style_class: 'droplet-eq', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [...Array(4)].map(() => {
            const b = new St.Widget({style_class: 'droplet-eq-bar', y_align: Clutter.ActorAlign.CENTER});
            b.set_pivot_point(0.5, 0.5);
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
        this._player = null;
        this._lastTrack = null;
        this._started = GLib.get_monotonic_time();

        // --- свёрнутый вид
        this.compactLeading = new St.Widget({style_class: 'droplet-mini-art', y_align: Clutter.ActorAlign.CENTER});
        this._eq = new Equalizer();
        this.compactTrailing = this._eq.actor;

        // --- карточка
        this.card = new St.BoxLayout({style_class: 'droplet-card droplet-media'});
        this._art = new St.Widget({style_class: 'droplet-art'});
        this.card.add_child(this._art);

        const col = vbox({x_expand: true, style_class: 'droplet-media-col'});
        this._title = new St.Label({style_class: 'droplet-media-title', text: 'Ничего не играет'});
        this._title.clutter_text.ellipsize = 3;
        this._artist = new St.Label({style_class: 'droplet-media-artist', text: 'Запустите музыку или видео'});
        this._artist.clutter_text.ellipsize = 3;
        col.add_child(this._title);
        col.add_child(this._artist);

        const prog = new St.BoxLayout({style_class: 'droplet-media-progress'});
        this._elapsed = new St.Label({style_class: 'droplet-time', text: '0:00', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({style_class: 'droplet-progress', x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true});
        this._fill = new St.Widget({style_class: 'droplet-progress-fill'});
        this._track.add_child(this._fill);
        this._track.connect('button-press-event', (a, e) => {
            const p = this._player;
            if (!p?.length)
                return Clutter.EVENT_PROPAGATE;
            const [x] = e.get_coords();
            const [ax] = a.get_transformed_position();
            p.seekTo(p.length * Math.max(0, Math.min(1, (x - ax) / a.width)));
            this._syncProgress();
            return Clutter.EVENT_STOP;
        });
        this._total = new St.Label({style_class: 'droplet-time', text: '0:00', y_align: Clutter.ActorAlign.CENTER});
        prog.add_child(this._elapsed);
        prog.add_child(this._track);
        prog.add_child(this._total);
        col.add_child(prog);

        const ctrl = new St.BoxLayout({style_class: 'droplet-media-controls', x_align: Clutter.ActorAlign.CENTER});
        const btn = (icon, fn, big = false) => {
            const b = new St.Button({
                style_class: big ? 'droplet-round-button big' : 'droplet-round-button',
                child: new St.Icon({icon_name: icon}),
                can_focus: true,
            });
            b.connect('clicked', fn);
            ctrl.add_child(b);
            return b;
        };
        this._prev = btn('media-skip-backward-symbolic', () => this._player?.previous());
        this._play = btn('media-playback-start-symbolic', () => this._player?.playPause(), true);
        this._next = btn('media-skip-forward-symbolic', () => this._player?.next());
        col.add_child(ctrl);
        this.card.add_child(col);

        this._manager = new PlayerManager(p => this._onPlayers(p));
        this._progressTimer = 0;
        this._onPlayers(null);
    }

    compactPriority() {
        return this._player?.playing ? 100 : 0;
    }

    _onPlayers(active) {
        const prev = this._player;
        this._player = active;
        const p = active;
        const playing = Boolean(p?.playing);

        this._title.text = p?.title || 'Ничего не играет';
        this._artist.text = p ? (p.artist || p.album || p.identity) : 'Запустите музыку или видео';
        this._play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = Boolean(p?.canPrev);
        this._next.reactive = Boolean(p?.canNext);
        this._prev.opacity = p?.canPrev ? 255 : 90;
        this._next.opacity = p?.canNext ? 255 : 90;
        this.card.remove_style_class_name('idle');
        if (!p)
            this.card.add_style_class_name('idle');

        const url = p?.artUrl ?? '';
        if (url !== this._artUrl) {
            this._artUrl = url;
            resolveArt(url).then(path => {
                if (this._artUrl !== url || !this.card)
                    return;
                this._artPath = path;
                this._art.style = artStyle(path, 14);
                this.compactLeading.style = artStyle(path, 6);
            }).catch(() => {});
        }

        if (playing)
            this._eq.start();
        else
            this._eq.stop();

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
            this._elapsed.text = this._total.text = '';
            return;
        }
        const pos = p.currentPosition();
        this._elapsed.text = fmt(pos);
        this._total.text = fmt(p.length);
        const w = this._track.width;
        if (w > 0) {
            this._fill.height = this._track.height;
            this._fill.width = Math.round(w * Math.min(1, pos / p.length));
        }
    }

    /** Прогресс обновляется раз в секунду и только когда карточка видна. */
    _updateTimer() {
        const need = Boolean(this._player?.playing) && this._ctx.island.state === 'expanded';
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

    onStateChanged(state) {
        if (state === 'expanded')
            this._player?.refreshPosition();
        this._syncProgress();
        this._updateTimer();
    }

    destroy() {
        if (this._progressTimer)
            GLib.source_remove(this._progressTimer);
        this._manager.destroy();
        this.compactLeading.destroy();
        this.compactTrailing.destroy();
        this.card.destroy();
        this.card = null;
    }
}
