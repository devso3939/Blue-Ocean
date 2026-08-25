# Blue Ocean - Deployment Guide

## Current Status

✅ **Code pushed to GitHub**: https://github.com/devso3939/Blue-Ocean  
✅ **GitHub Actions workflow**: `.github/workflows/deploy.yml`  
✅ **GitHub Pages**: Auto-deploys on push to main  
✅ **Architecture**: 100% client-side (no backend needed)

---

## How Deployment Works

Blue Ocean is a **static site** — no server, no database, no backend. Everything runs in the browser.

### Automatic Deployment (Recommended)

Every push to the `main` branch triggers GitHub Actions:

1. **Build** — Vite compiles React + TypeScript into optimized JavaScript
2. **Deploy** — Built files are pushed to the `gh-pages` branch
3. **Serve** — GitHub Pages serves the static files

**Your live app**: https://devso3939.github.io/Blue-Ocean/

---

## Step 1: Enable GitHub Pages

1. Go to: https://github.com/devso3939/Blue-Ocean/settings/pages
2. Under **Source**, select **GitHub Actions**
3. The workflow will automatically build and deploy on every push

**Alternative (Classic method):**
1. Go to: https://github.com/devso3939/Blue-Ocean/settings/pages
2. Under **Source**, select **Deploy from a branch**
3. Branch: `gh-pages`, folder: `/ (root)`
4. Click **Save**

---

## Step 2: First Deployment

If this is your first time deploying:

```bash
# Clone the repository
git clone https://github.com/devso3939/Blue-Ocean.git
cd Blue-Ocean

# Install dependencies
cd client
npm install

# Build for production
npm run build

# Deploy to GitHub Pages
npm run deploy
```

---

## Step 3: Subsequent Deployments

After the initial setup, deployment is **automatic**:

```bash
# Make your changes
# ...

# Commit and push
git add .
git commit -m "feat: my awesome feature"
git push origin main

# GitHub Actions automatically builds and deploys!
```

Wait 2-3 minutes, then check: https://devso3939.github.io/Blue-Ocean/

---

## Manual Deployment (Without GitHub Actions)

If you want to deploy manually without waiting for CI/CD:

```bash
cd client

# Build production version
npm run build

# Deploy to GitHub Pages
npm run deploy
```

This uses the `gh-pages` npm package to push the `dist/` folder to the `gh-pages` branch.

---

## Environment Variables (Optional)

### Brave Search API Key

For enhanced business enrichment, add a Brave Search API key:

1. Get free API key at: https://brave.com/search/api/ (2,000 searches/month)
2. Create `client/.env`:
   ```
   VITE_BRAVE_API_KEY=your_api_key_here
   ```
3. Rebuild and deploy:
   ```bash
   cd client
   npm run build
   npm run deploy
   ```

**Note**: The app works without this key — it uses DuckDuckGo and Bing as fallbacks.

---

## Custom Domain (Optional)

To use a custom domain like `blueocean.com`:

1. Buy a domain from a registrar (Namecheap, Google Domains, etc.)
2. In your DNS settings, add:
   - Type: `CNAME`
   - Name: `@` or `www`
   - Value: `devso3939.github.io`
3. In GitHub repo settings:
   - Go to Settings → Pages
   - Under "Custom domain", enter your domain
   - Check "Enforce HTTPS"
4. Add a `CNAME` file to `client/public/`:
   ```
   blueocean.com
   ```

---

## Troubleshooting Deployment

### Build fails on GitHub Actions

1. Check the Actions tab: https://github.com/devso3939/Blue-Ocean/actions
2. Click on the failed workflow
3. Look for the error message
4. Common fixes:
   - TypeScript errors: Run `npx tsc --noEmit` locally
   - Missing dependencies: Run `npm install` locally
   - Node version: Ensure using Node 18+

### Changes not showing on live site

1. **Hard refresh**: `Ctrl + Shift + R` (Windows) / `Cmd + Shift + R` (Mac)
2. **Clear cache**: Open DevTools → Application → Storage → Clear site data
3. **Check deployment**: Wait 2-3 minutes for GitHub Actions to complete
4. **Verify build**: Check the Actions tab for successful deployment

### 404 error on GitHub Pages

1. Ensure GitHub Pages is enabled in repo settings
2. Check that the `gh-pages` branch exists
3. Verify the `base` path in `vite.config.ts` matches your repo name:
   ```typescript
   base: './',  // For GitHub Pages
   ```

### Map not loading on GitHub Pages

- Map tiles load from external CDN (CartoDB)
- Ensure your browser allows third-party requests
- Check if Content Security Policy blocks the requests

---

## Your Online Links

| Service | URL |
|---------|-----|
| **Live App** | https://devso3939.github.io/Blue-Ocean/ |
| **GitHub Repo** | https://github.com/devso3939/Blue-Ocean |
| **Actions Dashboard** | https://github.com/devso3939/Blue-Ocean/actions |
| **Pages Settings** | https://github.com/devso3939/Blue-Ocean/settings/pages |

---

## Local Development

```bash
# Clone and setup
git clone https://github.com/devso3939/Blue-Ocean.git
cd Blue-Ocean/client

# Install dependencies
npm install

# Start development server
npm run dev

# Open http://localhost:3000
```

---

## Production Build

To create a local production build without deploying:

```bash
cd client

# Build optimized version
npm run build

# Preview the build locally
npm run preview

# Open http://localhost:4173
```

The `dist/` folder contains all static files ready for any web server.

---

## Deploying to Other Platforms

### Vercel

1. Connect your GitHub repo at https://vercel.com
2. Framework: Vite
3. Root directory: `client`
4. Build command: `npm run build`
5. Output directory: `dist`

### Netlify

1. Connect your GitHub repo at https://netlify.com
2. Base directory: `client`
3. Build command: `npm run build`
4. Publish directory: `dist`

### Any Static Host

1. Run `cd client && npm run build`
2. Upload the `dist/` folder to any static hosting service
3. No server configuration needed!

---

> **Blue Ocean is 100% client-side — no backend, no database, no server costs.** 🌊
