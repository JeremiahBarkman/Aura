import sys
import whisper

if len(sys.argv) < 2:
    print("ERROR: Please provide an audio file path.")
    sys.exit(1)

audio_path = sys.argv[1]

model = whisper.load_model("base")

result = model.transcribe(audio_path)

print(result["text"].strip())