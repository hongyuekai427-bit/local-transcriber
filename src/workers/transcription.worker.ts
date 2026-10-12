// Web Worker for ML inference - supports both batch and chunk-based live transcription
import { pipeline, env } from '@huggingface/transformers';

// Configure transformers.js for browser environment
env.allowLocalModels = false;
env.useBrowserCache = true;

// Model instances
let transcriber: any = null;
let classifier: any = null;
let modelLoading: Promise<void> | null = null;
let currentModelId: string | null = null;

function post(type: string, payload: unknown) {
  self.postMessage({ type, payload });
}

async function ensureModel(modelId: string, useWebGPU: boolean = false): Promise<void> {
  if (transcriber && currentModelId === modelId) return;
  if (modelLoading) return modelLoading;
  
  modelLoading = (async () => {
    post('model_progress', { progress: 0, message: 'Loading speech recognition model...' });
    
    const device = useWebGPU ? 'webgpu' : 'wasm';
    const dtype = useWebGPU ? 'q4' : 'q8';
    
    try {
      transcriber = await pipeline('automatic-speech-recognition', modelId, {
        device,
        dtype,
        progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
          if (progress.status === 'download' && progress.progress !== undefined) {
            post('model_progress', {
              progress: Math.min(progress.progress, 95),
              message: `Downloading model... ${Math.round(progress.progress)}%`
            });
          } else if (progress.status === 'init') {
            post('model_progress', { progress: 90, message: 'Initializing model...' });
          } else if (progress.status === 'progress' && progress.progress !== undefined) {
            post('model_progress', {
              progress: Math.min(progress.progress, 95),
              message: `Loading... ${Math.round(progress.progress)}%`
            });
          } else if (progress.status === 'ready') {
            post('model_progress', { progress: 100, message: 'Model ready' });
          }
        }
      });
      
      currentModelId = modelId;
      post('model_ready', { modelId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      post('error', { error: `Failed to load model: ${error}` });
      throw err;
    } finally {
      modelLoading = null;
    }
  })();
  
  return modelLoading;
}

async function ensureClassifier(modelId: string, useWebGPU: boolean = false): Promise<void> {
  if (classifier) return;
  
  post('model_progress', { progress: 0, message: 'Loading sound classification model...' });
  
  const device = useWebGPU ? 'webgpu' : 'wasm';
  const dtype = useWebGPU ? 'q4' : 'q8';
  
  try {
    classifier = await pipeline('audio-classification', modelId, {
      device,
      dtype,
      progress_callback: (progress: { status: string; progress?: number }) => {
        if (progress.status === 'download' && progress.progress !== undefined) {
          post('model_progress', {
            progress: Math.min(progress.progress, 95),
            message: `Downloading model... ${Math.round(progress.progress)}%`
          });
        } else if (progress.status === 'ready') {
          post('model_progress', { progress: 100, message: 'Classification model ready' });
        }
      }
    });
    
    post('model_ready', { modelId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post('error', { error: `Failed to load classification model: ${error}` });
    throw err;
  }
}

// Handle batch transcription (for file processing)
async function handleTranscribe(payload: {
  audio: Float32Array;
  samplingRate: number;
  model: string;
  language?: string;
  task?: 'transcribe' | 'translate';
  chunkLength?: number;
  returnTimestamps?: boolean;
  useWebGPU?: boolean;
}) {
  try {
    await ensureModel(payload.model, payload.useWebGPU);
    
    post('progress', { progress: 30, message: 'Transcribing audio...' });
    
    const options: Record<string, unknown> = {
      return_timestamps: payload.returnTimestamps ?? true,
      chunk_length_s: payload.chunkLength ?? 30,
      stride_length_s: 5,
    };
    
    if (payload.language) {
      options.language = payload.language;
    }
    
    if (payload.task === 'translate') {
      options.task = 'translate';
    }
    
    const result = await transcriber(payload.audio, options);
    
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
          language: payload.language || result.language,
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
    
    post('result', {
      type: 'transcription',
      segments,
      language: result.language || payload.language || 'unknown',
    });
    
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post('error', { error: `Transcription failed: ${error}` });
  }
}

// Handle single chunk transcription (for live streaming)
async function handleTranscribeChunk(payload: {
  audio: Float32Array;
  samplingRate: number;
  chunkIndex: number;
  chunkStartTime: number;
  language?: string;
  mode: string;
  modelId?: string;
  useWebGPU?: boolean;
  version?: number;
}) {
  try {
    // Ensure model is loaded
    const modelId = payload.modelId || 'Xenova/whisper-tiny';
    await ensureModel(modelId, payload.useWebGPU);
    
    // Transcribe the chunk
    const options: Record<string, unknown> = {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    
    if (payload.language) {
      options.language = payload.language;
    }
    
    const result = await transcriber(payload.audio, options);
    
    // Extract segments with adjusted timestamps
    const segments = [];
    if (result.chunks && Array.isArray(result.chunks)) {
      for (const chunk of result.chunks) {
        const text = chunk.text?.trim();
        if (!text) continue;
        
        segments.push({
          text,
          startTime: (chunk.timestamp?.[0] ?? 0) + payload.chunkStartTime,
          endTime: (chunk.timestamp?.[1] ?? 0) + payload.chunkStartTime,
        });
      }
    } else if (result.text?.trim()) {
      segments.push({
        text: result.text.trim(),
        startTime: payload.chunkStartTime,
        endTime: payload.chunkStartTime + (payload.audio.length / payload.samplingRate),
      });
    }
    
    post('chunk_result', {
      chunkIndex: payload.chunkIndex,
      segments,
      language: result.language || payload.language,
      version: payload.version ?? 0,
    });
    
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post('error', { error: `Chunk transcription failed: ${error}` });
  }
}

// Handle sound classification
async function handleClassify(payload: {
  audio: Float32Array;
  samplingRate: number;
  model: string;
  topK?: number;
  useWebGPU?: boolean;
}) {
  try {
    await ensureClassifier(payload.model, payload.useWebGPU);
    
    post('progress', { progress: 50, message: 'Classifying audio...' });
    
    const result = await classifier(payload.audio, {
      topk: payload.topK ?? 5,
    });
    
    const events = Array.isArray(result) ? result.map((r: { label: string; score: number }) => ({
      label: r.label,
      score: r.score,
      startTime: 0,
      endTime: 0,
    })) : [];
    
    post('result', {
      type: 'classification',
      events,
    });
    
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post('error', { error: `Classification failed: ${error}` });
  }
}

// Message handler
self.onmessage = async (event: MessageEvent) => {
  const { type, payload } = event.data;
  
  switch (type) {
    case 'init_model':
      try {
        await ensureModel(payload.modelId, payload.useWebGPU);
      } catch (e) {
        // Error already posted by ensureModel
      }
      break;
      
    case 'transcribe':
      await handleTranscribe(payload);
      break;
      
    case 'transcribe_chunk':
      await handleTranscribeChunk(payload);
      break;
      
    case 'classify':
      await handleClassify(payload);
      break;
      
    case 'cancel':
      // Cancellation is handled by the session manager checking isCancelled
      break;
      
    default:
      post('error', { error: `Unknown message type: ${type}` });
  }
};
