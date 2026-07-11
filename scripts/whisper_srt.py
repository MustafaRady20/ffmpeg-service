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

    # Use Whisper's built-in translation when the target is English — avoids
    # an argostranslate runtime download and produces higher-quality output.
    whisper_task = "translate" if target_lang == "en" else "transcribe"
    segments, info = model.transcribe(audio_path, beam_size=5, task=whisper_task)
    segments = list(segments)  # consume generator before opening file

    source_lang = info.language
    print(f"Detected language: {source_lang} (task={whisper_task})", file=sys.stderr)

    # For non-English targets we still need argostranslate.
    needs_argos = target_lang and target_lang != "en" and target_lang != source_lang
    if needs_argos:
        print(f"Translating {source_lang} -> {target_lang}…", file=sys.stderr)
        ensure_argos_package(source_lang, target_lang)

    with open(output_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            text = seg.text.strip()
            if needs_argos:
                text = translate_text(text, source_lang, target_lang)
            f.write(f"{i}\n")
            f.write(f"{format_timestamp(seg.start)} --> {format_timestamp(seg.end)}\n")
            f.write(f"{text}\n\n")

    print(f"SRT written to {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
