/**
 * AI Analysis Module — Blue Ocean v2.9.0
 * 
 * Provides market analysis, investment recommendations, and insights
 * using Hugging Face free inference API with local fallback.
 */

import { type Business, type OpportunityResult, type DemandSignal, getCategoryLabel } from './clientEngine';

// ═══════════════════════════════════════════════════════════════
// Hugging Face API (free, no key required for some models)
// ═══════════════════════════════════════════════════════════════

const HF_MODELS = {
  summarization: 'facebook/bart-large-cnn',
  textGeneration: 'gpt2',  // Fallback for text generation
};

async function callHuggingFace(model: string, inputs: string, params: Record<string, any> = {}): Promise<any> {
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

// ═══════════════════════════════════════════════════════════════
// Main Analysis Functions
// ═══════════════════════════════════════════════════════════════

export interface AIInsights {
  summary: string;
  topOpportunities: string[];
  risks: string[];
  recommendations: string[];
  investmentScore: number; // 0-100
  investmentReason: string;
}

// ─── Single City Analysis ─────────────────────────────────────
export async function analyzeCity(
  cityName: string,
  countryName: string,
  businesses: Map<string, Business[]>,
  opportunities: OpportunityResult[],
  demandSignals: Map<string, DemandSignal>,
  population: number
): Promise<AIInsights> {
  const totalBiz = Array.from(businesses.values()).reduce((s, a) => s + a.length, 0);
  const categories = Array.from(businesses.keys());
  const topOpps = opportunities.slice(0, 10);
  const underserved = topOpps.filter(o => o.score >= 60);
  const saturated = topOpps.filter(o => o.score < 30);

  // Build data context for AI
  const context = buildCityContext(cityName, countryName, totalBiz, categories, topOpps, demandSignals, population);

  // Try Hugging Face first
  const aiResult = await callHuggingFace(
    HF_MODELS.summarization,
    `Analyze business opportunities: ${context}`,
    { max_length: 400, min_length: 80, do_sample: false }
  );

  if (aiResult?.[0]?.summary_text) {
    return parseAIResponse(aiResult[0].summary_text, topOpps, underserved, saturated, population, totalBiz);
  }

  // Fallback to local analysis
  return generateLocalInsights(cityName, countryName, topOpps, underserved, saturated, population, totalBiz, demandSignals);
}

// ─── City Comparison Analysis ─────────────────────────────────
export async function analyzeComparison(
  cityA: string, cityB: string,
  oppsA: OpportunityResult[], oppsB: OpportunityResult[],
  popA: number, popB: number,
  totalBizA: number, totalBizB: number
): Promise<string> {
  const context = `${cityA} (pop ${popA.toLocaleString()}, ${totalBizA} businesses) vs ${cityB} (pop ${popB.toLocaleString()}, ${totalBizB} businesses). ` +
    `A opportunities: ${oppsA.slice(0, 5).map(o => `${o.categoryLabel}(score:${o.score})`).join(', ')}. ` +
    `B opportunities: ${oppsB.slice(0, 5).map(o => `${o.categoryLabel}(score:${o.score})`).join(', ')}.`;

  const aiResult = await callHuggingFace(
    HF_MODELS.summarization,
    `Compare investment potential: ${context}`,
    { max_length: 250, min_length: 50 }
  );

  if (aiResult?.[0]?.summary_text) {
    return aiResult[0].summary_text;
  }

  return generateComparisonInsights(cityA, cityB, oppsA, oppsB, popA, popB, totalBizA, totalBizB);
}

// ─── Country Analysis ─────────────────────────────────────────
export async function analyzeCountry(
  countryName: string,
  cityData: Array<{ name: string; population: number; totalBiz: number; topOpps: OpportunityResult[] }>
): Promise<string> {
  const context = cityData.map(c =>
    `${c.name} (pop ${(c.population/1000).toFixed(0)}K, ${c.totalBiz} businesses, top: ${c.topOpps.slice(0, 3).map(o => `${o.categoryLabel}(${o.score})`).join(', ')})`
  ).join('. ');

  const aiResult = await callHuggingFace(
    HF_MODELS.summarization,
    `Country investment analysis for ${countryName}: ${context}`,
    { max_length: 300, min_length: 60 }
  );

  if (aiResult?.[0]?.summary_text) {
    return aiResult[0].summary_text;
  }

  return generateCountryInsights(countryName, cityData);
}

// ─── Investment Recommendation ────────────────────────────────
export async function getInvestmentAdvice(
  cityName: string,
  category: string,
  existing: number,
  gap: number,
  score: number,
  population: number,
  demandScore: number
): Promise<string> {
  const context = `${category} in ${cityName}: ${existing} existing businesses, gap of ${gap}, opportunity score ${score}/100, population ${population.toLocaleString()}, demand signal ${demandScore}/100.`;

  const aiResult = await callHuggingFace(
    HF_MODELS.summarization,
    `Investment advice: ${context}`,
    { max_length: 200, min_length: 40 }
  );

  if (aiResult?.[0]?.summary_text) {
    return aiResult[0].summary_text;
  }

  return generateInvestmentAdvice(category, existing, gap, score, population, demandScore);
}

// ═══════════════════════════════════════════════════════════════
// Local Analysis Generators (no API needed)
// ═══════════════════════════════════════════════════════════════

function buildCityContext(
  name: string, country: string, totalBiz: number,
  categories: string[], topOpps: OpportunityResult[],
  signals: Map<string, DemandSignal>, population: number
): string {
  const density = ((totalBiz / Math.max(population, 1)) * 10000).toFixed(1);
  const topWithDemand = topOpps.slice(0, 5).map(o => {
    const sig = signals.get(o.category);
    return `${o.categoryLabel}: ${o.existing} existing, gap ${o.gap}, score ${o.score}, demand ${sig?.score || 0}`;
  }).join('; ');
  return `${name}, ${country}. Pop: ${population.toLocaleString()}. Total: ${totalBiz} businesses (${density}/10k). Categories: ${categories.length}. Top opportunities: ${topWithDemand}.`;
}

function parseAIResponse(
  text: string,
  topOpps: OpportunityResult[],
  underserved: OpportunityResult[],
  saturated: OpportunityResult[],
  population: number,
  totalBiz: number
): AIInsights {
  return {
    summary: text,
    topOpportunities: underserved.slice(0, 5).map(o =>
      `${o.categoryLabel}: gap of ${o.gap} businesses (${o.score}/100 score)`
    ),
    risks: saturated.slice(0, 3).map(o =>
      `${o.categoryLabel}: already saturated with ${o.existing} businesses`
    ),
    recommendations: [
      underserved.length > 0 ? `Focus on ${underserved[0].categoryLabel} — biggest opportunity gap` : 'Market appears well-served across categories',
      population > 500000 ? 'Large population supports specialized niches' : 'Consider essential services with proven demand',
    ],
    investmentScore: Math.round(topOpps.reduce((s, o) => s + o.score, 0) / Math.max(topOpps.length, 1)),
    investmentReason: `${underserved.length} underserved categories in a market of ${population.toLocaleString()} people`,
  };
}

function generateLocalInsights(
  cityName: string, countryName: string,
  topOpps: OpportunityResult[],
  underserved: OpportunityResult[],
  saturated: OpportunityResult[],
  population: number, totalBiz: number,
  demandSignals: Map<string, DemandSignal>
): AIInsights {
  const density = ((totalBiz / Math.max(population, 1)) * 10000).toFixed(1);
  const avgScore = Math.round(topOpps.reduce((s, o) => s + o.score, 0) / Math.max(topOpps.length, 1));

  const topOpp = underserved[0];
  const topDemand = Array.from(demandSignals.entries())
    .sort((a, b) => b[1].score - a[1].score)[0];

  const summary = `${cityName} has ${totalBiz} businesses across ${topOpps.length} categories (${density} per 10k people). ` +
    `${underserved.length} categories show significant opportunity gaps. ` +
    (topOpp ? `The biggest gap is in ${topOpp.categoryLabel} with a potential need for ${topOpp.gap} more businesses.` : '');

  const topOppsList = underserved.slice(0, 5).map(o =>
    `${getCategoryLabel(o.category)}: ${o.existing} existing, gap of ${o.gap}, score ${o.score}/100`
  );

  const risks = saturated.slice(0, 3).map(o =>
    `${getCategoryLabel(o.category)}: market saturated with ${o.existing} businesses (${o.score}/100)`
  );

  const recs: string[] = [];
  if (topOpp) recs.push(`🎯 Priority: Open a ${topOpp.categoryLabel} — ${topOpp.gap} unit gap, ${topOpp.score}/100 opportunity score`);
  if (topDemand) recs.push(`📈 Highest demand signal: ${getCategoryLabel(topDemand[0])} (${topDemand[1].score}/100)`);
  if (population > 500000) recs.push(`🏙️ Large market — consider premium positioning and specialization`);
  if (density < 10) recs.push(`📊 Low business density (${density}/10k) — high growth potential across all categories`);
  if (underserved.length > 3) recs.push(`🔄 Multiple underserved markets — diversification opportunity`);
  recs.push(`💰 Investment priority: ${underserved.slice(0, 3).map(o => getCategoryLabel(o.category)).join(' → ')}`);

  return {
    summary,
    topOpportunities: topOppsList,
    risks,
    recommendations: recs,
    investmentScore: avgScore,
    investmentReason: `${underserved.length} underserved categories, ${density} businesses per 10k (pop: ${population.toLocaleString()})`,
  };
}

function generateComparisonInsights(
  cityA: string, cityB: string,
  oppsA: OpportunityResult[], oppsB: OpportunityResult[],
  popA: number, popB: number,
  totalBizA: number, totalBizB: number
): string {
  const densityA = ((totalBizA / Math.max(popA, 1)) * 10000).toFixed(1);
  const densityB = ((totalBizB / Math.max(popB, 1)) * 10000).toFixed(1);
  const avgA = Math.round(oppsA.reduce((s, o) => s + o.score, 0) / Math.max(oppsA.length, 1));
  const avgB = Math.round(oppsB.reduce((s, o) => s + o.score, 0) / Math.max(oppsB.length, 1));

  const lines: string[] = [];
  lines.push(`${cityA} has ${totalBizA} businesses (${densityA}/10k), ${cityB} has ${totalBizB} (${densityB}/10k).`);
  lines.push(`Average opportunity score: ${cityA}=${avgA}, ${cityB}=${avgB}.`);
  lines.push(`${avgA > avgB ? cityA : cityB} has more investment opportunity on average.`);

  // Find unique advantages
  const catsA = new Set(oppsA.filter(o => o.score >= 60).map(o => o.category));
  const catsB = new Set(oppsB.filter(o => o.score >= 60).map(o => o.category));
  const onlyInA = [...catsA].filter(c => !catsB.has(c));
  const onlyInB = [...catsB].filter(c => !catsA.has(c));

  if (onlyInA.length > 0) lines.push(`${cityA} advantages: ${onlyInA.map(c => getCategoryLabel(c)).join(', ')}`);
  if (onlyInB.length > 0) lines.push(`${cityB} advantages: ${onlyInB.map(c => getCategoryLabel(c)).join(', ')}`);

  return lines.join(' ');
}

function generateCountryInsights(
  countryName: string,
  cityData: Array<{ name: string; population: number; totalBiz: number; topOpps: OpportunityResult[] }>
): string {
  const sorted = [...cityData].sort((a, b) => {
    const scoreA = a.topOpps.reduce((s, o) => s + o.score, 0) / Math.max(a.topOpps.length, 1);
    const scoreB = b.topOpps.reduce((s, o) => s + o.score, 0) / Math.max(b.topOpps.length, 1);
    return scoreB - scoreA;
  });

  const best = sorted[0];
  const bestScore = Math.round(best.topOpps.reduce((s, o) => s + o.score, 0) / Math.max(best.topOpps.length, 1));
  const bestGaps = best.topOpps.filter(o => o.score >= 60);

  const lines: string[] = [];
  lines.push(`${countryName} analysis across ${cityData.length} cities.`);
  lines.push(`Best investment city: ${best.name} (avg score ${bestScore}/100, ${bestGaps.length} high-opportunity categories).`);
  lines.push(`Top opportunities in ${best.name}: ${bestGaps.slice(0, 5).map(o => getCategoryLabel(o.category)).join(', ')}.`);

  // Compare cities
  const totalPop = cityData.reduce((s, c) => s + c.population, 0);
  const totalBiz = cityData.reduce((s, c) => s + c.totalBiz, 0);
  lines.push(`Total market: ${totalPop.toLocaleString()} people, ${totalBiz} businesses.`);

  return lines.join(' ');
}

function generateInvestmentAdvice(
  category: string, existing: number, gap: number,
  score: number, population: number, demandScore: number
): string {
  const label = getCategoryLabel(category);
  const lines: string[] = [];

  if (score >= 80) {
    lines.push(`🔥 ${label} is a HIGH-OPPORTUNITY category (${score}/100).`);
  } else if (score >= 60) {
    lines.push(`✅ ${label} shows GOOD opportunity (${score}/100).`);
  } else {
    lines.push(`⚠️ ${label} has limited opportunity (${score}/100) — market may be saturated.`);
  }

  if (gap > 0) {
    lines.push(`Gap: ${gap} businesses needed to meet demand for this population.`);
  }

  if (demandScore > 50) {
    lines.push(`Strong demand signal (${demandScore}/100) — people are actively searching for this.`);
  } else if (demandScore < 20) {
    lines.push(`Low demand signal (${demandScore}/100}) — limited online interest.`);
  }

  if (existing === 0) {
    lines.push(`Zero competitors — first-mover advantage available!`);
  } else if (existing < 5) {
    lines.push(`Only ${existing} competitors — low competition.`);
  }

  return lines.join(' ');
}
