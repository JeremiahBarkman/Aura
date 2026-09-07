from flask import Flask, request, jsonify
from flask_cors import CORS
from faster_whisper import WhisperModel
import ctypes
import glob
import tempfile
import os
import sys

app = Flask(__name__)
CORS(app)

# Whisper model size. "base" is multilingual (~99 languages) and fast on CPU,
# but its accuracy on non-English speech is noticeably weaker than the larger
# sizes. Set WHISPER_MODEL=small (or medium) for materially better non-English
# transcription at the cost of speed/RAM. NOTE: the ".en" variants
# (base.en, small.en) are ENGLISH-ONLY -- do not use them if you need
# multilingual support.
def env_or(name, fallback):
    """Read an env var, treating blank as "not set".

    os.environ.get(name, default) only falls back when the key is ABSENT.
    Aura's .env ships these keys present-but-empty (documented as "leave
    empty to use the default"), and dotenv passes that through as "". That
    reached faster-whisper as model size "" and killed the service on
    startup with:  ValueError: Invalid model size ''
    """
    value = os.environ.get(name)
    if value is None:
        return fallback
    value = value.strip()
    return value if value else fallback


WHISPER_MODEL = env_or("WHISPER_MODEL", "base")

# "cpu" is the safe default. Set WHISPER_DEVICE=cuda with
# WHISPER_COMPUTE_TYPE=float16 if you have a working CUDA setup and want
# larger models to stay fast.
WHISPER_DEVICE = env_or("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = env_or("WHISPER_COMPUTE_TYPE", "int8")

# CTranslate2 lazy-loads cuBLAS/cuDNN from its own internal thread pool on
# first inference. A system-wide CUDA Toolkit + cuDNN install is already
# visible to it; the block below covers the lighter alternative (no multi-GB
# installer, no reboot):
#   pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
# into this venv. It no-ops (and CTranslate2 raises its own clear error) if
# neither is present.
#
# The two platforms need genuinely different mechanisms, not just different
# paths:
#
#   Windows -- that thread pool does not inherit os.add_dll_directory(), so
#   PATH is the only DLL search mechanism that reaches it. Prepending the
#   package's bin/ is enough.
#
#   Linux -- mutating LD_LIBRARY_PATH here would do nothing: glibc's loader
#   reads it once at process start, so a later dlopen() ignores the change.
#   Loading each .so explicitly with RTLD_GLOBAL instead puts the symbols in
#   the process before CTranslate2 asks for them, which is what it actually
#   needs.
def _prepare_cuda_libraries():
    venv_root = os.path.dirname(os.path.dirname(sys.executable))

    if sys.platform == "win32":
        site_packages = os.path.join(venv_root, "Lib", "site-packages")

        for nvidia_pkg in ("cublas", "cudnn", "cuda_nvrtc"):
            dll_dir = os.path.join(site_packages, "nvidia", nvidia_pkg, "bin")

            if os.path.isdir(dll_dir):
                os.environ["PATH"] = dll_dir + os.pathsep + os.environ["PATH"]

        return

    # The venv's site-packages is under a version-named directory
    # (lib/python3.12/site-packages), so glob rather than hardcode it.
    candidates = glob.glob(
        os.path.join(venv_root, "lib", "python*", "site-packages", "nvidia", "*", "lib", "*.so*")
    )

    for library_path in sorted(candidates):
        try:
            ctypes.CDLL(library_path, mode=ctypes.RTLD_GLOBAL)
        except OSError:
            # Not every .so in those directories is loadable standalone;
            # the ones CTranslate2 needs are, and it reports its own error
            # if they turn out to be missing.
            pass


if WHISPER_DEVICE == "cuda":
    _prepare_cuda_libraries()

print(f"Loading Whisper model '{WHISPER_MODEL}' on {WHISPER_DEVICE} ({WHISPER_COMPUTE_TYPE})...")

model = WhisperModel(
    WHISPER_MODEL,
    device=WHISPER_DEVICE,
    compute_type=WHISPER_COMPUTE_TYPE
)

print("Whisper model loaded.")

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})

@app.route("/transcribe", methods=["POST"])
def transcribe_audio():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file uploaded"}), 400

    audio_file = request.files["audio"]

    with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as temp:
        audio_path = temp.name
        audio_file.save(audio_path)

    try:
        segments, info = model.transcribe(audio_path)

        text = " ".join(segment.text for segment in segments)

        return jsonify({
            "text": text.strip(),
            "language": info.language
        })

    finally:
        if os.path.exists(audio_path):
            os.remove(audio_path)

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=8765,
        debug=False
    )