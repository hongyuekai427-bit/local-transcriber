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

export interface TranscriptSegment {
  id: string;
  text: string;
  startTime: number; // seconds
  endTime: number; // seconds
  confidence?: number;
  language?: string;
  isUncertain?: boolean;
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

export interface Transcript {
  id: string;
  sourceId: string;
  segments: TranscriptSegment[];
  language: string;
  detectedLanguage?: string;
  mode: ProcessingMode;
  createdAt: Date;
}

export interface Translation {
  id: string;
  transcriptId: string;
  segments: TranslationSegment[];
  targetLanguage: string;
  createdAt: Date;
}

export interface SoundClassificationResult {
  id: string;
  sourceId: string;
  events: SoundEvent[];
  createdAt: Date;
}

export interface AudioSource {
  id: string;
  type: AudioSourceType;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  file?: File;
  audioBuffer?: AudioBuffer;
  objectUrl?: string;
  createdAt: Date;
}

export interface JobState {
  id: string;
  sourceId: string;
  status: JobStatus;
  mode: ProcessingMode;
  progress: number; // 0-100
  progressMessage: string;
  error?: string;
  transcript?: Transcript;
  translation?: Translation;
  soundEvents?: SoundClassificationResult;
  startedAt: Date;
  cancelled: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  task: string;
  size: string;
  languages?: string[];
  loaded: boolean;
  loading: boolean;
  error?: string;
}

export interface AppSettings {
  processingMode: ProcessingMode;
  sourceLanguage: string;
  targetLanguage: string;
  modelId: string;
  enableTranslation: boolean;
  enableWebGPU: boolean;
  enableTimestamps: boolean;
  chunkDuration: number; // seconds
  maxConcurrentJobs: number;
  processingProvider: 'local' | 'api';
  apiProvider?: string;
  apiKey?: string;
}

export interface WorkerMessage {
  type: 'transcribe' | 'classify' | 'translate' | 'cancel' | 'init';
  payload: unknown;
}

export interface WorkerResponse {
  type: 'progress' | 'result' | 'error' | 'status';
  payload: unknown;
}

// Supported languages for Whisper
export const SUPPORTED_LANGUAGES: Record<string, string> = {
  'en': 'English',
  'zh': 'Chinese (Mandarin)',
  'de': 'German',
  'es': 'Spanish',
  'ru': 'Russian',
  'ko': 'Korean',
  'fr': 'French',
  'ja': 'Japanese',
  'pt': 'Portuguese',
  'tr': 'Turkish',
  'pl': 'Polish',
  'ca': 'Catalan',
  'nl': 'Dutch',
  'ar': 'Arabic',
  'sv': 'Swedish',
  'it': 'Italian',
  'id': 'Indonesian',
  'hi': 'Hindi',
  'fi': 'Finnish',
  'vi': 'Vietnamese',
  'he': 'Hebrew',
  'uk': 'Ukrainian',
  'el': 'Greek',
  'ms': 'Malay',
  'cs': 'Czech',
  'ro': 'Romanian',
  'da': 'Danish',
  'hu': 'Hungarian',
  'ta': 'Tamil',
  'no': 'Norwegian',
  'th': 'Thai',
  'ur': 'Urdu',
  'hr': 'Croatian',
  'bg': 'Bulgarian',
  'lt': 'Lithuanian',
  'la': 'Latin',
  'mi': 'Maori',
  'ml': 'Malayalam',
  'cy': 'Welsh',
  'sk': 'Slovak',
  'te': 'Telugu',
  'fa': 'Persian',
  'lv': 'Latvian',
  'bn': 'Bengali',
  'sr': 'Serbian',
  'az': 'Azerbaijani',
  'sl': 'Slovenian',
  'kn': 'Kannada',
  'et': 'Estonian',
  'mk': 'Macedonian',
  'br': 'Breton',
  'eu': 'Basque',
  'is': 'Icelandic',
  'hy': 'Armenian',
  'ne': 'Nepali',
  'mn': 'Mongolian',
  'bs': 'Bosnian',
  'kk': 'Kazakh',
  'sq': 'Albanian',
  'sw': 'Swahili',
  'gl': 'Galician',
  'mr': 'Marathi',
  'pa': 'Punjabi',
  'si': 'Sinhala',
  'km': 'Khmer',
  'sn': 'Shona',
  'yo': 'Yoruba',
  'so': 'Somali',
  'af': 'Afrikaans',
  'oc': 'Occitan',
  'ka': 'Georgian',
  'be': 'Belarusian',
  'tg': 'Tajik',
  'sd': 'Sindhi',
  'gu': 'Gujarati',
  'am': 'Amharic',
  'yi': 'Yiddish',
  'lo': 'Lao',
  'uz': 'Uzbek',
  'fo': 'Faroese',
  'ht': 'Haitian Creole',
  'ps': 'Pashto',
  'tk': 'Turkmen',
  'nn': 'Nynorsk',
  'mt': 'Maltese',
  'sa': 'Sanskrit',
  'lb': 'Luxembourgish',
  'my': 'Myanmar',
  'bo': 'Tibetan',
  'tl': 'Tagalog',
  'mg': 'Malagasy',
  'as': 'Assamese',
  'tt': 'Tatar',
  'haw': 'Hawaiian',
  'ln': 'Lingala',
  'ha': 'Hausa',
  'ba': 'Bashkir',
  'jw': 'Javanese',
  'su': 'Sundanese',
};

// Whisper translation only supports translating TO English
export const TRANSLATION_TARGET_LANGUAGES: Record<string, string> = {
  'en': 'English',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'it': 'Italian',
  'pt': 'Portuguese',
  'nl': 'Dutch',
  'ru': 'Russian',
  'zh': 'Chinese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'ar': 'Arabic',
  'hi': 'Hindi',
  'tr': 'Turkish',
  'pl': 'Polish',
  'sv': 'Swedish',
  'uk': 'Ukrainian',
  'vi': 'Vietnamese',
  'id': 'Indonesian',
  'th': 'Thai',
};

export const WHISPER_MODELS = {
  'Xenova/whisper-tiny': { name: 'Whisper Tiny', size: '~75 MB', multilingual: true },
  'Xenova/whisper-base': { name: 'Whisper Base', size: '~145 MB', multilingual: true },
  'Xenova/whisper-small': { name: 'Whisper Small', size: '~470 MB', multilingual: true },
} as const;

export const SOUND_CLASSIFICATION_MODELS = {
  'Xenova/ast-finetuned-audioset-10-10-0.4593': { name: 'AST AudioSet', size: '~300 MB', labels: 527 },
} as const;

export type WhisperModelId = keyof typeof WHISPER_MODELS;
export type SoundModelId = keyof typeof SOUND_CLASSIFICATION_MODELS;
