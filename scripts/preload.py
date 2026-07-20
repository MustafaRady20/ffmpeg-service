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
    from faster_whisper import WhisperModel
    WhisperModel(model_size, device='cpu', compute_type='int8')
    print('[preload] Whisper model ready.', flush=True)


if __name__ == '__main__':
    try:
        preload_whisper()
    except Exception as e:
        # Non-fatal: Whisper will download the model on first use instead.
        print(f'[preload] WARNING: Whisper pre-warm failed ({e})', file=sys.stderr, flush=True)
