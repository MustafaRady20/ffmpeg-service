#!/usr/bin/env python3
"""
Run at container startup before the Node service starts.

Downloads and caches the configured Whisper model so the first request
doesn't pay the download cost.
"""
import os
import sys


def preload_whisper() -> None:
    model_size = os.environ.get('WHISPER_MODEL', 'small')
    print(f"[preload] Warming Whisper model '{model_size}'…", flush=True)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from whisper_srt import resolve_device
    from faster_whisper import WhisperModel
    device, compute_type = resolve_device()
    WhisperModel(model_size, device=device, compute_type=compute_type)
    print(f'[preload] Whisper model ready on {device} ({compute_type}).', flush=True)


if __name__ == '__main__':
    try:
        preload_whisper()
    except Exception as e:
        # Non-fatal: Whisper will download the model on first use instead.
        print(f'[preload] WARNING: Whisper pre-warm failed ({e})', file=sys.stderr, flush=True)
