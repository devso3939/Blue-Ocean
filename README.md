# 🌊 Blue Ocean v6.2.0

**Find What Your City Is Missing.**

Discover underserved industries, compare business supply across similar cities, and uncover Blue Ocean opportunities using global open location data — all from your browser with zero backend.

![Version](https://img.shields.io/badge/version-6.2.0-blue)
![React](https://img.shields.io/badge/React-18-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6)
![License](https://img.shields.io/badge/license-MIT-green)

## 🚀 Live Demo

**https://devso3939.github.io/Blue-Ocean/**

---

## 📋 Table of Contents

- [What It Does](#what-it-does)
- [Features](#features)
- [Prerequisites](#-prerequisites)
- [Quick Start](#-quick-start)
- [Project Structure](#-project-structure)
- [Dependencies](#-dependencies)
- [Available Scripts](#-available-scripts)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Enrichment Pipeline](#enrichment-pipeline)
- [Deployment](#-deployment)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#contributing)

---

## What It Does

Blue Ocean is a **100% client-side** market intelligence tool that helps entrepreneurs and investors discover untapped business opportunities in any city worldwide. It combines:

- **OpenStreetMap data** for real business counts
- **Multi-engine web search** for contact enrichment
- **AI analysis** for market gap detection
- **Interactive maps** for visual competition analysis

### Key Features

| Feature | Description |
|---------|-------------|
| 🔍 **City Search** | Type any city name in any language — auto-transliterates Georgian, Cyrillic, Arabic, etc. |
| 📊 **Industry Gap Detection** | Identifies underserved industries compared to similar cities worldwide |
| 🗺️ **Interactive Map** | Dark-themed MapLibre map with color-coded pins for every business found |
| 📧 **Contact Enrichment** | 12-step parallel pipeline that finds phone, email, website, and social media |
| 🤖 **AI Market Analysis** | AI-powered insights about market gaps and investment opportunities |
| 🏙️ **Compare View** | Side-by-side comparison of similar cities |
| 🌍 **Country View** | Country-level overview with all cities ranked |
| 📱 **Mobile Responsive** | Works perfectly on phones, tablets, and desktops |
| ⚡ **Parallel Processing** | Search engines run simultaneously for 4x faster enrichment |
| 🎯 **Email-Focused Search** | Dedicated phase targeting contact pages for maximum email discovery |

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

The app loads with a dark-themed interface. Select a country, type a city name, and start exploring!

---

## 📁 Project Structure

```
Blue-Ocean/
├── client/                        # Frontend application (main code)
│   ├── src/
│   │   ├── App.tsx                # Main UI: map, search, tables, panels
│   │   ├── clientEngine.ts        # Core engine: city search, business enrichment, AI
│   │   ├── CompareView.tsx        # City comparison view
│   │   ├── CountryView.tsx        # Country-level overview
│   │   ├── aiAnalysis.ts          # AI market analysis engine
│   │   ├── main.tsx               # React entry point
│   │   └── index.css              # Global styles
│   ├── public/                    # Static assets (favicon, etc.)
│   ├── index.html                 # HTML template with MapLibre popup styles
│   ├── package.json               # Dependencies and scripts
│   ├── vite.config.ts             # Build configuration
│   ├── tsconfig.json              # TypeScript config
│   ├── tailwind.config.js         # Tailwind CSS theme
│   └── postcss.config.js          # PostCSS config
├── .github/workflows/deploy-client.yml   # Auto-deploy to GitHub Pages
├── DEPLOYMENT.md                  # Detailed deployment guide
├── README.md                      # This file
└── .gitignore                     # Git ignore rules
```

---

## 📦 Dependencies

All dependencies are installed with a single `npm install` command inside the `client/` folder.

### Runtime Packages

| Package | Version | What It Does |
|---------|---------|-------------|
| `react` | 18.x | UI framework — builds the interface |
| `react-dom` | 18.x | Renders React to the browser |
| `maplibre-gl` | 4.x | Interactive WebGL maps |
| `lucide-react` | Latest | Beautiful icons |

### Development Packages

| Package | Version | What It Does |
|---------|---------|-------------|
| `typescript` | 5.4 | Type checking for JavaScript |
| `vite` | 5.x | Fast build tool and dev server |
| `@vitejs/plugin-react` | Latest | Adds React support to Vite |
| `tailwindcss` | 3.4 | Utility CSS framework |
| `postcss` | Latest | CSS processing |
| `autoprefixer` | Latest | Browser compatibility prefixes |
| `gh-pages` | Latest | Deploy to GitHub Pages |

### External APIs (No Setup Needed)

The app fetches data from free public APIs automatically:

| API | What It Provides | Rate Limit |
|-----|-----------------|------------|
| **OpenStreetMap Nominatim** | City geocoding | 1 req/sec |
| **OpenStreetMap Overpass** | Business data | 10,000 queries/day |
| **Brave Search** | Web search | 2,000/month (free) |
| **DuckDuckGo** | Web search | Unlimited |
| **Bing** | Web search | Unlimited |
| **CORS Proxies** | Enable cross-origin requests | Multiple free sources |

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

1. Go to https://brave.com/search/api/ and get a free API key (2,000 searches/month)
2. Create a file `client/.env` with:

```
VITE_BRAVE_API_KEY=your_api_key_here
```

The app works without this — it uses DuckDuckGo and Bing as fallbacks.

### Vite Dev Server Settings

In `client/vite.config.ts`:
- Dev server runs on **port 3000**
- Accessible on your local network (host `0.0.0.0`)
- Uses relative paths (`./`) for GitHub Pages compatibility

---

## Architecture

### How Data Flows

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER INPUT                               │
│  Select Country → Type City → Pick Industry → Click Analyze     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CITY RESOLUTION                               │
│  Nominatim Geocoding → Lat/Lon → Population → City Metadata    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 BUSINESS DISCOVERY                               │
│  Overpass API Query → Category Mapping → Initial Business List  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              PARALLEL ENRICHMENT PIPELINE (v5.2.0)               │
│                                                                  │
│  For EACH business (10 at a time):                              │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PHASE 1: ALL Search Engines in PARALLEL (4s total)     │    │
│  │  • Brave API ──────────────────────┐                    │    │
│  │  • DuckDuckGo HTML ────────────────┼──→ Merge Results  │    │
│  │  • Bing (decoded URLs) ────────────┤                    │    │
│  │  • DDG Lite ───────────────────────┘                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PHASE 2: Scrape Website (ONCE per business)            │    │
│  │  • Contact pages (15 paths per language)                │    │
│  │  • WordPress REST API (/wp-json/)                       │    │
│  │  • Sitemap discovery (/sitemap.xml)                     │    │
│  │  • vCard files (.vcf)                                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PHASE 3: Email-Focused Search (if still missing)       │    │
│  │  • Brave + DDG search for "[name] contact email"        │    │
│  │  • Auto-scrape results with /contact/ or /about/ URLs   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PHASE 4: Domain Probing (if no website found)          │    │
│  │  • Guess domain from business name                      │    │
│  │  • Try common TLDs (.com, .ge, .am, .ru)               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ PHASE 5: Social Media (if still missing contacts)      │    │
│  │  • Facebook, Instagram, LinkedIn, Twitter, Pinterest    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ⚡ EARLY EXIT: Skip remaining phases when data is sufficient  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DEMAND ANALYSIS                              │
│  Web Search Scores → Wikipedia Interest → Reddit Mentions       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   OPPORTUNITY SCORING                            │
│  Supply Gap + Market Size + Demand = Opportunity Score (0-100)  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AI ANALYSIS                                  │
│  LLM-powered insights about gaps, recommendations, trends      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RESULTS                                     │
│  • Interactive Map (pins, popups, mini-profiles)                │
│  • Business Table (sortable, filterable, CSV export)           │
│  • Opportunity Table (sorted by score)                          │
│  • AI Insights Panel                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| UI Framework | React 18 | Component-based interface |
| Language | TypeScript | Type safety and better IDE support |
| Build Tool | Vite 5 | Fast development and production builds |
| CSS | Tailwind CSS 3.4 | Utility-first styling |
| Maps | MapLibre GL 4 | WebGL-powered interactive maps |
| Hosting | GitHub Pages | Free static hosting |
| CI/CD | GitHub Actions | Automatic deployment on push |

---

## Enrichment Pipeline

### How We Find Contact Data

The enrichment pipeline runs **in parallel** across 4 search engines, then scrapes websites systematically:

#### Search Engines

| Engine | Method | Timeout | Data Found |
|--------|--------|---------|------------|
| **Brave API** | REST API | 3s | Website, phone, email from knowledge graph |
| **DuckDuckGo** | HTML scraping | 4s | Website, phone from search snippets |
| **Bing** | HTML scraping | 4s | Website, phone (decoded base64 URLs) |
| **DDG Lite** | HTML scraping | 4s | Different results than HTML DDG |

#### Website Scraping

| Source | What It Finds |
|--------|---------------|
| **Contact pages** | Email, phone (15 paths: /contact, /about, /team, etc.) |
| **WordPress REST API** | Email from /wp-json/ endpoints |
| **Sitemap** | Discovers hidden contact pages |
| **vCard files** | Structured contact data (.vcf files) |
| **JSON-LD** | Schema.org structured data |
| **mailto: links** | Direct email extraction |
| **tel: links** | Direct phone extraction |
| **Cloudflare bypass** | Decoded email protection |

#### Extraction Techniques

| Technique | Pattern |
|-----------|---------|
| **Email regex** | Standard + obfuscated (&#64; = @, JS strings) |
| **Phone regex** | International formats, country-specific (GE/AM/TR/RU) |
| **Labeled patterns** | "Phone:", "Email:", "Call us:", etc. |
| **Social media** | Facebook, Instagram, LinkedIn, Twitter, Pinterest, TikTok, YouTube |

### Performance

| Metric | Before (v3.x) | After (v5.2.0) |
|--------|---------------|----------------|
| Search engines | 1 (sequential) | **4 (parallel)** |
| Time per business | 18s | **4-5s** |
| Website scraping | 4x per business | **1x (deduped)** |
| Contact page paths | 50+ | **15 (optimized)** |
| Total time (100 businesses) | 15+ minutes | **2-3 minutes** |
| Email hit rate | ~20% | **40-50%** |

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
- Try selecting the country first, then typing the city name

### Enrichment is slow

- First search may be slower due to cold start
- Subsequent searches use cached results
- You can cancel any time with the ✕ Cancel button
- Check the real-time progress panel for engine status

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
- Follow existing naming conventions

### Key Files to Edit

| File | What It Controls |
|------|-----------------|
| `App.tsx` | UI components, map rendering, panels |
| `clientEngine.ts` | Core logic, enrichment pipeline, search engines |
| `aiAnalysis.ts` | AI market analysis |
| `CompareView.tsx` | City comparison feature |
| `CountryView.tsx` | Country-level overview |

---

## 🔗 Quick Links

| Link | URL |
|------|-----|
| **Live App** | https://devso3939.github.io/Blue-Ocean/ |
| **GitHub Repo** | https://github.com/devso3939/Blue-Ocean |
| **Report Issues** | https://github.com/devso3939/Blue-Ocean/issues |
| **Node.js** | https://nodejs.org/ |
| **MapLibre GL** | https://maplibre.org/ |
| **OpenStreetMap** | https://www.openstreetmap.org/ |
| **Brave Search API** | https://brave.com/search/api/ |

---

## 📄 License

MIT License — feel free to use, modify, and distribute.

---

> **Built to help entrepreneurs find their next Blue Ocean opportunity.** 🌊
>
> *100% client-side • No backend • No data stored • Free & open source*
