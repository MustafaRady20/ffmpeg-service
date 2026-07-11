#!/usr/bin/env python3
"""
Usage: python3 whisper_srt.py <audio_path> <srt_output_path> [model_size] [target_lang]

Transcribes audio using faster-whisper and writes an SRT subtitle file.
Optionally translates subtitles to target_lang using argostranslate (e.g. 'de', 'fr', 'es').
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


def ensure_argos_package(from_code: str, to_code: str) -> None:
    import argostranslate.package
    import argostranslate.translate

    installed = argostranslate.translate.get_installed_languages()
    from_lang = next((l for l in installed if l.code == from_code), None)
    if from_lang:
        to_lang = next((l for l in installed if l.code == to_code), None)
        if to_lang and from_lang.get_translation(to_lang):
            return  # already installed

    print(f"Downloading Argos Translate package {from_code} -> {to_code}…", file=sys.stderr)
    argostranslate.package.update_package_index()
    available = argostranslate.package.get_available_packages()
    pkg = next(
        (p for p in available if p.from_code == from_code and p.to_code == to_code),
        None,
    )
    if pkg is None:
        raise RuntimeError(
            f"No Argos Translate package available for {from_code} -> {to_code}. "
            "See https://www.argosopentech.com/argospm/index/ for supported pairs."
        )
    argostranslate.package.install_from_path(pkg.download())


def translate_text(text: str, from_code: str, to_code: str) -> str:
    import argostranslate.translate

    installed = argostranslate.translate.get_installed_languages()
    from_lang = next((l for l in installed if l.code == from_code), None)
    to_lang = next((l for l in installed if l.code == to_code), None)
    if not from_lang or not to_lang:
        raise RuntimeError(f"Language not available after install: {from_code} or {to_code}")
    translation = from_lang.get_translation(to_lang)
    if not translation:
        raise RuntimeError(f"No translation object for {from_code} -> {to_code}")
    return translation.translate(text)


def main():
    if len(sys.argv) < 3:
        print("Usage: whisper_srt.py <audio_path> <srt_output_path> [model_size] [target_lang]", file=sys.stderr)
        sys.exit(1)

    audio_path  = sys.argv[1]
    output_path = sys.argv[2]
    model_size  = sys.argv[3] if len(sys.argv) > 3 else "small"
    target_lang = sys.argv[4] if len(sys.argv) > 4 else None

    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    # When translation is requested, always use Whisper's native task='translate'
    # to produce English text first.  This avoids needing a direct
    # source_lang → target_lang argostranslate package (e.g. es→ar), which often
    # doesn't exist.  We only ever need en→target_lang packages, which are widely
    # available.  For English targets, we're done after this step.
    whisper_task = "translate" if target_lang else "transcribe"
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        task=whisper_task,
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
    print(f"Detected language: {source_lang} (task={whisper_task})", file=sys.stderr)

    # Argostranslate step: only needed when target is something other than English
    # (Whisper already produced English above).  Always translate FROM English.
    needs_argos = bool(target_lang and target_lang != "en")
    if needs_argos:
        print(f"Translating en -> {target_lang}…", file=sys.stderr)
        ensure_argos_package("en", target_lang)

    count = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for seg in segments:
            text = seg.text.strip()
            # Skip noise-only tokens and empty segments produced by overlapping
            # speakers or background sound — writing empty SRT entries causes
            # FFmpeg to reject the subtitle track.
            if not text:
                continue
            if needs_argos:
                try:
                    text = translate_text(text, "en", target_lang)
                except Exception as e:
                    # Keep the original segment rather than failing the whole file.
                    print(f"WARNING: translation failed for segment, keeping original: {e}", file=sys.stderr)
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
