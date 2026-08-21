# Blue Ocean - Deployment Guide

## Current Status

✅ **Code pushed to GitHub**: https://github.com/devso3939/Blue-Ocean  
✅ **GitHub Actions workflow**: `.github/workflows/nextjs.yml`  
✅ **GitHub Pages**: Auto-deploys on push to main  
✅ **Backend**: Client-side only (no backend needed)

## Step 1: Enable GitHub Pages (Frontend)

1. Go to: https://github.com/devso3939/Blue-Ocean/settings/pages
2. Under **Source**, select **GitHub Actions**
3. The workflow will automatically build and deploy

**OR** use the classic method:
1. Go to: https://github.com/devso3939/Blue-Ocean/settings/pages
2. Under **Source**, select **Deploy from a branch**
3. Branch: `main`, folder: `/ (root)`
4. Click **Save**

## Step 2: Deploy Backend on Render.com

1. Go to https://render.com and sign up (free)
2. Click **New** → **Web Service**
3. Connect your GitHub repository: `devso3939/Blue-Ocean`
4. Configure:
   - **Name**: `blue-ocean-api`
   - **Runtime**: Python
   - **Build Command**: `cd backend && pip install -r requirements.txt`
   - **Start Command**: `cd backend && python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. Add environment variables:
   - `PYTHON_VERSION`: `3.12`
   - `BLUEOCEAN_DATA_DIR`: `/data`
6. Add a persistent disk:
   - **Name**: `blue-ocean-data`
   - **Mount Path**: `/data`
   - **Size**: 10 GB
7. Deploy!

## Step 3: Update Frontend API URL

After deploying the backend, update the workflow:

1. Edit `.github/workflows/nextjs.yml`
2. Change this line:
   ```yaml
   NEXT_PUBLIC_API_URL: https://blue-ocean-api.onrender.com/api
   ```
3. Push the change

## Your Online Links (after deployment)

| Service | URL |
|---------|-----|
| **Frontend** | `https://devso3939.github.io/Blue-Ocean/` |
| **Backend API** | `https://blue-ocean-api.onrender.com/api/health` |

## Local Development

```bash
# Backend
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8010

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```
