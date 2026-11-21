#!/usr/bin/env bash
# Add Stagecraft (AppImage) to this user's applications menu so it can be searched and pinned.
# No admin needed: everything goes under ~/Applications and ~/.local/share.
#
# Usage: install-launcher.sh [path/to/Stagecraft_*.AppImage]   install or update
#        install-launcher.sh --uninstall                        remove the launcher and the copy
#
# Without a path it uses the newest AppImage in desktop/src-tauri/target/release/bundle/appimage.
# The AppImage is COPIED to ~/Applications/Stagecraft.AppImage so a `cargo clean` or a rebuild
# never breaks the menu entry. Re-run after each rebuild to update the copy.
#
# The window's Wayland app_id and X11 WM_CLASS are both "stagecraft", so the entry is named
# stagecraft.desktop with StartupWMClass=stagecraft; the taskbar then groups the running window
# under the pinned icon instead of showing a second, generic one.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tauri="$here/../src-tauri"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
dest="$HOME/Applications/Stagecraft.AppImage"
entry="$apps/stagecraft.desktop"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$entry" "$dest"
  rm -f "$icons"/{32x32,128x128,256x256}/apps/stagecraft.png
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$apps" || true
  echo "Removed the Stagecraft launcher. Your ideas (app data) were not touched."
  exit 0
fi

src="${1:-}"
if [ -z "$src" ]; then
  src="$(ls -t "$tauri"/target/release/bundle/appimage/Stagecraft_*_amd64.AppImage 2>/dev/null | head -1 || true)"
fi
[ -n "$src" ] && [ -f "$src" ] || { echo "No AppImage found. Build one or pass its path." >&2; exit 2; }

mkdir -p "$(dirname "$dest")" "$apps"
if [ "$(realpath "$src")" != "$(realpath -m "$dest")" ]; then
  # Copy to a temp name, then rename, so a running copy is never half-overwritten.
  cp "$src" "$dest.new" && chmod +x "$dest.new" && mv -f "$dest.new" "$dest"
fi

for pair in "32x32:32x32.png" "128x128:128x128.png" "256x256:128x128@2x.png"; do
  size="${pair%%:*}"; file="${pair#*:}"
  if [ -f "$tauri/icons/$file" ]; then
    mkdir -p "$icons/$size/apps"
    cp "$tauri/icons/$file" "$icons/$size/apps/stagecraft.png"
  fi
done

cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=Stagecraft
GenericName=Idea walkthrough
Comment=Walk an idea through seven stages on local models
Exec="$dest"
TryExec=$dest
Icon=stagecraft
Terminal=false
Categories=Office;
Keywords=ideas;ollama;local;ai;
StartupNotify=true
StartupWMClass=stagecraft
EOF

command -v desktop-file-validate >/dev/null && desktop-file-validate "$entry"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$apps" || true
command -v gtk-update-icon-cache >/dev/null && [ -f "$icons/index.theme" ] && gtk-update-icon-cache -q "$icons" || true

if [ -f /usr/share/applications/Stagecraft.desktop ]; then
  echo "Note: the .deb is also installed, so the menu may show Stagecraft twice." \
       "Remove one: 'sudo apt remove stagecraft' or '$0 --uninstall'."
fi
echo "Installed: $entry"
echo "AppImage:  $dest ($(du -h "$dest" | cut -f1))"
echo "Open the applications menu and search for Stagecraft; right-click it to pin it to the taskbar."
