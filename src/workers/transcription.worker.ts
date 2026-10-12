// Web Worker for running ML inference off the main thread
import { pipeline, env } from '@huggingface/transformers';

// Configure transformers.js for browser environment
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber: any = null;
let classifier: any = null;
let currentTask: { cancelled: boolean } | null = null;

interface TranscribePayload {
  audio: Float32Array;
  samplingRate: number;
  model: string;
  language?: string;
  task?: 'transcribe' | 'translate';
  chunkLength?: number;
  returnTimestamps?: boolean;
}

interface ClassifyPayload {
  audio: Float32Array;
  samplingRate: number;
  model: string;
  topK?: number;
}

interface TranslatePayload {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  model: string;
}

function postProgress(progress: number, message: string) {
  self.postMessage({
    type: 'progress',
    payload: { progress, message }
  });
}

function postResult(result: unknown) {
  self.postMessage({
    type: 'result',
    payload: result
  });
}

function postError(error: string) {
  self.postMessage({
    type: 'error',
    payload: { error }
  });
}

async function loadTranscriptionModel(modelId: string, useWebGPU: boolean = false) {
  if (transcriber) return;
  
  postProgress(0, 'Loading speech recognition model...');
  
  const device = useWebGPU ? 'webgpu' : 'wasm';
  const dtype = useWebGPU ? 'fp16' : 'q8';
  
  try {
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      device,
      dtype,
      progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
        if (progress.status === 'download' && progress.progress) {
          postProgress(
            Math.min(progress.progress, 95),
            `Downloading model files... ${Math.round(progress.progress)}%`
          );
        } else if (progress.status === 'init') {
          postProgress(90, 'Initializing model...');
        } else if (progress.status === 'ready') {
          postProgress(100, 'Model ready');
        }
      }
    }) as any;
    
    postProgress(100, 'Speech recognition model loaded');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    postError(`Failed to load transcription model: ${error}`);
    throw err;
  }
}

async function loadClassificationModel(modelId: string, useWebGPU: boolean = false) {
  if (classifier) return;
  
  postProgress(0, 'Loading sound classification model...');
  
  const device = useWebGPU ? 'webgpu' : 'wasm';
  const dtype = useWebGPU ? 'fp16' : 'q8';
  
  try {
    classifier = await pipeline('audio-classification', modelId, {
      device,
      dtype,
      progress_callback: (progress: { status: string; progress?: number }) => {
        if (progress.status === 'download' && progress.progress) {
          postProgress(
            Math.min(progress.progress, 95),
            `Downloading classification model... ${Math.round(progress.progress)}%`
          );
        } else if (progress.status === 'ready') {
          postProgress(100, 'Classification model ready');
        }
      }
    }) as any;
    
    postProgress(100, 'Sound classification model loaded');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    postError(`Failed to load classification model: ${error}`);
    throw err;
  }
}

async function handleTranscribe(payload: TranscribePayload) {
  const task = { cancelled: false };
  currentTask = task;
  
  try {
    await loadTranscriptionModel(payload.model);
    
    if (task.cancelled) {
      postResult({ type: 'cancelled' });
      return;
    }
    
    postProgress(50, 'Transcribing audio...');
    
    const options: Record<string, unknown> = {
      return_timestamps: payload.returnTimestamps ?? true,
      chunk_length_s: payload.chunkLength ?? 30,
      stride_length_s: 5,
    };
    
    if (payload.language && payload.language !== 'auto') {
      options.language = payload.language;
    }
    
    if (payload.task === 'translate') {
      options.task = 'translate';
    }
    
    const result = await (transcriber as any)(payload.audio, options);
    
    if (task.cancelled) {
      postResult({ type: 'cancelled' });
      return;
    }
    
    // Process result into segments
    const segments = [];
    if (result.chunks && Array.isArray(result.chunks)) {
      for (let i = 0; i < result.chunks.length; i++) {
        const chunk = result.chunks[i];
        segments.push({
          id: `seg-${i}`,
          text: chunk.text?.trim() || '',
          startTime: chunk.timestamp?.[0] ?? 0,
          endTime: chunk.timestamp?.[1] ?? 0,
          language: payload.language !== 'auto' ? payload.language : result.language,
        });
      }
    } else {
      segments.push({
        id: 'seg-0',
        text: result.text?.trim() || '',
        startTime: 0,
        endTime: 0,
        language: result.language,
      });
    }
    
    postResult({
      type: 'transcription',
      segments,
      language: result.language || payload.language || 'unknown',
    });
    
  } catch (err) {
    if (task.cancelled) {
      postResult({ type: 'cancelled' });
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    postError(`Transcription failed: ${error}`);
  }
}

async function handleClassify(payload: ClassifyPayload) {
  const task = { cancelled: false };
  currentTask = task;
  
  try {
    await loadClassificationModel(payload.model);
    
    if (task.cancelled) {
      postResult({ type: 'cancelled' });
      return;
    }
    
    postProgress(50, 'Classifying audio...');
    
    const result = await (classifier as any)(payload.audio, {
      topk: payload.topK ?? 5,
    });
    
    if (task.cancelled) {
      postResult({ type: 'cancelled' });
      return;
    }
    
    const events = Array.isArray(result) ? result.map((r: { label: string; score: number }, i: number) => ({
      label: r.label,
      score: r.score,
      startTime: 0,
      endTime: 0,
    })) : [];
    
    postResult({
      type: 'classification',
      events,
    });
    
  } catch (err) {
    if (task.cancelled) {
      postResult({ type: 'cancelled' });
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    postError(`Classification failed: ${error}`);
  }
}

async function handleTranslate(payload: TranslatePayload) {
  const task = { cancelled: false };
  currentTask = task;
  
  try {
    // Use Whisper's built-in translation (only supports -> English)
    if (payload.targetLanguage === 'en') {
      await loadTranscriptionModel(payload.model);
      
      if (task.cancelled) {
        postResult({ type: 'cancelled' });
        return;
      }
      
      postProgress(50, 'Translating to English...');
      
      // For text translation, we note that Whisper translates audio->English
      // For text-to-text translation, we'd need a different model
      // Here we acknowledge the limitation
      postResult({
        type: 'translation',
        note: 'Whisper model translates speech directly to English. For text-to-text translation, a separate translation model is needed.',
        segments: [],
        targetLanguage: payload.targetLanguage,
      });
    } else {
      postResult({
        type: 'translation',
        note: `Translation to ${payload.targetLanguage} requires a dedicated translation model. Whisper only supports direct translation to English from speech.`,
        segments: [],
        targetLanguage: payload.targetLanguage,
      });
    }
    
  } catch (err) {
    if (task.cancelled) {
      postResult({ type: 'cancelled' });
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    postError(`Translation failed: ${error}`);
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { type, payload } = event.data;
  
  switch (type) {
    case 'transcribe':
      await handleTranscribe(payload as TranscribePayload);
      break;
    case 'classify':
      await handleClassify(payload as ClassifyPayload);
      break;
    case 'translate':
      await handleTranslate(payload as TranslatePayload);
      break;
    case 'cancel':
      if (currentTask) {
        currentTask.cancelled = true;
      }
      break;
    case 'init':
      // Pre-initialization message
      postProgress(0, 'Worker initialized');
      break;
    default:
      postError(`Unknown message type: ${type}`);
  }
};
