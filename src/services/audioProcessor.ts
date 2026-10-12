// Audio processing utilities - decoding, resampling, chunking

export interface DecodedAudio {
  audioData: Float32Array;
  samplingRate: number;
  duration: number;
  channels: number;
}

export interface AudioChunk {
  data: Float32Array;
  startTime: number;
  endTime: number;
  index: number;
}

/**
 * Decode an audio file into raw PCM data
 */
export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  
  // Validate it's not empty
  if (arrayBuffer.byteLength === 0) {
    throw new Error('File is empty');
  }
  
  // Create an AudioContext for decoding
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error('Web Audio API is not supported in this browser');
  }
  
  const audioContext = new AudioContextClass();
  
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error('Failed to decode audio: no audio data found');
    }
    
    // Convert to mono if needed (Whisper expects mono)
    const audioData = convertToMono(audioBuffer);
    
    return {
      audioData,
      samplingRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      channels: audioBuffer.numberOfChannels,
    };
  } finally {
    await audioContext.close();
  }
}

/**
 * Convert multi-channel audio to mono by averaging channels
 */
function convertToMono(audioBuffer: AudioBuffer): Float32Array {
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  
  if (numChannels === 1) {
    return audioBuffer.getChannelData(0);
  }
  
  const mono = new Float32Array(length);
  const channels: Float32Array[] = [];
  
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }
  
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += channels[ch][i];
    }
    mono[i] = sum / numChannels;
  }
  
  return mono;
}

/**
 * Resample audio to target sample rate using linear interpolation
 */
export function resampleAudio(
  audioData: Float32Array,
  sourceRate: number,
  targetRate: number
): Float32Array {
  if (sourceRate === targetRate) {
    return audioData;
  }
  
  const ratio = sourceRate / targetRate;
  const newLength = Math.round(audioData.length / ratio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    
    result[i] = audioData[srcIndexFloor] * (1 - fraction) + audioData[srcIndexCeil] * fraction;
  }
  
  return result;
}

/**
 * Prepare audio for Whisper: resample to 16kHz mono Float32
 */
export function prepareForWhisper(decoded: DecodedAudio): Float32Array {
  const TARGET_RATE = 16000;
  
  if (decoded.samplingRate === TARGET_RATE) {
    return decoded.audioData;
  }
  
  return resampleAudio(decoded.audioData, decoded.samplingRate, TARGET_RATE);
}

/**
 * Split audio into chunks for processing long recordings
 */
export function chunkAudio(
  audioData: Float32Array,
  samplingRate: number,
  chunkDurationSec: number = 30,
  strideDurationSec: number = 5
): AudioChunk[] {
  const chunkSamples = chunkDurationSec * samplingRate;
  const strideSamples = strideDurationSec * samplingRate;
  const chunks: AudioChunk[] = [];
  
  if (audioData.length <= chunkSamples) {
    return [{
      data: audioData,
      startTime: 0,
      endTime: audioData.length / samplingRate,
      index: 0,
    }];
  }
  
  let offset = 0;
  let index = 0;
  
  while (offset < audioData.length) {
    const end = Math.min(offset + chunkSamples, audioData.length);
    const chunkData = audioData.slice(offset, end);
    
    chunks.push({
      data: chunkData,
      startTime: offset / samplingRate,
      endTime: end / samplingRate,
      index,
    });
    
    offset += chunkSamples - strideSamples;
    index++;
    
    // Prevent infinite loop on edge cases
    if (end >= audioData.length) break;
  }
  
  return chunks;
}

/**
 * Get audio metadata without full decoding
 */
export async function getAudioMetadata(file: File): Promise<{
  duration: number;
  sampleRate: number;
  channels: number;
}> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext = new AudioContextClass();
  
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return {
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
    };
  } finally {
    await audioContext.close();
  }
}

/**
 * Create an object URL for audio playback
 */
export function createPlaybackUrl(file: File): string {
  return URL.createObjectURL(file);
}

/**
 * Validate audio file type
 */
export function isSupportedAudioFile(file: File): boolean {
  const supportedTypes = [
    'audio/wav', 'audio/wave', 'audio/x-wav',
    'audio/mpeg', 'audio/mp3',
    'audio/ogg', 'audio/opus',
    'audio/webm',
    'audio/flac',
    'audio/mp4', 'audio/x-m4a', 'audio/aac',
    'video/mp4', 'video/webm', 'video/ogg',
  ];
  
  if (file.type && supportedTypes.includes(file.type)) {
    return true;
  }
  
  // Check extension as fallback
  const ext = file.name.split('.').pop()?.toLowerCase();
  const supportedExtensions = [
    'wav', 'wave', 'mp3', 'ogg', 'opus', 'webm', 'flac',
    'm4a', 'aac', 'mp4', 'wma',
  ];
  
  return ext ? supportedExtensions.includes(ext) : false;
}

/**
 * Format duration in seconds to human-readable string
 */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format timestamp for SRT/VTT
 */
export function formatTimestamp(seconds: number, format: 'srt' | 'vtt'): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  
  if (format === 'srt') {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }
  
  // VTT format
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
