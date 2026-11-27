// Общие функции звука поверх микшера GNOME (тот же, что в меню быстрых настроек).

import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const ICONS = ['audio-volume-muted-symbolic', 'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic', 'audio-volume-high-symbolic'];

export function mixer() {
    return Volume.getMixerControl();
}

export function volumeIcon(frac, muted = false) {
    if (muted || frac <= 0)
        return ICONS[0];
    return ICONS[Math.min(3, 1 + Math.floor(frac * 3))];
}

export function maxVolume() {
    return mixer().get_vol_max_norm();
}

export function defaultSink() {
    return mixer().get_default_sink();
}

export function streamFrac(stream) {
    return stream ? stream.volume / maxVolume() : 0;
}

export function setStreamFrac(stream, frac) {
    if (!stream)
        return;
    frac = Math.max(0, Math.min(1, frac));
    if (stream.is_muted && frac > 0)
        stream.change_is_muted(false);
    stream.volume = frac * maxVolume();
    stream.push_volume();
}

/** Устройства вывода. В Gvc нет списка — перебираем небольшие id. */
export function outputs() {
    const c = mixer();
    const list = [];
    for (let id = 0; id < 256; id++) {
        const d = c.lookup_output_id(id);
        if (d)
            list.push(d);
    }
    return list;
}

export function activeOutputId() {
    const c = mixer();
    const sink = c.get_default_sink();
    const dev = sink ? c.lookup_device_from_stream(sink) : null;
    return dev ? dev.get_id() : -1;
}

export function setOutput(device) {
    mixer().change_output(device);
}

export function deviceIcon(d) {
    return d.get_gicon?.() ?? (d.get_icon_name() || 'audio-speakers-symbolic');
}

export function deviceName(d) {
    return d.get_description() || d.get_origin() || 'Устройство';
}

/** Потоки приложений (браузер, Spotify…), без системных звуков событий. */
export function appStreams() {
    return mixer().get_sink_inputs().filter(s => !s.is_event_stream && !s.is_virtual);
}
