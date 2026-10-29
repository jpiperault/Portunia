#!/bin/sh
# Écran virtuel, gestionnaire de fenêtres, un terminal et une horloge, partagés en VNC.
Xvfb :1 -screen 0 1280x800x24 &
sleep 1
export DISPLAY=:1
fluxbox >/dev/null 2>&1 &
xterm -geometry 100x30+40+40 &
xclock -geometry 160x160+900+40 &
exec x11vnc -display :1 -rfbport 5901 -passwd portunia -forever -shared -quiet
