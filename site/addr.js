/* Address autocomplete for the value page: matches typed text against every
   Pasco street and house number (data/counties/<county>/addresses.json).
   Forgiving by design: words in any order ("Montgomery Bell 1295"), street
   suffix abbreviations (Rd = Road), a typo or two per word, a partly typed last
   word, and city names or a ZIP mixed in. Pure logic; value.js draws the list.
   Works in the browser (window.Addr) and in Node (module.exports). */
(function (root) {
  "use strict";

  const Comps = root.Comps || (typeof require !== "undefined" ? require("./comps.js") : null);
  const IGNORE = new Set(["FL", "FLA", "FLORIDA", "USA"]);
  const UNIT = new Set(["APT", "UNIT", "STE", "SUITE"]);

  const title = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, n, x) => n + x.toLowerCase());

  /** Optimal string alignment distance (Levenshtein + adjacent swaps), giving up past `max`. */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur.push(v);
        rowMin = Math.min(rowMin, v);
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }

  const allowedTypos = (n) => (n >= 8 ? 2 : n >= 4 ? 1 : 0);

  /** Cost of matching query word q to street word w, or null. `partial`: q is still being typed. */
  function wordCost(q, w, partial) {
    if (q === w) return 0;
    if (w.startsWith(q)) return partial ? 0.05 : q.length >= 3 ? 0.3 : null;
    const max = allowedTypos(q.length);
    if (!max) return null;
    let d = editDistance(q, w, max);
    if (partial && w.length > q.length) d = Math.min(d, editDistance(q, w.slice(0, q.length), max) + 0.05);
    return d <= max ? d : null;
  }

  function prepare(index) {
    const cityWords = new Set();
    for (const c of Object.values(index.cities)) for (const w of c.toUpperCase().split(/\s+/)) cityWords.add(w);
    return {
      cities: index.cities, cityWords,
      streets: index.streets.map(([name, zips]) => ({ name, words: name.split(" "), zips, nums: {} })),
    };
  }

  function numbers(street, zip) {
    if (!street.nums[zip]) street.nums[zip] = street.zips[zip].split(" ").map(Number);
    return street.nums[zip];
  }

  /** Split typed text into a house number, street words, an optional ZIP and city words. */
  function parse(text, idx) {
    const raw = String(text).toUpperCase().replace(/[^\w\s]/g, " ");
    const partial = !/\s$/.test(raw);
    let tokens = raw.split(/\s+/).filter(Boolean);
    const unit = tokens.findIndex((t) => UNIT.has(t));
    if (unit >= 0) tokens = tokens.slice(0, unit);
    let number = null, zip = null;
    const words = [];
    tokens.forEach((t, i) => {
      if (IGNORE.has(t)) return;
      if (/^\d+$/.test(t)) {
        if (t.length === 5 && idx.cities[t] && (number || i > 0)) zip = t;
        else if (number == null) number = t;
        return;
      }
      const full = Comps && Comps.SUFFIX[t];
      words.push(full && full !== t ? [full, t] : [t]);           // "RD" also tries ROAD
    });
    const lastIsWord = words.length && tokens.length && !/^\d+$/.test(tokens[tokens.length - 1]);
    return { number, zip, words, partialLast: partial && lastIsWord };
  }

  /** Score a street against the query words; null if some word matches neither the street nor a city. */
  function scoreStreet(street, q, idx) {
    let cost = 0, matched = 0;
    const cityWords = [];
    q.words.forEach((qw, i) => {
      if (cost == null) return;
      const partial = q.partialLast && i === q.words.length - 1;
      let best = null;
      for (const form of qw) {
        for (const w of street.words) {
          const c = wordCost(form, w, partial);
          if (c != null && (best == null || c < best)) best = c;
        }
      }
      if (best != null) { cost += best; matched++; return; }
      const w0 = qw[qw.length - 1];
      if (idx.cityWords.has(w0) || (partial && [...idx.cityWords].some((c) => c.startsWith(w0)))) { cityWords.push(w0); return; }
      if (w0.length === 1) { cost += 0.2; return; }            // stray initial or direction (N, S...)
      cost = null;
    });
    if (cost == null || !matched) return null;
    return { cost: cost + 0.03 * (street.words.length - matched), cityWords };
  }

  function zipsFor(street, q, cityWords, idx) {
    let zips = Object.keys(street.zips);
    if (q.zip && zips.includes(q.zip)) zips = [q.zip];
    if (cityWords.length) {
      const inCity = zips.filter((z) => cityWords.every((w) => idx.cities[z].toUpperCase().split(" ").some((c) => c.startsWith(w))));
      if (inCity.length) zips = inCity;
    }
    return zips;
  }

  function addressItem(street, zip, num, idx, cost, near) {
    const city = idx.cities[zip] || "";
    const line = `${num} ${title(street.name)}`;
    return { kind: "address", label: line, sub: `${city} ${zip}`, value: `${line}, ${city}, FL ${zip}`,
      key: `${num} ${street.name}`, zip, cost, near: Boolean(near) };
  }

  /** Suggestions for typed text: addresses when a house number is typed, otherwise streets. */
  function search(text, idx, limit = 8) {
    const q = parse(text, idx);
    if (!q.words.length) return [];
    const scored = [];
    for (const s of idx.streets) {
      const r = scoreStreet(s, q, idx);
      if (r) scored.push({ street: s, ...r });
    }
    scored.sort((a, b) => a.cost - b.cost || a.street.name.length - b.street.name.length || (a.street.name < b.street.name ? -1 : 1));
    if (!scored.length) return [];
    const close = scored.filter((s) => s.cost <= scored[0].cost + 1.5).slice(0, 12);

    if (q.number) {
      const out = [];
      for (const s of close) {
        for (const z of zipsFor(s.street, q, s.cityWords, idx)) {
          for (const n of numbers(s.street, z)) {
            const t = String(n);
            if (t === q.number) out.push(addressItem(s.street, z, n, idx, s.cost));
            else if (t.startsWith(q.number)) out.push(addressItem(s.street, z, n, idx, s.cost + 0.1 + 0.01 * (t.length - q.number.length)));
          }
        }
      }
      if (out.length) {
        out.sort((a, b) => a.cost - b.cost || parseInt(a.key) - parseInt(b.key));
        return out.slice(0, limit);
      }
      // No such house number. If the street is clear, offer the nearest numbers on it;
      // if the street is still ambiguous ("1295 Mont"), fall through to street names.
      const want = parseInt(q.number, 10);
      const clear = close.filter((s) => s.cost <= close[0].cost + 0.1).length <= 2;
      for (const s of clear ? close.slice(0, 2) : []) {
        for (const z of zipsFor(s.street, q, s.cityWords, idx)) {
          const nearest = numbers(s.street, z).slice().sort((a, b) => Math.abs(a - want) - Math.abs(b - want)).slice(0, 2);
          for (const n of nearest) out.push(addressItem(s.street, z, n, idx, s.cost + 1 + Math.abs(n - want) / 1e6, true));
        }
      }
      if (out.length) {
        out.sort((a, b) => a.cost - b.cost);
        return out.slice(0, limit);
      }
    }

    // Street mode. When one street is clearly what was typed, list its houses instead.
    const exact = close.filter((s) => s.cost < 0.1);
    if (exact.length === 1 && !q.partialLast && !q.number) {
      const s = exact[0];
      return zipsFor(s.street, q, s.cityWords, idx)
        .flatMap((z) => numbers(s.street, z).map((n) => addressItem(s.street, z, n, idx, 0)))
        .slice(0, limit);
    }
    const out = [];
    for (const s of close) {
      for (const z of zipsFor(s.street, q, s.cityWords, idx)) {
        const name = title(s.street.name), city = idx.cities[z] || "";
        out.push({ kind: "street", label: name, sub: `${city} ${z} · ${numbers(s.street, z).length.toLocaleString("en-US")} homes`,
          value: `${name} `, zip: z, cost: s.cost });
      }
    }
    return out.slice(0, limit);
  }

  const api = { prepare, search, parse, editDistance, title };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Addr = api;
})(typeof window !== "undefined" ? window : globalThis);
