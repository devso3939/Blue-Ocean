# 🌊 Blue Ocean v3.2.0

**Discover underserved industries, compare business supply across similar cities, and uncover Blue Ocean opportunities using global open location data.**

![Version](https://img.shields.io/badge/version-3.2.0-blue)
![React](https://img.shields.io/badge/React-18-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6)

## 🚀 Live Demo

**https://devso3939.github.io/Blue-Ocean/**

---

## 📋 Table of Contents

- [What It Does](#what-it-does)
- [Prerequisites](#-prerequisites)
- [Quick Start](#-quick-start)
- [Project Structure](#-project-structure)
- [Dependencies](#-dependencies)
- [Available Scripts](#-available-scripts)
- [Configuration](#-configuration)
- [Deployment](#-deployment)
- [Architecture](#architecture)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#contributing)

---

## What It Does

- **City Search** — Type any city name to discover business opportunities in that area
- **Industry Gap Detection** — Identifies underserved industries compared to similar cities worldwide
- **Interactive Map** — Dark-themed MapLibre map with color-coded pins for every business found
- **Business Enrichment** — 10-layer data pipeline that finds phone, email, website, and social media for each business
- **AI Market Analysis** — AI-powered insights about market gaps and investment opportunities
- **Compare View** — Side-by-side comparison of similar cities
- **Multi-language Support** — Auto-transliterates non-Latin names (Georgian, Cyrillic, Arabic, etc.)

---

## ✅ Prerequisites

Before you begin, install these on your computer:

| Tool | Required Version | Download |
|------|-----------------|----------|
| **Node.js** | v18 or higher (v20+ recommended) | https://nodejs.org/ |
| **npm** | v9+ (comes with Node.js) | Included with Node.js |
| **Git** | Any recent version | https://git-scm.com/ |

Verify installation by opening a terminal and running:

```bash
node --version    # Should print v18.x.x or higher
npm --version     # Should print 9.x.x or higher
git --version     # Should print git version 2.x.x
```

---

## ⚡ Quick Start

### 1. Clone the repository

Open your terminal and run:

```bash
git clone https://github.com/devso3939/Blue-Ocean.git
cd Blue-Ocean
```

### 2. Navigate to the client folder

```bash
cd client
```

### 3. Install all dependencies

```bash
npm install
```

This installs everything automatically. You should see output like:
```
added 200 packages in 15s
```

### 4. Start the development server

```bash
npm run dev
```

You should see:
```
  VITE v5.x.x  ready in 300 ms

  ➜  Local:   http://localhost:3000/
  ➜  Network: http://192.168.x.x:3000/
```

### 5. Open in your browser

Go to **http://localhost:3000**

The app loads with a dark-themed interface. Type a city name and start exploring!

---

## 📁 Project Structure

```
Blue-Ocean/
├── client/                        # Frontend application
│   ├── src/
│   │   ├── App.tsx                # Main application (map, search, tables)
│   │   ├── CompareView.tsx        # City comparison view
│   │   ├── CountryView.tsx        # Country-level overview
│   │   ├── aiAnalysis.ts          # AI market analysis engine
│   │   ├── clientEngine.ts        # Business data engine & enrichment pipeline
│   │   ├── main.tsx               # React entry point
│   │   └── index.css              # Global styles
│   ├── public/                    # Static assets
│   ├── index.html                 # HTML template
│   ├── package.json               # Dependencies
│   ├── vite.config.ts             # Build configuration
│   ├── tsconfig.json              # TypeScript config
│   ├── tailwind.config.js         # Tailwind CSS theme
│   └── postcss.config.js          # PostCSS config
├── backend/                       # Python backend (optional, for advanced features)
├── .github/workflows/deploy.yml   # Auto-deploy to GitHub Pages
├── DEPLOYMENT.md                  # Deployment guide
├── Dockerfile                     # Docker config
├── render.yaml                    # Render.com config
└── README.md                      # This file
```

---

## 📦 Dependencies

All dependencies are installed with a single `npm install` command inside the `client/` folder.

### What Gets Installed

**Runtime packages** (needed to run the app):
| Package | What It Does |
|---------|-------------|
| `react` | UI framework — builds the interface |
| `react-dom` | Renders React to the browser |
| `maplibre-gl` | Interactive maps with WebGL |
| `lucide-react` | Beautiful icons |

**Development packages** (needed to build the app):
| Package | What It Does |
|---------|-------------|
| `typescript` | Type checking for JavaScript |
| `vite` | Fast build tool and dev server |
| `@vitejs/plugin-react` | Adds React support to Vite |
| `tailwindcss` | Utility CSS framework |
| `postcss` | CSS processing |
| `autoprefixer` | Adds browser compatibility prefixes |
| `gh-pages` | Deploy to GitHub Pages |

### External APIs (no setup needed for basic use)

The app fetches data from free public APIs automatically:

| API | What It Provides |
|-----|-----------------|
| **OpenStreetMap Nominatim** | City geocoding (latitude/longitude) |
| **OpenStreetMap Overpass** | Business and point-of-interest data |
| **DuckDuckGo** | Web search for business details |
| **Brave Search** | Enhanced search (optional API key for more results) |

---

## 🛠️ Available Scripts

All commands run from the `client/` directory:

| Command | What It Does |
|---------|-------------|
| `npm run dev` | Start development server at http://localhost:3000 |
| `npm run build` | Build production version (creates `dist/` folder) |
| `npm run preview` | Preview the production build locally |
| `npm run deploy` | Deploy to GitHub Pages |

---

## ⚙️ Configuration

### Optional: Brave Search API Key

For enhanced business data enrichment, you can add a Brave Search API key:

1. Go to https://brave.com/search/api/ and get a free API key (2000 searches/month)
2. Create a file `client/.env` with:

```
VITE_BRAVE_API_KEY=your_api_key_here
```

The app works without this — it just finds more business details with it.

### Vite Dev Server Settings

In `client/vite.config.ts`:
- Dev server runs on **port 3000**
- Accessible on your local network (host `0.0.0.0`)
- Uses relative paths (`./`) for GitHub Pages compatibility

---

## 🚢 Deployment

### Automatic Deployment (Recommended)

Every push to the `main` branch automatically builds and deploys to GitHub Pages:

1. Push your changes to `main`
2. GitHub Actions builds the client
3. Live at: **https://devso3939.github.io/Blue-Ocean/**

### Manual Build for Production

```bash
cd client
npm run build
```

This creates optimized static files in `client/dist/`.

### Deploy to GitHub Pages Manually

```bash
cd client
npm run deploy
```

---

## Architecture

### How Data Flows

```
1. User types a city name
   ↓
2. resolveCity() → Finds exact location via Nominatim
   ↓
3. queryBusinesses() → Fetches businesses from Overpass API
   ↓
4. Maps to categories (bars, cafes, restaurants, shops, etc.)
   ↓
5. 10-Layer Enrichment Pipeline:
   ├─ Layer 1: Nominatim reverse geocoding (address, phone, email)
   ├─ Layer 2: DuckDuckGo search (website, phone, email, social)
   ├─ Layer 3: Brave Search (structured data, knowledge graph)
   ├─ Layer 4: Email-focused search (targeted email finding)
   ├─ Layer 5: Google Maps scraping (phone, website, email, social)
   ├─ Layer 6: Deep website scraping (JSON-LD, OpenGraph, contact pages)
   ├─ Layer 7: Social platform search (YouTube, LinkedIn, Twitter, TikTok)
   ├─ Layer 8: Social media deep search (Facebook/Instagram)
   ├─ Layer 9: Final pass (last attempt for businesses with no data)
   └─ Layer 10: AI market analysis (gap detection, recommendations)
   ↓
6. Results shown on:
   ├─ Interactive Map (color-coded pins, clickable popups)
   ├─ Business Table (sortable, filterable, with all contact data)
   └─ AI Analysis Panel (market insights, opportunity scores)
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| UI Framework | React 18 (hooks-based) |
| Language | TypeScript 5.4 |
| Build Tool | Vite 5 |
| CSS | Tailwind CSS 3.4 |
| Maps | MapLibre GL 4 (WebGL) |
| Icons | Lucide React |
| Hosting | GitHub Pages |
| CI/CD | GitHub Actions |

---

## 🔧 Troubleshooting

### `npm install` fails or hangs

```bash
# Delete cache and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Port 3000 already in use

```bash
# Windows — find what's using the port
netstat -ano | findstr :3000

# Kill the process (replace PID with the number shown)
taskkill /PID <PID> /F

# Or change the port in client/vite.config.ts:
# server: { port: 3001 }
```

### Map is blank / doesn't load

- Check your internet connection (map tiles load from CDN)
- Hard refresh: `Ctrl + Shift + R` (Windows) / `Cmd + Shift + R` (Mac)
- Open browser console (F12) and check for errors

### Build fails with TypeScript errors

```bash
cd client
npx tsc --noEmit    # Shows type errors without building
```

### App shows old version after pulling changes

```bash
cd client
rm -rf node_modules
npm install
npm run dev
```

### No businesses found for a city

- The city may not have OpenStreetMap data yet
- Try a larger nearby city
- Check if the city name is spelled correctly in English

---

## Contributing

1. Fork the repository on GitHub
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/Blue-Ocean.git
   ```
3. Create a feature branch:
   ```bash
   git checkout -b feature/my-feature
   ```
4. Install dependencies:
   ```bash
   cd client && npm install
   ```
5. Make your changes
6. Test locally: `npm run dev`
7. Type-check: `cd client && npx tsc --noEmit`
8. Commit and push:
   ```bash
   git add .
   git commit -m "feat: add my feature"
   git push origin feature/my-feature
   ```
9. Open a Pull Request on GitHub

### Code Style
- Use TypeScript for all new files
- 2-space indentation, single quotes
- Tailwind CSS for styling
- Keep components in `client/src/`

---

## 🔗 Quick Links

| Link | URL |
|------|-----|
| **Live App** | https://devso3939.github.io/Blue-Ocean/ |
| **GitHub Repo** | https://github.com/devso3939/Blue-Ocean |
| **Report Issues** | https://github.com/devso3939/Blue-Ocean/issues |
| **Node.js** | https://nodejs.org/ |
| **MapLibre GL** | https://maplibre.org/ |

---

> **Built to help entrepreneurs find their next Blue Ocean opportunity.** 🌊
