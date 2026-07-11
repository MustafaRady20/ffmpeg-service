#!/usr/bin/env python3
"""
Run at container startup before the Node service starts.

- Downloads and caches the configured Whisper model.
- Pre-installs argostranslate language packages listed in ARGOS_PACKAGES
  (space-separated 'from_code:to_code' pairs, e.g. "es:fr es:de es:pt").

Both are stored in mounted volumes so downloads only happen once per volume
lifetime, not on every container start.
"""
import os
import sys


def preload_whisper() -> None:
    model_size = os.environ.get('WHISPER_MODEL', 'small')
    print(f"[preload] Warming Whisper model '{model_size}'…", flush=True)
    from faster_whisper import WhisperModel
    WhisperModel(model_size, device='cpu', compute_type='int8')
    print('[preload] Whisper model ready.', flush=True)


def preload_argos() -> None:
    packages_env = os.environ.get('ARGOS_PACKAGES', '').strip()
    if not packages_env:
        print('[preload] ARGOS_PACKAGES not set — skipping argostranslate pre-install.', flush=True)
        return

    pairs = [p.strip() for p in packages_env.split() if ':' in p]
    if not pairs:
        return

    import argostranslate.package
    import argostranslate.translate

    print(f"[preload] Updating argostranslate package index…", flush=True)
    argostranslate.package.update_package_index()
    available = argostranslate.package.get_available_packages()

    for pair in pairs:
        from_code, to_code = pair.split(':', 1)

        installed = argostranslate.translate.get_installed_languages()
        from_lang = next((l for l in installed if l.code == from_code), None)
        if from_lang:
            to_lang = next((l for l in installed if l.code == to_code), None)
            if to_lang and from_lang.get_translation(to_lang):
                print(f'[preload] {pair}: already installed', flush=True)
                continue

        pkg = next(
            (p for p in available if p.from_code == from_code and p.to_code == to_code),
            None,
        )
        if pkg is None:
            print(f'[preload] WARNING: no argostranslate package for {pair}', flush=True)
            continue

        print(f'[preload] Installing {pair}…', flush=True)
        argostranslate.package.install_from_path(pkg.download())
        print(f'[preload] {pair}: done', flush=True)


if __name__ == '__main__':
    try:
        preload_whisper()
    except Exception as e:
        # Non-fatal: Whisper will download the model on first use instead.
        print(f'[preload] WARNING: Whisper pre-warm failed ({e})', file=sys.stderr, flush=True)

    try:
        preload_argos()
    except Exception as e:
        # Non-fatal: packages will be downloaded on demand instead.
        print(f'[preload] WARNING: argostranslate pre-install failed ({e})', file=sys.stderr, flush=True)
