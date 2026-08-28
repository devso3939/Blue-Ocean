/**
 * AI Analysis Module — Blue Ocean v6.8.0
 * Shared Smart AI Engine (OpenRouter free-tier model chain with fallback +
 * retries), with deterministic data-derived fallbacks. Model output and
 * data-derived output are labeled differently by the UI so users always
 * know the provenance.
 */

import type { OpportunityResult } from './clientEngine';
import { getCategoryLabel } from './clientEngine';

const OPENROUTER_API_KEY = (import.meta as any).env?.VITE_OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = (import.meta as any).env?.VITE_OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

// Same chain as clientEngine.ts — a dead/rate-limited model falls through
// to the next one automatically.
const AI_MODEL_CHAIN: string[] = [
  OPENROUTER_MODEL,
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m2.7:free',
  'z-ai/glm-5.2:free',
];

async function callLLM(prompt: string, timeoutMs = 60000): Promise<string | null> {
  // Prefer OpenRouter when a key is provided (better quality + reliability)
  if (OPENROUTER_API_KEY) {
    for (let mi = 0; mi < AI_MODEL_CHAIN.length; mi++) {
      const model = AI_MODEL_CHAIN[mi];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 1500,
              temperature: 0.4,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (r.ok) {
            const data = await r.json();
            const text = (data.choices?.[0]?.message?.content || '').trim();
            if (text && text.length > 40 && !/^\s*<!doctype|<html/i.test(text)) return text;
            break; // empty reply → try next model
          }
          if (r.status === 429 || r.status >= 500) {
            await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
            continue; // backoff then retry
          }
          break; // 4xx (model gone/forbidden) → next model
        } catch {
          // network/timeout → next attempt/model
        }
      }
    }
  }
  // Final fallback: Pollinations (free, keyless) for short prompts
  try {
    const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const text = (await r.text()).trim();
    if (text && text.length > 40 && !/^\s*<!doctype|<html/i.test(text)) return text;
    return null;
  } catch {
    return null;
  }
}

// Main analysis types
export interface AIInsights {
  summary: string;
  topOpportunities: string[];
  risks: string[];
  recommendations: string[];
  investmentScore: number;
  investmentReason: string;
}

// City Analysis
export async function analyzeCity(
  cityName: string,
  countryName: string,
  totalBiz: number,
  categories: string[],
  topOpps: OpportunityResult[],
  population: number
): Promise<AIInsights> {
  const underserved = topOpps.filter(o => o.score >= 60);
  const saturated = topOpps.filter(o => o.score < 30);
  const avgScore = Math.round(topOpps.reduce((s, o) => s + o.score, 0) / Math.max(topOpps.length, 1));
  const hasPop = population > 0;
  const density = hasPop ? ((totalBiz / population) * 10000).toFixed(1) : null;

  const prompt = `You are a market analyst. ${cityName}, ${countryName}: ${totalBiz} businesses in ${categories.length} categories${density ? `, ${density} per 10k residents` : ' (population unknown)'}. Underserved: ${underserved.slice(0, 3).map(o => getCategoryLabel(o.category)).join(', ') || 'none'}. In 2-3 sentences, give investment guidance using only these figures.`;
  const ai = await callLLM(prompt);

  const summary = ai ||
    `${cityName} has ${totalBiz} businesses across ${categories.length} categories${density ? ` (${density} per 10k people)` : ''}. ${underserved.length} categories show significant opportunity gaps.`;

  return {
    summary: ai ? `[AI] ${summary}` : `[data-derived] ${summary}`,
    topOpportunities: underserved.slice(0, 5).map(o =>
      `${getCategoryLabel(o.category)}: gap of ${o.gap ?? 'unknown'} businesses (${o.score}/100 score)`
    ),
    risks: saturated.slice(0, 3).map(o =>
      `${getCategoryLabel(o.category)}: saturated with ${o.existing} businesses`
    ),
    recommendations: [
      underserved.length > 0 ? `🎯 Priority: ${getCategoryLabel(underserved[0].category)} — ${underserved[0].gap ?? 'unknown'} unit gap` : 'Market appears well-served',
      hasPop && population > 500000 ? '🏙️ Large market supports specialization' : '🏘️ Focus on essential services',
      `💰 Top investment: ${underserved.slice(0, 3).map(o => getCategoryLabel(o.category)).join(' → ')}`,
    ],
    investmentScore: avgScore,
    investmentReason: `${underserved.length} underserved categories${density ? `, ${density} businesses per 10k` : ''}`,
  };
}

// Comparison Analysis
export async function analyzeComparison(
  cityA: string, cityB: string,
  oppsA: OpportunityResult[], oppsB: OpportunityResult[],
  popA: number, popB: number,
  totalBizA: number, totalBizB: number
): Promise<string> {
  const hasA = popA > 0, hasB = popB > 0;
  const dA = hasA ? ((totalBizA / popA) * 10000).toFixed(1) : null;
  const dB = hasB ? ((totalBizB / popB) * 10000).toFixed(1) : null;
  const avgA = Math.round(oppsA.reduce((s, o) => s + o.score, 0) / Math.max(oppsA.length, 1));
  const avgB = Math.round(oppsB.reduce((s, o) => s + o.score, 0) / Math.max(oppsB.length, 1));

  const context = `${cityA} (pop ${hasA ? popA.toLocaleString() : 'unknown'}, ${totalBizA} businesses${dA ? `, ${dA}/10k` : ''}) vs ${cityB} (pop ${hasB ? popB.toLocaleString() : 'unknown'}, ${totalBizB} businesses${dB ? `, ${dB}/10k` : ''}). Avg opportunity scores: ${avgA} vs ${avgB}.`;
  const ai = await callLLM(`You are a market analyst. Compare investment potential: ${context} In 2-3 sentences, using only these figures.`);
  if (ai) return `[AI] ${ai}`;

  const lines: string[] = [];
  lines.push(`[data-derived] ${cityA} has ${totalBizA} businesses${dA ? ` (${dA}/10k)` : ''}, ${cityB} has ${totalBizB}${dB ? ` (${dB}/10k)` : ''}.`);
  lines.push(`Average opportunity: ${cityA}=${avgA}, ${cityB}=${avgB}. ${avgA > avgB ? cityA : cityB} has more investment potential.`);
  const catsA = new Set(oppsA.filter(o => o.score >= 60).map(o => o.category));
  const catsB = new Set(oppsB.filter(o => o.score >= 60).map(o => o.category));
  const onlyA = [...catsA].filter(c => !catsB.has(c));
  const onlyB = [...catsB].filter(c => !catsA.has(c));
  if (onlyA.length) lines.push(`${cityA} advantages: ${onlyA.map(c => getCategoryLabel(c)).join(', ')}`);
  if (onlyB.length) lines.push(`${cityB} advantages: ${onlyB.map(c => getCategoryLabel(c)).join(', ')}`);
  return lines.join(' ');
}

// Country Analysis
export async function analyzeCountry(
  countryName: string,
  cityData: Array<{ name: string; population: number; totalBiz: number; topOpps: OpportunityResult[] }>
): Promise<string> {
  const context = cityData.map(c =>
    `${c.name} (pop ${c.population > 0 ? (c.population / 1000).toFixed(0) + 'K' : 'unknown'}, ${c.totalBiz} businesses, top: ${c.topOpps.slice(0, 3).map(o => `${getCategoryLabel(o.category)}(${o.score})`).join(', ')})`
  ).join('. ');

  const ai = await callLLM(`You are a market analyst. Country analysis for ${countryName}: ${context}. In 3-4 sentences, which city offers the best investment outlook and why? Use only these figures.`);
  if (ai) return `[AI] ${ai}`;

  const sorted = [...cityData].sort((a, b) => {
    const sA = a.topOpps.reduce((s, o) => s + o.score, 0) / Math.max(a.topOpps.length, 1);
    const sB = b.topOpps.reduce((s, o) => s + o.score, 0) / Math.max(b.topOpps.length, 1);
    return sB - sA;
  });
  const best = sorted[0];
  const bestScore = Math.round(best.topOpps.reduce((s, o) => s + o.score, 0) / Math.max(best.topOpps.length, 1));
  const bestGaps = best.topOpps.filter(o => o.score >= 60);
  const totalPop = cityData.reduce((s, c) => s + c.population, 0);
  const totalBiz = cityData.reduce((s, c) => s + c.totalBiz, 0);
  return `[data-derived] ${countryName} analysis across ${cityData.length} cities. Best investment: ${best.name} (avg ${bestScore}/100, ${bestGaps.length} high-opportunity categories). Top: ${bestGaps.slice(0, 5).map(o => getCategoryLabel(o.category)).join(', ')}. Total market: ${totalPop > 0 ? totalPop.toLocaleString() + ' people' : 'population data unavailable'}, ${totalBiz} businesses.`;
}
