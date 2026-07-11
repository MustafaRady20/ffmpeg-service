#!/usr/bin/env python3
"""
Run at container startup before the Node service starts.

- Downloads and caches the configured Whisper model.
- Pre-installs argostranslate language packages.

  ARGOS_PACKAGES=all          → install every en→X package available
  ARGOS_PACKAGES=en:ar en:de  → install only the listed pairs
  ARGOS_PACKAGES=              → skip (packages downloaded on demand)

All packages are stored in the argos_packages volume so downloads only
happen once per volume lifetime, not on every container restart.
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
    import argostranslate.package
    import argostranslate.translate

    packages_env = os.environ.get('ARGOS_PACKAGES', '').strip()
    if not packages_env:
        print('[preload] ARGOS_PACKAGES not set — skipping argostranslate pre-install.', flush=True)
        return

    print('[preload] Updating argostranslate package index…', flush=True)
    argostranslate.package.update_package_index()
    available = argostranslate.package.get_available_packages()

    if packages_env.lower() == 'all':
        # Install every en→X package that argostranslate offers.
        targets = [p for p in available if p.from_code == 'en']
        print(f'[preload] Installing all {len(targets)} en→X packages…', flush=True)
    else:
        pairs = [p.strip() for p in packages_env.split() if ':' in p]
        targets = []
        for pair in pairs:
            from_code, to_code = pair.split(':', 1)
            pkg = next(
                (p for p in available if p.from_code == from_code and p.to_code == to_code),
                None,
            )
            if pkg is None:
                print(f'[preload] WARNING: no argostranslate package for {pair}', flush=True)
            else:
                targets.append(pkg)

    installed_langs = argostranslate.translate.get_installed_languages()

    for pkg in targets:
        pair = f"{pkg.from_code}:{pkg.to_code}"
        from_lang = next((l for l in installed_langs if l.code == pkg.from_code), None)
        if from_lang:
            to_lang = next((l for l in installed_langs if l.code == pkg.to_code), None)
            if to_lang and from_lang.get_translation(to_lang):
                print(f'[preload] {pair}: already installed', flush=True)
                continue

        print(f'[preload] Installing {pair}…', flush=True)
        try:
            argostranslate.package.install_from_path(pkg.download())
            print(f'[preload] {pair}: done', flush=True)
        except Exception as e:
            print(f'[preload] WARNING: failed to install {pair}: {e}', flush=True)


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
