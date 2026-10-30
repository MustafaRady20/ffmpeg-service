#!/usr/bin/env python3
"""
Usage: python3 whisper_srt.py <audio_path> <srt_output_path> [model_size] [target_lang] [translated_srt_path] [diarize]

Transcribes audio using faster-whisper and writes an SRT subtitle file in the
spoken language. If target_lang is given (e.g. 'de', 'fr', 'es') and differs
from the spoken language, a second SRT translated via the DeepL API is written
to translated_srt_path; the original file is always kept. If translation
fails, the translated file is not written (it is never silently filled with
untranslated text).

Env vars:
  DEEPL_API_KEY         required for translation. Free-tier keys end in ':fx'.
  WHISPER_DEVICE        auto (default) | cuda | cpu
  WHISPER_COMPUTE_TYPE  default: float16 on GPU, int8 on CPU
  WHISPER_LANGUAGE      spoken language code (e.g. 'ja'); empty = auto-detect
  HF_TOKEN              required for diarization
Model sizes: tiny, base, small (default), medium, large-v3
"""
import os
import sys
import time
from faster_whisper import WhisperModel

# Lines per DeepL request (API limit is 50) and how many neighbouring lines
# are sent as untranslated context so split sentences translate correctly.
DEEPL_BATCH = 25
DEEPL_CONTEXT_LINES = 10

# DeepL deprecated bare EN/PT as *target* languages.
DEEPL_TARGET_ALIASES = {"EN": "EN-US", "PT": "PT-BR"}


def resolve_device() -> tuple[str, str]:
    device = os.environ.get("WHISPER_DEVICE", "auto").strip().lower() or "auto"
    if device == "auto":
        import ctranslate2
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "").strip() or (
        "float16" if device == "cuda" else "int8"
    )
    return device, compute_type


def resolve_language() -> str | None:
    lang = os.environ.get("WHISPER_LANGUAGE", "").strip().lower() or None
    if lang is None:
        return None
    try:
        from faster_whisper.tokenizer import _LANGUAGE_CODES
        if lang not in _LANGUAGE_CODES:
            print(f"WARNING: unknown spoken language '{lang}', auto-detecting instead", file=sys.stderr)
            return None
    except ImportError:
        pass
    return lang


def format_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def deepl_request(texts: list[str], target: str, context: str) -> list[str]:
    import json, urllib.error, urllib.parse, urllib.request

    api_key = os.environ.get("DEEPL_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DEEPL_API_KEY environment variable is required for translation")

    # Free-tier keys end in ':fx' and use a different host
    base = "https://api-free.deepl.com" if api_key.endswith(":fx") else "https://api.deepl.com"
    # source_lang is omitted on purpose: DeepL detects it, and Whisper knows
    # many languages DeepL can't take as an explicit source code.
    fields = [("text", t) for t in texts] + [("target_lang", target), ("context", context)]
    payload = urllib.parse.urlencode(fields).encode()

    for attempt in range(4):
        req = urllib.request.Request(f"{base}/v2/translate", data=payload, method="POST")
        req.add_header("Authorization", f"DeepL-Auth-Key {api_key}")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            return [t["text"] for t in data["translations"]]
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            # 429 = rate limited, 5xx = DeepL side; both are worth retrying.
            # Anything else (456 quota exceeded, 400 bad language…) is final.
            if e.code != 429 and e.code < 500 or attempt == 3:
                raise RuntimeError(f"DeepL HTTP {e.code}: {body}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 3:
                raise RuntimeError(f"DeepL unreachable: {e}") from e
        time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def translate_lines(lines: list[str], target_lang: str) -> list[str]:
    target = target_lang.upper()
    target = DEEPL_TARGET_ALIASES.get(target, target)
    out: list[str] = []
    for i in range(0, len(lines), DEEPL_BATCH):
        batch = lines[i:i + DEEPL_BATCH]
        lo = max(0, i - DEEPL_CONTEXT_LINES)
        hi = i + DEEPL_BATCH + DEEPL_CONTEXT_LINES
        context = "\n".join(lines[lo:hi])
        translated = deepl_request(batch, target, context)
        if len(translated) != len(batch):
            raise RuntimeError(f"DeepL returned {len(translated)} lines for {len(batch)}")
        out.extend(translated)
        print(f"Translated {len(out)}/{len(lines)} lines", file=sys.stderr)
    return out


def run_diarization(audio_path: str):
    """
    Run pyannote speaker diarization.
    Requires HF_TOKEN env var and the model terms accepted at:
    https://huggingface.co/pyannote/speaker-diarization-3.1
    """
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
    pipeline.to(torch.device("cuda" if torch.cuda.is_available() else "cpu"))
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


def write_srt(path: str, cues) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(cues, 1):
            f.write(f"{i}\n")
            f.write(f"{format_timestamp(start)} --> {format_timestamp(end)}\n")
            f.write(f"{text}\n\n")


def main():
    if len(sys.argv) < 3:
        print("Usage: whisper_srt.py <audio_path> <srt_output_path> [model_size] [target_lang] [translated_srt_path] [diarize]", file=sys.stderr)
        sys.exit(1)

    audio_path  = sys.argv[1]
    output_path = sys.argv[2]
    model_size  = sys.argv[3] if len(sys.argv) > 3 else "small"
    target_lang = (sys.argv[4] if len(sys.argv) > 4 else None) or None  # empty string → None
    translated_path = (sys.argv[5] if len(sys.argv) > 5 else None) or None
    diarize     = len(sys.argv) > 6 and sys.argv[6] == "diarize"

    device, compute_type = resolve_device()
    print(f"Loading Whisper '{model_size}' on {device} ({compute_type})", file=sys.stderr)
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    # Always transcribe in the source language so Whisper preserves the original text.
    # DeepL then translates directly, which is more accurate than going through
    # an English intermediate step.
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        task="transcribe",
        # Auto-detection only listens to the first 30 s, so a music intro can
        # make it pick the wrong language for the whole file.
        language=resolve_language(),
        # vad_filter removes silence / noise between speakers so Whisper doesn't
        # waste segments on gaps or produce noise-only tokens (e.g. [MUSIC]).
        vad_filter=True,
        # The default threshold (0.5) drops speech that has music or effects
        # under it, which made subtitles stop partway through. A lower
        # threshold and extra padding keep that speech.
        vad_parameters={"threshold": 0.35, "speech_pad_ms": 600},
        # With multiple speakers, conditioning on prior text causes Whisper to
        # "hallucinate" repetitions of previous speakers.  Turning this off makes
        # each segment transcribed independently.
        condition_on_previous_text=False,
    )
    segments = list(segments)  # consume generator before opening file

    source_lang = info.language
    print(f"Detected language: {source_lang} (probability {info.language_probability:.2f})", file=sys.stderr)

    diarization = None
    if diarize:
        diarization = run_diarization(audio_path)

    # (start, end, speaker prefix, original text)
    entries = []
    for seg in segments:
        text = seg.text.strip()
        # Skip noise-only tokens and empty segments produced by overlapping
        # speakers or background sound — writing empty SRT entries causes
        # FFmpeg to reject the subtitle track.
        if not text:
            continue
        prefix = ""
        if diarization is not None:
            spk = get_speaker(seg.start, seg.end, diarization)
            if spk:
                prefix = f"[{speaker_label(spk)}] "
        entries.append((seg.start, seg.end, prefix, text))

    if not entries:
        print("ERROR: no speech segments detected — subtitle file would be empty", file=sys.stderr)
        sys.exit(1)

    write_srt(output_path, [(s, e, p + orig) for s, e, p, orig in entries])
    print(f"SRT written to {output_path} ({len(entries)} segments)", file=sys.stderr)

    # Compare base codes so 'en-us' counts as the same language as 'en'.
    needs_translation = bool(
        target_lang and translated_path
        and target_lang.lower().split("-")[0] != source_lang.lower()
    )
    if not needs_translation:
        return

    print(f"Translating {source_lang} -> {target_lang} via DeepL…", file=sys.stderr)
    try:
        translated = translate_lines([orig for _, _, _, orig in entries], target_lang)
    except Exception as e:
        # Keep the original subtitles but don't write a "translated" track
        # that is really the untranslated text.
        print(f"WARNING: translation failed, skipping translated subtitles: {e}", file=sys.stderr)
        return

    write_srt(translated_path, [(s, e, p + tr) for (s, e, p, _), tr in zip(entries, translated)])
    print(f"Translated SRT written to {translated_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
