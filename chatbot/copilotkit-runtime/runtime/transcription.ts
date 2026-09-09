import type { RuntimeConfig } from "./config.js";
import { readProviderKey } from "./secrets.js";

type UnknownRecord = Record<string, unknown>;

export type AssistantTranscriptionResult = {
  status: "ok";
  provider: "openai_audio_transcription";
  model: string;
  text: string;
};

export class TranscriptionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TranscriptionError";
    this.status = status;
  }
}

export async function transcribeAssistantAudio({
  config,
  audio,
  mimeType,
}: {
  config: RuntimeConfig;
  audio: Buffer;
  mimeType: string;
}): Promise<AssistantTranscriptionResult> {
  if (!config.transcriptionEnabled) {
    throw new TranscriptionError(503, "Assistant voice transcription is disabled.");
  }
  if (!audio.length) {
    throw new TranscriptionError(400, "Audio recording is empty.");
  }
  if (audio.length > config.transcriptionMaxAudioBytes) {
    throw new TranscriptionError(413, "Audio recording is too long.");
  }

  const openAiKey = readProviderKey(config.providerKeysPath, "OPENAI_API_KEY");
  if (!openAiKey) {
    throw new TranscriptionError(503, "Assistant voice transcription is not configured because OPENAI_API_KEY is missing.");
  }

  const model = normalizeOpenAIModelName(config.transcriptionModel);
  const text = await callOpenAITranscription({
    apiKey: openAiKey,
    model,
    audio,
    mimeType: normalizeAudioMimeType(mimeType),
    timeoutMs: config.transcriptionTimeoutMs,
  });

  if (!text) {
    throw new TranscriptionError(502, "The transcription provider returned no text.");
  }

  return {
    status: "ok",
    provider: "openai_audio_transcription",
    model,
    text,
  };
}

async function callOpenAITranscription({
  apiKey,
  model,
  audio,
  mimeType,
  timeoutMs,
}: {
  apiKey: string;
  model: string;
  audio: Buffer;
  mimeType: string;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    const audioBytes = new Uint8Array(audio);
    const file = new Blob([audioBytes], { type: mimeType });
    form.append("file", file, recordingFilenameForMimeType(mimeType));
    form.append("model", model);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = getProviderErrorMessage(data) || `OpenAI transcription failed (${response.status}).`;
      throw new TranscriptionError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
    }
    return isRecord(data) && typeof data.text === "string" ? data.text.trim() : "";
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new TranscriptionError(504, "Assistant voice transcription timed out.");
    }
    const message = error instanceof Error ? error.message : "Assistant voice transcription failed.";
    throw new TranscriptionError(502, message);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOpenAIModelName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "gpt-4o-mini-transcribe";
  const separatorIndex = trimmed.indexOf(":");
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1);
}

function normalizeAudioMimeType(value: string): string {
  const normalized = value.split(";")[0]?.trim().toLowerCase();
  if (!normalized || normalized === "application/octet-stream") return "audio/webm";
  return normalized;
}

function recordingFilenameForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "recording.mp3";
  if (mimeType.includes("wav")) return "recording.wav";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

function getProviderErrorMessage(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const error = data.error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof data.message === "string") return data.message;
  return null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
