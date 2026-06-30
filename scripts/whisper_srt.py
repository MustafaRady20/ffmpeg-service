#!/usr/bin/env python3
"""
Usage: python3 whisper_srt.py <audio_path> <srt_output_path> [model_size]

Transcribes audio using faster-whisper and writes an SRT subtitle file.
Model sizes: tiny, base, small (default), medium, large-v3
"""
import sys
from faster_whisper import WhisperModel


def format_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    if len(sys.argv) < 3:
        print("Usage: whisper_srt.py <audio_path> <srt_output_path> [model_size]", file=sys.stderr)
        sys.exit(1)

    audio_path  = sys.argv[1]
    output_path = sys.argv[2]
    model_size  = sys.argv[3] if len(sys.argv) > 3 else "small"

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio_path, beam_size=5)

    with open(output_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n")
            f.write(f"{format_timestamp(seg.start)} --> {format_timestamp(seg.end)}\n")
            f.write(f"{seg.text.strip()}\n\n")

    print(f"SRT written to {output_path}")


if __name__ == "__main__":
    main()
