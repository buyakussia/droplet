#!/usr/bin/env bash
# Удаление расширения Droplet.
set -uo pipefail
UUID="droplet@buyakussia.github.io"
gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
current="$(gsettings get org.gnome.shell enabled-extensions)"
cleaned="$(printf '%s' "$current" | sed -E "s/, *'$UUID'//; s/'$UUID', *//; s/'$UUID'//")"
gsettings set org.gnome.shell enabled-extensions "$cleaned"
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID" "$HOME/.cache/droplet"
if [ "${1:-}" = "--purge" ]; then
  dconf reset -f /org/gnome/shell/extensions/droplet/ 2>/dev/null || true
fi
echo "Удалено. Чтобы часы вернулись сразу, выйдите из системы и войдите снова."
