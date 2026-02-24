# Ragnar Voice Stack Plan

_Last updated: 2026-02-24_

## Goal
Build a fully self-hosted voice assistant pipeline so Ragnar can speak directly with callers without relying on OpenAI Realtime or other closed speech APIs.

Twilio calls → Phone Bridge → Voice Relay → **Ragnar Backend v2** (ASR + reasoning + TTS) → Voice Relay → Phone Bridge → caller.

## Requirements
1. **No OpenAI Realtime** – all ASR/TTS/LLM hosting must be under our control.
2. **Bi-directional audio** – callers hear Ragnar’s synthesized speech; Ragnar hears callers via streamed PCM.
3. **Low latency** – end-to-end round-trip target < 1.2s, stretch < 800ms.
4. **Composable** – ASR, reasoning, and TTS modules must be swappable.
5. **Deployable on Render (short term)** and easily portable to GPU hosts.

## Architecture
```
Twilio → Phone Bridge → Voice Relay ⇄ Ragnar Backend v2 ⇄ Voice Relay → Phone Bridge → Twilio
                                     ├─ ASR module (PCM → text deltas)
                                     ├─ Conversation core (this assistant)
                                     └─ TTS module (text deltas → PCM)
```

### Ragnar Backend v2 responsibilities
- Terminate `/relay` WebSocket from Voice Relay.
- Accept inbound `audio_chunk` events (PCM16 @16kHz) and forward into ASR pipeline.
- Emit `transcript`/`text_delta` events as ASR produces results.
- Feed transcripts into Ragnar’s reasoning loop (this assistant) to produce responses.
- Stream `text_delta`, `text_completed`, and `audio_delta` (PCM) events back downstream.
- Manage per-call session state (conversation summary, sentiment, call metadata).

## Work Breakdown

### 1. ASR module (self-hosted)
- Evaluate Whisper.cpp, Vosk, DeepSpeech, and faster alternatives (e.g., Faster-Whisper).
- Requirements: streaming input, ability to run on CPU/GPU, <500ms partial results.
- Input: 20ms PCM chunks from Twilio via relay.
- Output: interim + final transcripts, timestamps to align responses.
- Deliverables:
  - Module spec + API (probably gRPC/WebSocket inside backend).
  - Dockerfile/Render run command.

### 2. Conversation core
- Wrap this assistant in a service that accepts transcripts, maintains dialog state, and outputs intents + response text.
- Add safeguards (profane filtering, escalate-to-human hooks, logging to Supabase).

### 3. TTS module
- Investigate Piper, Coqui TTS, Bark, plus neural vocoders we can host.
- Requirements: low latency (<400ms), streaming PCM output, voice customization.
- Output chunk size should match relay expectations (~20ms PCM16).

### 4. Event router + session manager
- Manage ASR/TTS subprocesses per call.
- Backpressure control (pause Twilio stream if needed).
- Error handling + reconnection logic.

### 5. Tooling & Monitoring
- `/healthz` should expose ASR/TTS readiness + queue depth.
- Structured logging sent to Supabase or Render logs.
- Unit/integration tests for:
  - PCM ingestion
  - ASR accuracy on sample utterances
  - TTS streaming to client
  - Full call simulation (mock Twilio)

## Milestones
1. **Spec & spike** (today): finalize ASR + TTS choices, document resource requirements. _Owner: Ragnar._
2. **ASR prototype**: streaming Whisper.cpp/Faster-Whisper container returning deltas. _ETA: +2 days._
3. **TTS prototype**: Piper/Coqui streaming service. _ETA: +2 days (parallel)._ 
4. **Backend integration**: wire ASR + TTS with conversation loop, implement `/relay`. _ETA: +3 days._
5. **E2E call test**: calibrate latency, handle edge cases, rotate into production. _ETA: +1 day after integration._

## Open Questions
- Target hardware for ASR/TTS (GPU vs CPU) on Render? Might require dedicated GPU host.
- Persistent storage for call transcripts/audio? (Supabase buckets vs S3.)
- Voice persona: synth voice characteristics, fallback voices.
- Escalation flow when ASR confidence is low.

---
Next action: begin ASR module evaluation + prototype configs.
