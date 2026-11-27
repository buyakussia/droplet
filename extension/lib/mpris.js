// Маленький клиент MPRIS: узнаёт, что играет в любом плеере (Spotify, браузер, mpv, VLC…),
// и управляет им. Только Gio D-Bus, без лишних зависимостей.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';

const unpack = v => (v ? v.deepUnpack() : null);

export class Player {
    constructor(busName, onChange) {
        this.busName = busName;
        this._onChange = onChange;
        this.status = 'Stopped';
        this.title = '';
        this.artist = '';
        this.album = '';
        this.artUrl = '';
        this.trackId = '';
        this.length = 0;       // мкс
        this.position = 0;     // мкс, на момент positionAt
        this.positionAt = 0;
        this.rate = 1;
        this.canNext = false;
        this.canPrev = false;
        this.canSeek = false;
        this.lastPlayed = 0;
        this.identity = busName.slice(PREFIX.length).split('.')[0];
        this._cancel = new Gio.Cancellable();

        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
            null, busName, PATH, PLAYER, this._cancel, (_o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    return;
                }
                this._proxy.connect('g-properties-changed', (_p, changed) => {
                    this._sync();
                    if (changed.lookup_value('Metadata', null))
                        this.refreshPosition();
                });
                this._proxy.connect('g-signal', (_p, _s, signal, params) => {
                    if (signal === 'Seeked') {
                        this.position = params.deepUnpack()[0];
                        this.positionAt = GLib.get_monotonic_time();
                        this._onChange(this);
                    }
                });
                this._sync();
                this.refreshPosition();
            });
    }

    _sync() {
        const p = this._proxy;
        if (!p)
            return;
        const status = unpack(p.get_cached_property('PlaybackStatus')) ?? 'Stopped';
        if (status === 'Playing' && this.status !== 'Playing')
            this.lastPlayed = GLib.get_monotonic_time();
        if (this.status === 'Playing' && status !== 'Playing')
            this.position = this.currentPosition();
        this.positionAt = GLib.get_monotonic_time();
        this.status = status;
        const md = unpack(p.get_cached_property('Metadata')) ?? {};
        const get = k => (md[k] ? md[k].deepUnpack() : null);
        this.title = get('xesam:title') ?? '';
        const artist = get('xesam:artist');
        this.artist = Array.isArray(artist) ? artist.join(', ') : (artist ?? '');
        this.album = get('xesam:album') ?? '';
        this.artUrl = get('mpris:artUrl') ?? '';
        this.length = Number(get('mpris:length') ?? 0);
        this.trackId = String(get('mpris:trackid') ?? this.title);
        this.rate = unpack(p.get_cached_property('Rate')) ?? 1;
        this.canNext = unpack(p.get_cached_property('CanGoNext')) ?? false;
        this.canPrev = unpack(p.get_cached_property('CanGoPrevious')) ?? false;
        this.canSeek = unpack(p.get_cached_property('CanSeek')) ?? false;
        this.shuffle = unpack(p.get_cached_property('Shuffle'));  // null — плеер не поддерживает
        this._onChange(this);
    }

    get playing() {
        return this.status === 'Playing';
    }

    get hasTrack() {
        return Boolean(this.title);
    }

    /** Текущая позиция с учётом прошедшего времени (не дёргаем D-Bus каждую секунду). */
    currentPosition() {
        if (!this.playing)
            return this.position;
        const dt = (GLib.get_monotonic_time() - this.positionAt) * this.rate;
        return Math.min(this.length || Infinity, this.position + dt);
    }

    refreshPosition() {
        this._proxy?.get_connection().call(this.busName, PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER, 'Position']), null, Gio.DBusCallFlags.NONE, 1000, this._cancel,
            (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    this.position = Number(v.deepUnpack());
                    this.positionAt = GLib.get_monotonic_time();
                    this._onChange(this);
                } catch (e) {}
            });
    }

    _call(method, args = null) {
        this._proxy?.call(method, args, Gio.DBusCallFlags.NONE, 1000, null, null);
    }

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    setShuffle(on) {
        this._proxy?.get_connection().call(this.busName, PATH, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PLAYER, 'Shuffle', new GLib.Variant('b', on)]),
            null, Gio.DBusCallFlags.NONE, 1000, null, null);
        this.shuffle = on;
    }

    seekTo(us) {
        if (!this.canSeek || !this.trackId)
            return;
        this._call('SetPosition', new GLib.Variant('(ox)', [this.trackId.startsWith('/') ? this.trackId : '/org/mpris/MediaPlayer2/TrackList/NoTrack', Math.round(us)]));
        this.position = us;
        this.positionAt = GLib.get_monotonic_time();
    }

    destroy() {
        this._cancel.cancel();
        this._proxy = null;
    }
}

/** Следит за всеми плеерами в системе и выбирает «главный». */
export class PlayerManager {
    constructor(onChange) {
        this._onChange = onChange;
        this._players = new Map();
        this._bus = Gio.DBus.session;
        this._sub = this._bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (newOwner)
                    this._add(name);
                else
                    this._remove(name);
            });
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(PREFIX)).forEach(n => this._add(n));
                } catch (e) {}
            });
    }

    _add(name) {
        if (this._players.has(name) || !this._players)
            return;
        this._players.set(name, new Player(name, () => this._onChange(this.active)));
    }

    _remove(name) {
        this._players.get(name)?.destroy();
        this._players.delete(name);
        this._onChange(this.active);
    }

    /** Играющий сейчас (последний запущенный), иначе последний игравший с треком. */
    get active() {
        const list = [...(this._players?.values() ?? [])].filter(p => p.hasTrack);
        const playing = list.filter(p => p.playing).sort((a, b) => b.lastPlayed - a.lastPlayed);
        if (playing.length)
            return playing[0];
        return list.sort((a, b) => b.lastPlayed - a.lastPlayed)[0] ?? null;
    }

    destroy() {
        this._bus.signal_unsubscribe(this._sub);
        for (const p of this._players.values())
            p.destroy();
        this._players = null;
    }
}
