# GitHub Pages Deployment Setup

## ✅ Completed

The GitHub Pages deployment workflow has been successfully configured.

## Files Created/Modified

### 1. `.github/workflows/deploy.yml`
GitHub Actions workflow that automatically deploys to GitHub Pages on push to main branch.

**Features:**
- Triggers on push to `main` branch
- Manual trigger support via workflow_dispatch
- Builds the Vite project
- Uploads dist folder as artifact
- Deploys to GitHub Pages with proper permissions

### 2. `vite.config.js`
Updated to use relative paths (`./`) for production builds, ensuring the app works correctly when deployed to a GitHub Pages subdirectory.

### 3. `README.md`
Comprehensive documentation including:
- Project overview and features
- Local development instructions
- GitHub Pages deployment guide
- Configuration options
- Privacy and security notes

## Deployment Instructions

### First-time Setup

1. **Push code to GitHub:**
   ```bash
   git add .
   git commit -m "Add GitHub Pages deployment workflow"
   git push origin main
   ```

2. **Enable GitHub Pages:**
   - Go to your repository on GitHub
   - Navigate to **Settings** → **Pages**
   - Under "Source", select **GitHub Actions**

3. **Automatic Deployment:**
   - The workflow will automatically run on push to `main`
   - Monitor progress in the **Actions** tab
   - Once complete, your site will be live at:
     ```
     https://<username>.github.io/<repository-name>/
     ```

### Manual Deployment

To manually trigger a deployment:
1. Go to **Actions** tab in your repository
2. Select "Deploy to GitHub Pages" workflow
3. Click "Run workflow"
4. Choose the branch (typically `main`)
5. Click "Run workflow"

## Verification

After deployment, verify:
- ✅ Site loads without 404 errors
- ✅ CSS and JavaScript files load correctly
- ✅ Web Workers initialize properly
- ✅ Model downloads work (first visit)
- ✅ Audio recording/transcription functions

## Troubleshooting

### Assets not loading (404 errors)
- Ensure `base: './'` is set in `vite.config.js`
- Check that GitHub Pages source is set to "GitHub Actions"
- Verify the workflow completed successfully

### Web Worker errors
- Workers are bundled correctly in the dist folder
- Check browser console for specific error messages
- Ensure CORS headers are correct (GitHub Pages handles this automatically)

### Model download fails
- Models are fetched from Hugging Face CDN
- Check network connectivity
- First load may take time to download ~75MB model
- Subsequent loads use browser cache

## Custom Domain (Optional)

To use a custom domain:
1. Add a `CNAME` file in the `public/` folder with your domain
2. Configure DNS settings with your domain provider
3. Enable HTTPS in repository Settings → Pages

## Workflow Details

The deployment workflow includes:
- **Build job**: Installs dependencies, builds the project, uploads artifact
- **Deploy job**: Downloads artifact and deploys to GitHub Pages
- **Concurrency control**: Prevents multiple simultaneous deployments
- **Permissions**: Minimal required permissions for security

## Next Steps

1. Test the deployment by visiting your GitHub Pages URL
2. Verify all features work in the deployed environment
3. Consider adding a custom domain for production use
4. Set up branch protection rules for the `main` branch
5. Configure environment variables if needed (none currently required)

## Notes

- Models are downloaded on first use (~75MB for Whisper Tiny)
- Browser must support WebAssembly and Web Audio API
- Microphone/screen capture requires HTTPS (GitHub Pages provides this)
- All processing is local - no backend server required
