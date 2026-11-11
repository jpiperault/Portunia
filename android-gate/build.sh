#!/bin/sh
# Construit l'APK de Portunia Gate (Linux, avec le SDK Android).
#   ANDROID_HOME  SDK Android (plateforme 35, build-tools)
# Prérequis : Gradle 8.9 ou plus ; JDK 17 ou plus.
# Résultat : app/build/outputs/apk/release/app-release.apk
set -e
cd "$(dirname "$0")"
gradle --no-daemon assembleRelease
