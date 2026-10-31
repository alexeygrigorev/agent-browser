"""Transcribe a teach recording with faster-whisper (local, no paid service).

Usage: python teach-transcribe.py <audio.wav> <transcript.json>
Environment: AGENT_BROWSER_WHISPER_MODEL (default "small"),
AGENT_BROWSER_WHISPER_LANGUAGE (default: detect).
"""
import json
import os
import sys
import wave


def load(path):
    """Teach audio is 16 kHz mono 16-bit WAV: decode it here so faster-whisper
    does not need PyAV, whose newer releases break its file decoding."""
    try:
        import numpy
        with wave.open(path, "rb") as handle:
            if handle.getframerate() == 16000 and handle.getnchannels() == 1 and handle.getsampwidth() == 2 and handle.getnframes():
                return numpy.frombuffer(handle.readframes(handle.getnframes()), dtype=numpy.int16).astype(numpy.float32) / 32768.0
    except (wave.Error, EOFError, ImportError):
        pass
    return path


def main():
    audio, output = sys.argv[1], sys.argv[2]
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write("faster-whisper is not installed. Install it with: python -m pip install --user faster-whisper\n")
        return 3
    model_name = os.environ.get("AGENT_BROWSER_WHISPER_MODEL", "small")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        load(audio),
        language=os.environ.get("AGENT_BROWSER_WHISPER_LANGUAGE") or None,
        vad_filter=True,
        beam_size=5,
    )
    result = {
        "engine": "faster-whisper",
        "model": model_name,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "segments": [
            {"start": round(segment.start, 2), "end": round(segment.end, 2), "text": segment.text.strip()}
            for segment in segments
        ],
    }
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps({"segments": len(result["segments"]), "language": result["language"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
