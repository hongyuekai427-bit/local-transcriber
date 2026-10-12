# AudioScribe

Privacy-first, browser-based multilingual audio transcription powered by local AI models.

## Features

- **Live Transcription**: Real-time speech recognition from microphone or browser tab audio
- **File Transcription**: Batch processing of audio/video files with multi-file queue support
- **Multilingual**: Support for 100+ languages with auto-detection
- **Local Processing**: All AI inference runs in your browser - no data sent to external servers
- **Multiple Modes**: Speech transcription, song lyric recognition, and environmental sound classification
- **Export Options**: TXT, SRT, VTT, and JSON formats with timestamps

## Technology Stack

- React 18 + TypeScript
- Vite
- Tailwind CSS v4
- @huggingface/transformers (Whisper models)
- Web Workers for background processing
- Web Audio API

## Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Type checking
npm run typecheck
```

## GitHub Pages Deployment

The project includes a GitHub Actions workflow for automatic deployment to GitHub Pages.

### Setup Instructions

1. **Enable GitHub Pages** in your repository:
   - Go to Settings → Pages
   - Under "Source", select "GitHub Actions"

2. **Push to main branch**:
   - The workflow will automatically build and deploy
   - Your site will be available at `https://<username>.github.io/<repository>/`

3. **Manual deployment**:
   - Go to Actions tab
   - Select "Deploy to GitHub Pages" workflow
   - Click "Run workflow"

### Configuration

The deployment workflow is located at `.github/workflows/deploy.yml` and includes:
- Automatic builds on push to `main` branch
- Manual trigger support via workflow_dispatch
- Proper permissions for GitHub Pages deployment
- Concurrent deployment protection

### Base Path Configuration

The app is configured to use relative paths (`./`) for GitHub Pages subdirectory deployment. This is set in `vite.config.js`:

```javascript
base: process.env.NODE_ENV === 'production' ? './' : '/'
```

If you need to deploy to a specific subpath, update the `base` configuration:

```javascript
base: '/your-repo-name/'
```

## Models

The application uses the following models from Hugging Face:

- **Whisper Tiny** (~75 MB) - Default, fast inference
- **Whisper Base** (~145 MB) - Better accuracy
- **Whisper Small** (~470 MB) - Best accuracy

Models are downloaded on first use and cached in the browser. Subsequent loads are instant.

## Browser Requirements

- Modern browser with WebAssembly support
- Chrome/Edge recommended for best performance
- WebGPU support optional (falls back to WASM)
- Microphone permissions for live transcription
- Screen capture permissions for tab audio

## Privacy

- ✅ All processing happens locally in your browser
- ✅ No audio data sent to external servers
- ✅ No user accounts or telemetry
- ✅ Models cached locally after first download
- ✅ API keys (if configured) stored in memory only

## License

MIT

## Acknowledgments

- [Hugging Face Transformers.js](https://github.com/huggingface/transformers.js)
- [OpenAI Whisper](https://github.com/openai/whisper)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
