#!/usr/bin/env python3
"""
Usage: python3 whisper_srt.py <audio_path> <srt_output_path> [model_size] [target_lang]

Transcribes audio using faster-whisper and writes an SRT subtitle file.
Optionally translates subtitles to target_lang using the DeepL API (e.g. 'de', 'fr', 'es').
Requires DEEPL_API_KEY env var. Free-tier keys end in ':fx'.
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


def translate_text(text: str, from_code: str, to_code: str) -> str:
    import os, urllib.request, urllib.parse, json

    api_key = os.environ.get("DEEPL_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DEEPL_API_KEY environment variable is required for translation")

    # Free-tier keys end in ':fx' and use a different host
    base = "https://api-free.deepl.com" if api_key.endswith(":fx") else "https://api.deepl.com"
    url = f"{base}/v2/translate"

    payload = urllib.parse.urlencode({
        "text": text,
        "source_lang": from_code.upper(),
        "target_lang": to_code.upper(),
    }).encode()

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Authorization", f"DeepL-Auth-Key {api_key}")
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    return data["translations"][0]["text"]


def run_diarization(audio_path: str):
    """
    Run pyannote speaker diarization.
    Requires HF_TOKEN env var and the model terms accepted at:
    https://huggingface.co/pyannote/speaker-diarization-3.1
    """
    import os
    hf_token = os.environ.get('HF_TOKEN', '').strip()
    if not hf_token:
        raise RuntimeError(
            "HF_TOKEN environment variable is required for speaker diarization. "
            "Get a token at https://huggingface.co/settings/tokens and accept the "
            "pyannote/speaker-diarization-3.1 model terms at "
            "https://huggingface.co/pyannote/speaker-diarization-3.1"
        )
    from pyannote.audio import Pipeline
    import torch
    print("Loading speaker diarization model…", file=sys.stderr)
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )
    pipeline.to(torch.device("cpu"))
    print("Running diarization…", file=sys.stderr)
    return pipeline(audio_path)


def get_speaker(start: float, end: float, diarization) -> str | None:
    """Return the speaker with the most overlap in the segment [start, end]."""
    totals: dict[str, float] = {}
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        overlap = min(end, turn.end) - max(start, turn.start)
        if overlap > 0:
            totals[speaker] = totals.get(speaker, 0.0) + overlap
    return max(totals, key=totals.get) if totals else None


def speaker_label(speaker_id: str) -> str:
    """Convert SPEAKER_00 → Speaker 1, SPEAKER_01 → Speaker 2, etc."""
    try:
        return f"Speaker {int(speaker_id.split('_')[-1]) + 1}"
    except (ValueError, IndexError):
        return speaker_id


def main():
    if len(sys.argv) < 3:
        print("Usage: whisper_srt.py <audio_path> <srt_output_path> [model_size] [target_lang] [diarize]", file=sys.stderr)
        sys.exit(1)

    audio_path  = sys.argv[1]
    output_path = sys.argv[2]
    model_size  = sys.argv[3] if len(sys.argv) > 3 else "small"
    target_lang = (sys.argv[4] if len(sys.argv) > 4 else None) or None  # empty string → None
    diarize     = len(sys.argv) > 5 and sys.argv[5] == "diarize"

    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    # Always transcribe in the source language so Whisper preserves the original text.
    # DeepL then handles source_lang → target_lang directly, which is more accurate
    # than going through an English intermediate step.
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        task="transcribe",
        # vad_filter removes silence / noise between speakers so Whisper doesn't
        # waste segments on gaps or produce noise-only tokens (e.g. [MUSIC]).
        vad_filter=True,
        # With multiple speakers, conditioning on prior text causes Whisper to
        # "hallucinate" repetitions of previous speakers.  Turning this off makes
        # each segment transcribed independently.
        condition_on_previous_text=False,
    )
    segments = list(segments)  # consume generator before opening file

    source_lang = info.language
    print(f"Detected language: {source_lang}", file=sys.stderr)

    needs_translation = bool(target_lang and target_lang.lower() != source_lang.lower())
    if needs_translation:
        print(f"Translating {source_lang} -> {target_lang} via DeepL…", file=sys.stderr)

    diarization = None
    if diarize:
        diarization = run_diarization(audio_path)

    count = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for seg in segments:
            text = seg.text.strip()
            # Skip noise-only tokens and empty segments produced by overlapping
            # speakers or background sound — writing empty SRT entries causes
            # FFmpeg to reject the subtitle track.
            if not text:
                continue
            if needs_translation:
                try:
                    text = translate_text(text, source_lang, target_lang)
                except Exception as e:
                    # Keep the original segment rather than failing the whole file.
                    print(f"WARNING: translation failed for segment, keeping original: {e}", file=sys.stderr)
            if diarization is not None:
                spk = get_speaker(seg.start, seg.end, diarization)
                if spk:
                    text = f"[{speaker_label(spk)}] {text}"
            count += 1
            f.write(f"{count}\n")
            f.write(f"{format_timestamp(seg.start)} --> {format_timestamp(seg.end)}\n")
            f.write(f"{text}\n\n")

    if count == 0:
        print("ERROR: no speech segments detected — subtitle file would be empty", file=sys.stderr)
        sys.exit(1)

    print(f"SRT written to {output_path} ({count} segments)", file=sys.stderr)


if __name__ == "__main__":
    main()
