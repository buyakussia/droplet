// Обложки треков: локальные файлы как есть, ссылки из интернета (Spotify и др.) — в кэш.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'droplet', 'art']);
const MAX_FILES = 60;
let session = null;

function cachePath(url) {
    return GLib.build_filenamev([CACHE, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)]);
}

/** Путь к файлу обложки или null. */
export function resolveArt(url) {
    return new Promise(resolve => {
        if (!url)
            return resolve(null);
        if (url.startsWith('file://')) {
            const path = Gio.File.new_for_uri(url).get_path();
            return resolve(path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null);
        }
        if (!/^https?:\/\//.test(url))
            return resolve(null);
        const path = cachePath(url);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return resolve(path);
        session ??= new Soup.Session({timeout: 10});
        const msg = Soup.Message.new('GET', url);
        if (!msg)
            return resolve(null);
        session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== 200)
                    return resolve(null);
                GLib.mkdir_with_parents(CACHE, 0o700);
                GLib.file_set_contents(path, bytes.get_data());
                prune();
                resolve(path);
            } catch (e) {
                resolve(null);
            }
        });
    });
}

function prune() {
    try {
        const dir = Gio.File.new_for_path(CACHE);
        const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const files = [];
        let info;
        while ((info = en.next_file(null)))
            files.push([info.get_attribute_uint64('time::modified'), info.get_name()]);
        files.sort((a, b) => b[0] - a[0]);
        for (const [, name] of files.slice(MAX_FILES))
            dir.get_child(name).delete(null);
    } catch (e) {}
}

export function dropSession() {
    session?.abort();
    session = null;
}
