const fs = require('fs');
const path = require('path');

async function transcribeAudioFile(audioPath) {
    const formData = new FormData();

    const audioBuffer = fs.readFileSync(audioPath);
    const fileName = path.basename(audioPath);

    formData.append(
        'audio',
        new Blob([audioBuffer], { type: 'audio/webm' }),
        fileName
    );

    const response = await fetch('http://127.0.0.1:8765/transcribe', {
        method: 'POST',
        body: formData
    });

    const responseText = await response.text();

    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        throw new Error(
            `Local Whisper returned non-JSON response: ${response.status} ${responseText.slice(0, 200)}`
        );
    }

    if (!response.ok) {
        throw new Error(result.error || 'Local Whisper transcription failed.');
    }

    return result.text;
}

module.exports = {
    transcribeAudioFile
};