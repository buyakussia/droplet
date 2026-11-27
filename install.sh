#!/usr/bin/env bash
# Установка расширения Droplet для текущего пользователя.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="droplet@buyakussia.github.io"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

command -v gnome-shell >/dev/null || { echo "Нужен GNOME Shell."; exit 1; }
command -v glib-compile-schemas >/dev/null || { echo "Нужна утилита glib-compile-schemas (пакет glib2)."; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$HERE/extension/." "$DEST/"
glib-compile-schemas "$DEST/schemas"

# включить расширение (работает и до перезахода: GNOME подхватит его при следующем входе)
gsettings set org.gnome.shell disable-user-extensions false
current="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$current" != *"$UUID"* ]]; then
  if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
    gsettings set org.gnome.shell enabled-extensions "['$UUID']"
  else
    gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
  fi
fi
gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

echo "✓ Droplet установлен."
echo "  Выйдите из системы и войдите снова — на Wayland GNOME подгружает новые расширения только так."
echo "  Настройки: gnome-extensions prefs $UUID (или кнопка ⚙ в раскрытой капле)."
