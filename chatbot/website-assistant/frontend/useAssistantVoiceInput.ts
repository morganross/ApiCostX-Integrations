import { useCallback, useEffect, useRef, useState } from 'react'
import { assistantApi } from '@/api/assistant'

type UseAssistantVoiceInputOptions = {
  onTranscript: (text: string) => void
  onError: (message: string) => void
}

type UseAssistantVoiceInputResult = {
  isRecording: boolean
  isTranscribing: boolean
  isSupported: boolean
  statusText: string | null
  toggleRecording: () => Promise<void>
  stopRecording: () => void
}

export function useAssistantVoiceInput({
  onTranscript,
  onError,
}: UseAssistantVoiceInputOptions): UseAssistantVoiceInputResult {
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const isSupported =
    typeof window !== 'undefined' &&
    Boolean(window.navigator?.mediaDevices?.getUserMedia) &&
    typeof window.MediaRecorder !== 'undefined'

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
  }, [])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      cleanupStream()
      setIsRecording(false)
      return
    }
    recorder.stop()
  }, [cleanupStream])

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      onError('Voice input is not supported in this browser.')
      return
    }

    try {
      const stream = await window.navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = preferredAudioMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        cleanupStream()
        setIsRecording(false)
        setIsTranscribing(false)
        onError('The microphone stopped unexpectedly. Please try again.')
      }

      recorder.onstop = () => {
        const chunks = chunksRef.current
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        cleanupStream()
        setIsRecording(false)
        chunksRef.current = []

        if (!audio.size) {
          onError('I did not catch any audio. Please try again.')
          return
        }

        setIsTranscribing(true)
        assistantApi.transcribeAudio(audio)
          .then((result) => {
            const transcript = result.text?.trim()
            if (!transcript) {
              onError('I could not hear any words in that recording.')
              return
            }
            onTranscript(transcript)
          })
          .catch((error) => {
            onError(error instanceof Error ? error.message : 'Voice transcription failed. Please try again.')
          })
          .finally(() => setIsTranscribing(false))
      }

      recorder.start()
      setIsRecording(true)
    } catch (error) {
      cleanupStream()
      setIsRecording(false)
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow microphone access to use voice input.'
          : error instanceof Error
            ? error.message
            : 'Could not start microphone recording.'
      onError(message)
    }
  }, [cleanupStream, isSupported, onError, onTranscript])

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      stopRecording()
      return
    }
    await startRecording()
  }, [isRecording, startRecording, stopRecording])

  useEffect(() => {
    return () => {
      cleanupStream()
    }
  }, [cleanupStream])

  return {
    isRecording,
    isTranscribing,
    isSupported,
    statusText: isRecording ? 'Listening...' : isTranscribing ? 'Transcribing...' : null,
    toggleRecording,
    stopRecording,
  }
}

function preferredAudioMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
}
