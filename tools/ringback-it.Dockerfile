# Italian runtime layered over the pinned upstream Ringback image built by
# tools/setup-ringback.sh. Keeping this as a thin layer makes upstream updates
# and the Steward-specific language choices independently reviewable.
ARG RINGBACK_BASE=ringback:steward-base
FROM ${RINGBACK_BASE}

RUN curl -fL "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" \
      -o /root/.whisper-models/ggml-base.bin \
    && PIPER_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium" \
    && curl -fL "$PIPER_URL/it_IT-paola-medium.onnx" \
      -o /root/.piper-voices/it_IT-paola-medium.onnx \
    && curl -fL "$PIPER_URL/it_IT-paola-medium.onnx.json" \
      -o /root/.piper-voices/it_IT-paola-medium.onnx.json

ENV WHISPER_SERVER_MODEL=/root/.whisper-models/ggml-base.bin \
    WHISPER_MODEL=/root/.whisper-models/ggml-base.bin \
    VOICE_PIPER_MODEL=/root/.piper-voices/it_IT-paola-medium.onnx \
    VOICE_TTS=piper
