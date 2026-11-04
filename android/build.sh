#!/bin/sh
# Construit l'APK de Portunia Assistance (Linux ou WSL, avec le SDK et le NDK Android).
#   ANDROID_HOME   SDK Android (plateforme 35, build-tools)
#   ANDROID_NDK_HOME  NDK (r26 ou plus)
# Prérequis : rustup target add aarch64-linux-android armv7-linux-androideabi ;
# cargo install cargo-ndk ; Gradle 8.9 ou plus ; JDK 17.
# Résultat : app/build/outputs/apk/release/app-release.apk
set -e
cd "$(dirname "$0")"
(cd rust && cargo ndk -t arm64-v8a -t armeabi-v7a -o ../app/src/main/jniLibs build --release)
gradle --no-daemon assembleRelease
