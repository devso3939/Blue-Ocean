/**
 * AI Analysis Module — Blue Ocean v2.9.0
 * Provides market analysis and insights using Hugging Face free inference API.
 */

import type { OpportunityResult } from './clientEngine';
import { getCategoryLabel } from './clientEngine';

// Hugging Face API (free, no key required)
async function callHF(model: string, inputs: string, params: Record<string, any> = {}): Promise<any> {
  try {
    const r = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs, parameters: params }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    return await r.json();
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
  const density = ((totalBiz / Math.max(population, 1)) * 10000).toFixed(1);

  // Try HF summarization
  const prompt = `${cityName} has ${totalBiz} businesses across ${categories.length} categories (${density} per 10k people). ${underserved.length} categories show significant gaps. Biggest gap: ${underserved[0] ? getCategoryLabel(underserved[0].category) : 'none'}.`;
  const ai = await callHF('facebook/bart-large-cnn', prompt, { max_length: 300, min_length: 80, do_sample: false });

  const summary = ai?.[0]?.summary_text || `${cityName} has ${totalBiz} businesses across ${categories.length} categories (${density} per 10k people). ${underserved.length} categories show significant opportunity gaps.`;

  return {
    summary,
    topOpportunities: underserved.slice(0, 5).map(o =>
      `${getCategoryLabel(o.category)}: gap of ${o.gap} businesses (${o.score}/100 score)`
    ),
    risks: saturated.slice(0, 3).map(o =>
      `${getCategoryLabel(o.category)}: saturated with ${o.existing} businesses`
    ),
    recommendations: [
      underserved.length > 0 ? `🎯 Priority: ${getCategoryLabel(underserved[0].category)} — ${underserved[0].gap} unit gap` : 'Market appears well-served',
      population > 500000 ? '🏙️ Large market supports specialization' : '🏘️ Focus on essential services',
      `💰 Top investment: ${underserved.slice(0, 3).map(o => getCategoryLabel(o.category)).join(' → ')}`,
    ],
    investmentScore: avgScore,
    investmentReason: `${underserved.length} underserved categories, ${density} businesses per 10k`,
  };
}

// Comparison Analysis
export async function analyzeComparison(
  cityA: string, cityB: string,
  oppsA: OpportunityResult[], oppsB: OpportunityResult[],
  popA: number, popB: number,
  totalBizA: number, totalBizB: number
): Promise<string> {
  const dA = ((totalBizA / Math.max(popA, 1)) * 10000).toFixed(1);
  const dB = ((totalBizB / Math.max(popB, 1)) * 10000).toFixed(1);
  const avgA = Math.round(oppsA.reduce((s, o) => s + o.score, 0) / Math.max(oppsA.length, 1));
  const avgB = Math.round(oppsB.reduce((s, o) => s + o.score, 0) / Math.max(oppsB.length, 1));

  const context = `${cityA} (pop ${popA.toLocaleString()}, ${totalBizA} businesses, ${dA}/10k) vs ${cityB} (pop ${popB.toLocaleString()}, ${totalBizB} businesses, ${dB}/10k). A avg score: ${avgA}, B avg score: ${avgB}.`;
  const ai = await callHF('facebook/bart-large-cnn', `Compare: ${context}`, { max_length: 250, min_length: 50 });
  if (ai?.[0]?.summary_text) return ai[0].summary_text;

  const lines: string[] = [];
  lines.push(`${cityA} has ${totalBizA} businesses (${dA}/10k), ${cityB} has ${totalBizB} (${dB}/10k).`);
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
    `${c.name} (pop ${(c.population / 1000).toFixed(0)}K, ${c.totalBiz} businesses, top: ${c.topOpps.slice(0, 3).map(o => `${getCategoryLabel(o.category)}(${o.score})`).join(', ')})`
  ).join('. ');

  const ai = await callHF('facebook/bart-large-cnn', `Country analysis for ${countryName}: ${context}`, { max_length: 300, min_length: 60 });
  if (ai?.[0]?.summary_text) return ai[0].summary_text;

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
  return `${countryName} analysis across ${cityData.length} cities. Best investment: ${best.name} (avg ${bestScore}/100, ${bestGaps.length} high-opportunity categories). Top: ${bestGaps.slice(0, 5).map(o => getCategoryLabel(o.category)).join(', ')}. Total market: ${totalPop.toLocaleString()} people, ${totalBiz} businesses.`;
}
