// Core type definitions for the transcription application

export type JobStatus =
  | 'idle'
  | 'validating'
  | 'decoding'
  | 'waiting_for_model'
  | 'downloading_model'
  | 'initializing_model'
  | 'processing'
  | 'translating'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ProcessingMode = 'speech' | 'song' | 'sound_classification';

export type AudioSourceType = 'file' | 'microphone' | 'display_capture';

export type LiveSessionState =
  | 'idle'
  | 'requesting_permission'
  | 'ready'
  | 'capturing'
  | 'paused'
  | 'processing_stopped'
  | 'ended'
  | 'error';

export interface TranscriptSegment {
  id: string;
  text: string;
  startTime: number; // seconds from session/file start
  endTime: number; // seconds from session/file start
  confidence?: number;
  language?: string;
  isUncertain?: boolean;
  isPartial?: boolean; // true for live partial hypotheses
  sourceIndex?: number; // for multi-file queue
}

export interface TranslationSegment {
  id: string;
  originalId: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface SoundEvent {
  label: string;
  score: number;
  startTime?: number;
  endTime?: number;
}

export interface TranscriptSession {
  id: string;
  sourceLabel: string;
  sourceType: AudioSourceType | 'queue';
  mode: ProcessingMode;
  segments: TranscriptSegment[];
  partialSegment?: TranscriptSegment | null;
  language: string;
  detectedLanguage?: string;
  translatedSegments: TranslationSegment[];
  soundEvents: SoundEvent[];
  status: JobStatus | LiveSessionState;
  modelId?: string;
  createdAt: Date;
  updatedAt: Date;
  // For file queue
  fileName?: string;
  fileSize?: number;
  duration?: number;
  // Live session metadata
  isLive?: boolean;
  liveState?: LiveSessionState;
  processingBacklog?: number;
  droppedChunks?: number;
}

export interface FileQueueItem {
  id: string;
  file: File;
  name: string;
  size: number;
  status: JobStatus;
  progress: number;
  progressMessage: string;
  transcriptSessionId?: string;
  error?: string;
  addedAt: Date;
}

export interface AudioSource {
  id: string;
  type: AudioSourceType;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  file?: File;
  objectUrl?: string;
  createdAt: Date;
}

export interface AppSettings {
  processingMode: ProcessingMode;
  sourceLanguage: string;
  targetLanguage: string;
  modelId: string;
  enableTranslation: boolean;
  enableWebGPU: boolean;
  enableTimestamps: boolean;
  chunkDuration: number;
  maxConcurrentJobs: number;
  processingProvider: 'local' | 'api';
  apiProvider?: string;
  apiKey?: string;
  // Live transcription settings
  liveChunkDuration: number; // seconds of audio per live chunk
  liveOverlapDuration: number; // seconds of overlap for deduplication
  maxBufferedChunks: number; // max chunks in processing queue
}

export const SUPPORTED_LANGUAGES: Record<string, string> = {
  'en': 'English', 'zh': 'Chinese', 'de': 'German', 'es': 'Spanish',
  'ru': 'Russian', 'ko': 'Korean', 'fr': 'French', 'ja': 'Japanese',
  'pt': 'Portuguese', 'tr': 'Turkish', 'pl': 'Polish', 'nl': 'Dutch',
  'ar': 'Arabic', 'sv': 'Swedish', 'it': 'Italian', 'id': 'Indonesian',
  'hi': 'Hindi', 'fi': 'Finnish', 'vi': 'Vietnamese', 'uk': 'Ukrainian',
  'el': 'Greek', 'cs': 'Czech', 'ro': 'Romanian', 'da': 'Danish',
  'hu': 'Hungarian', 'ta': 'Tamil', 'no': 'Norwegian', 'th': 'Thai',
  'hr': 'Croatian', 'bg': 'Bulgarian', 'fa': 'Persian', 'bn': 'Bengali',
  'sr': 'Serbian', 'sk': 'Slovak', 'et': 'Estonian', 'ca': 'Catalan',
  'lv': 'Latvian', 'lt': 'Lithuanian', 'sl': 'Slovenian', 'gl': 'Galician',
  'he': 'Hebrew', 'ms': 'Malay', 'kn': 'Kannada', 'te': 'Telugu',
  'ml': 'Malayalam', 'mr': 'Marathi', 'pa': 'Punjabi', 'ur': 'Urdu',
  'sw': 'Swahili', 'af': 'Afrikaans',
};

export const TRANSLATION_TARGET_LANGUAGES: Record<string, string> = {
  'en': 'English', 'fr': 'French', 'de': 'German', 'es': 'Spanish',
  'it': 'Italian', 'pt': 'Portuguese', 'nl': 'Dutch', 'ru': 'Russian',
  'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean', 'ar': 'Arabic',
  'hi': 'Hindi', 'tr': 'Turkish', 'pl': 'Polish', 'sv': 'Swedish',
  'uk': 'Ukrainian', 'vi': 'Vietnamese', 'id': 'Indonesian', 'th': 'Thai',
};

export const WHISPER_MODELS = {
  'Xenova/whisper-tiny': { name: 'Whisper Tiny', size: '~75 MB', multilingual: true },
  'Xenova/whisper-base': { name: 'Whisper Base', size: '~145 MB', multilingual: true },
  'Xenova/whisper-small': { name: 'Whisper Small', size: '~470 MB', multilingual: true },
} as const;

export type WhisperModelId = keyof typeof WHISPER_MODELS;
