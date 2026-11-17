// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// radar-2 is a comparables model. It learns what a token is worth from the protocols in the snapshot
// that already have one, then prices the protocols that record no token yet:
//
//   1. Comparables. Every tokenized protocol (a market cap on record) contributes the ratio
//      mcap_usd / tvl_usd. A category's multiple is the median ratio of its tokenized protocols,
//      used only when at least MIN_COMPARABLES (4) of them exist; otherwise the global median over
//      all 100+ tokenized protocols is the fallback. Every multiple is clamped to
//      [MULTIPLE_FLOOR, MULTIPLE_CAP] so one thin category cannot price the board.
//   2. Adjustments, each a documented factor of the snapshot's own figures:
//        growth_factor = clamp(1 + clamp(change_7d, -50, +100) / 100 x 0.5, 0.75, 1.50)
//                        (a missing 7d change is neutral: factor 1)
//        age_factor    = 0.75 + 0.5 x min(age_days, 1460) / 1460
//                        (age is days since listed_at; an unrecorded age uses 365 days)
//        chain_factor  = 1 + 0.05 x (min(chain_count, 5) - 1)   (one chain: 1.00)
//   3. implied_value_usd = round(tvl_usd x category_multiple x growth_factor x age_factor
//                                x chain_factor), at least 1.
//
// Selection is the watchlist rule with the $50M floor removed, applied programmatically to the
// whole snapshot: a protocol records no token (gecko_id and symbol both null) and is not a wrapped,
// staked or bridged product of one that trades (excluded categories, version-marked names, names
// carrying the whole words wrapped/staked/staking, names beginning with an exchange's name).
// Every protocol that passes is ranked: the board is the whole rule-compliant pre-token universe,
// never a hand-picked list, and no protocol name is ever special-cased.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  multiple_floor: number;
  multiple_cap: number;
  min_comparables: number;
  growth_weight: number;
  growth_floor_pct: number;
  growth_cap_pct: number;
  age_floor: number;
  age_range: number;
  age_days_cap: number;
  unknown_age_days: number;
  chain_step: number;
  chain_count_cap: number;
}

export const MODEL: ModelConstants = {
  multiple_floor: 0.02,
  multiple_cap: 3,
  min_comparables: 4,
  growth_weight: 0.5,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  age_floor: 0.75,
  age_range: 0.5,
  age_days_cap: 1460,
  unknown_age_days: 365,
  chain_step: 0.05,
  chain_count_cap: 5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's comparables: how many tokenized protocols priced it, and the multiple in force. */
export interface CategoryMultiple {
  category: string;
  comparables: number;
  median_multiple: number;
  used_multiple: number;
  source: 'category' | 'global';
}

/** The comparables table the model learned from the snapshot's tokenized protocols. */
export interface Comparables {
  tokenized_count: number;
  global_multiple: number;
  categories: CategoryMultiple[];
}

/** The full working for one row: every input and factor behind its implied value. */
export interface ModelBreakdown {
  category_multiple: number;
  multiple_source: 'category' | 'global';
  comparables: number;
  growth_pct: number | null;
  growth_factor: number;
  age_days: number | null;
  age_factor: number;
  chain_count: number;
  chain_factor: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row's figures, its breakdown and its farm plan. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the comparables and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  comparables: Comparables;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list: the list is sorted first, so the result never depends on input order. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The comparables table: for every category, the median market-cap/TVL multiple of its tokenized
 * protocols, and the multiple actually in force (the category's own when it has enough comparables,
 * the clamped global median otherwise).
 */
export function buildComparables(snapshot: Snapshot, model: ModelConstants = MODEL): Comparables {
  const tokenized = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const globalRaw = tokenized.length > 0 ? median(tokenized.map((p) => p.mcap_usd! / p.tvl_usd)) : 1;
  const globalMultiple = clamp(globalRaw, model.multiple_floor, model.multiple_cap);
  const byCategory = new Map<string, number[]>();
  for (const p of tokenized) {
    const key = p.category ?? 'Uncategorized';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
    else list.push(p.mcap_usd! / p.tvl_usd);
  }
  const categories: CategoryMultiple[] = [...byCategory.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, ratios]) => {
      const med = median(ratios);
      const own = ratios.length >= model.min_comparables;
      return {
        category,
        comparables: ratios.length,
        median_multiple: round4(med),
        used_multiple: round4(own ? clamp(med, model.multiple_floor, model.multiple_cap) : globalMultiple),
        source: own ? ('category' as const) : ('global' as const),
      };
    });
  return { tokenized_count: tokenized.length, global_multiple: round4(globalMultiple), categories };
}

/** The multiple in force for one category, from a comparables table. */
function multipleFor(comparables: Comparables, category: string | null): CategoryMultiple {
  const key = category ?? 'Uncategorized';
  const found = comparables.categories.find((c) => c.category === key);
  if (found !== undefined) return found;
  return { category: key, comparables: 0, median_multiple: comparables.global_multiple, used_multiple: comparables.global_multiple, source: 'global' };
}

/** The breakdown and implied value one pre-token protocol gets under the model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comparables: Comparables,
  model: ModelConstants = MODEL,
): { implied: number; breakdown: ModelBreakdown } {
  const mult = multipleFor(comparables, protocol.category);
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = protocol.change_7d === null ? null : clamp(protocol.change_7d, model.growth_floor_pct, model.growth_cap_pct);
  const growthFactor = growthPct === null ? 1 : clamp(1 + (growthPct / 100) * model.growth_weight, 0.75, 1.5);
  const ageForModel = age ?? model.unknown_age_days;
  const ageFactor = model.age_floor + (Math.min(Math.max(ageForModel, 0), model.age_days_cap) / model.age_days_cap) * model.age_range;
  const chainCount = Math.max(1, protocol.chains.length);
  const chainFactor = 1 + model.chain_step * (Math.min(chainCount, model.chain_count_cap) - 1);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * mult.used_multiple * growthFactor * ageFactor * chainFactor));
  return {
    implied,
    breakdown: {
      category_multiple: mult.used_multiple,
      multiple_source: mult.source,
      comparables: mult.comparables,
      growth_pct: growthPct,
      growth_factor: round4(growthFactor),
      age_days: age,
      age_factor: round4(ageFactor),
      chain_count: protocol.chains.length,
      chain_factor: round4(chainFactor),
    },
  };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Categories that are products of another protocol's token, or exchanges themselves. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Names beginning with an exchange's name are that exchange's own products. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token under the watchlist rule with the TVL
 * floor removed, so the whole pre-token universe below the floor is ranked too.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comparables = buildComparables(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const { implied, breakdown } = impliedValue(p, snapshot.as_of, comparables, model);
      return { p, implied, breakdown };
    });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(s.p.slug),
    age_days: s.breakdown.age_days,
    implied_value_usd: s.implied,
    model: s.breakdown,
    farm_steps: farmSteps(s.p, s.breakdown.age_days).map(stepText),
  }));
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral to ${name} on ${chain} and leave the deposit open so it earns and counts`;
  if (c.includes('risk curator') || c.includes('curator')) return `Allocate $${capital} of USDC to a curated vault inside ${name} on ${chain} and keep the vault shares`;
  if (c.includes('capital allocator') || c.includes('allocator')) return `Deposit $${capital} of USDC into an allocator vault on ${name} (${chain}) and keep the shares for the full window`;
  if (c.includes('dex')) return `Provide $${capital} of liquidity, half USDC and half the paired asset, to ${name}'s busiest pool on ${chain}`;
  if (c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s main yield vault on ${chain} and keep the receipt token in the same wallet`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis-trading vault on ${chain}, which runs the hedged position for you`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} (${chain}) and open one small hedged trade, then keep the account active`;
  if (c.includes('prediction')) return `Fund ${name} with $${capital} on ${chain} and take one position in an active market you can explain`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the native asset through ${name} on ${chain} and keep the staking receipt unspent`;
  if (c.includes('stable')) return `Mint $${capital} of ${name}'s stable asset on ${chain} against USDC collateral and hold it in the farming wallet`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s real-world-asset yield token on ${chain} and hold it for the full window`;
  if (c.includes('launchpad')) return `Register the farming wallet on ${name} (${chain}) and complete one $${capital} participation when a sale opens`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${chain} and make real transactions with ${name}'s own apps, starting with a swap and a transfer`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the window`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} through its own app and keep the position open`;
}

/** The category's second, follow-up action: the step that turns a deposit into ongoing activity. */
function followUpFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const small = Math.max(25, Math.round(capital / 5));
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow about $${small} against the supplied collateral on ${name}, hold it for a week, then repay in full so the wallet shows both sides of the market`;
  if (c.includes('dex')) return `Make one swap of about $${small} through ${name} on ${chain} each week, alternating direction, so the wallet is a user and not only a liquidity deposit`;
  if (c.includes('risk curator') || c.includes('curator') || c.includes('allocator')) return `Read ${name}'s allocation page, then move about $${small} between two of its vaults once, so the wallet follows the curator's strategy instead of sitting still`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Place one small trade of about $${small} of margin on ${name} each week and close it the same day, keeping total losses under $10`;
  if (c.includes('chain')) return `Use two more of ${chain}'s native apps from the same wallet, one swap and one contract interaction of about $${small} each, in two different weeks`;
  return `Repeat a smaller action of about $${small} on ${name} in the second week, a top-up, a swap or a claim, so the wallet shows a pattern of use rather than one visit`;
}

/**
 * A protocol's farm plan: six to seven steps, each an action with a dollar cost and a time. The
 * plan is derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = p.chains.length > 2 ? 6 : 3;
  const steps: FarmStep[] = [
    {
      text: `Set up a fresh wallet for ${p.name}, fund it on ${chain} with the position money plus about $${gas} of the chain's gas token, and keep its seed phrase offline`,
      cost: `about $${gas} of gas to fund and make the first transaction`,
      time: '10 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: followUpFor(p, capital, chain),
      cost: `about $${Math.max(2, Math.round(gas / 2))} of gas, with the borrowed or traded amount returned`,
      time: '10 minutes',
    },
  ];
  if (p.chains.length > 1) {
    steps.push({
      text: `Repeat a smaller $${Math.max(25, Math.round(capital / 4))} position on ${p.chains[1]}, the protocol's second chain, because multi-chain activity is the pattern launch snapshots usually reward`,
      cost: `about $${gas} of bridge and gas fees`,
      time: '20 minutes',
    });
  }
  steps.push(
    {
      text: `Return once a week for ${Math.max(2, Math.round(hold / 7))} weeks: one qualifying action on ${p.name} each visit, such as a top-up, a swap, a vote or a claim check, never two actions back to back in one day`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold every position for at least ${hold} days, then check ${p.name}'s own points, rewards or governance page and claim only from the link the protocol itself publishes, never from a message or a search ad`,
      cost: `the $${capital} stays in the position; claiming itself should cost under $2 and never a fee paid to a third party`,
      time: `${hold} days of holding, then 10 minutes to check`,
    },
    {
      text: `Log the wallet, the dates, the amounts and every transaction hash in a farm log, and unwind the ${p.name} position only after the hold ends or the protocol announces a snapshot date`,
      cost: 'nothing but the log, and about $3 of gas to unwind at the end',
      time: '5 minutes to log, 15 minutes to unwind',
    },
  );
  return steps.slice(0, 7);
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's form for data.js: the same figures, breakdown and farm plan board.json carries. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    model: row.model,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const comparables = buildComparables(snapshot, model);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    comparables,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters once trimmed`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
