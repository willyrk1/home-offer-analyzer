/* Offer suggestions and the concessions converter for the value page. Pure functions.
   Works in the browser (window.Offer) and in Node (module.exports).

   The offer prices are positions in the calibrated 50% range, which held the sale price of
   half of past sales (backtest.calibrate): its low end is roughly where 1 in 4 similar homes
   sold for less, its high end where 3 in 4 did.
     opening   = low end of the 50% range
     target    = fair value (half of similar homes sold for less)
     walk-away = high end of the 50% range
   None goes above the list price. Market signals don't move these numbers: in the backtest
   they didn't predict sale vs fair value (pipeline/leverage.py). */
(function (root) {
  "use strict";

  const floorK = (v) => Math.floor(v / 1000) * 1000;
  const roundK = (v) => Math.round(v / 1000) * 1000;

  /** fair: value; range50: [lo, hi] calibrated 50% range; list: optional list price. */
  function plan(fair, range50, list) {
    if (fair == null || !range50) return null;
    const [lo, hi] = range50;
    const notes = [];
    let opening = floorK(lo), target = roundK(fair), walkaway = floorK(hi);
    if (list) {
      if (list <= lo) {
        notes.push("listed_low");
        opening = target = list;                    // already a good price; others will see it too
      } else {
        opening = Math.min(opening, list);
        target = Math.min(target, list);
        walkaway = Math.min(walkaway, list);
        if (list > hi) notes.push("listed_high");
      }
    }
    walkaway = Math.max(walkaway, target);
    // A lender's appraiser works from the same closed sales, so expect an appraisal near fair value.
    const gap = (offer) => Math.max(0, offer - fair);
    return { opening, target, walkaway, notes, appraisal_gap: { target: gap(target), walkaway: gap(walkaway) } };
  }

  /** Monthly principal and interest. rate in % per year. */
  function payment(loan, ratePct, years = 30) {
    const r = ratePct / 100 / 12, n = years * 12;
    return r === 0 ? loan / n : loan * r / (1 - (1 + r) ** -n);
  }

  /** What a seller credit is worth three ways. Inputs: price, credit, downPct, ratePct,
      dropPerPoint (rate cut in % per point of 1% of the loan), years. */
  function concessions({ price, credit, downPct, ratePct, dropPerPoint, years = 30 }) {
    const down = downPct / 100, loan = price * (1 - down);
    const base = payment(loan, ratePct, years);
    const points = loan > 0 ? credit / (loan * 0.01) : 0;
    const newRate = Math.max(0, ratePct - points * dropPerPoint);
    const buydownSaving = base - payment(loan, newRate, years);
    const perLoanDollar = payment(1, ratePct, years);             // monthly payment per $ borrowed
    const cutSaving = credit * (1 - down) * perLoanDollar;        // same-dollar price cut
    return {
      loan, payment: base,
      closing_costs: { cash_saved: credit },
      buydown: { points, new_rate: newRate, monthly_saving: buydownSaving,
        price_cut_equivalent: buydownSaving / ((1 - down) * perLoanDollar) },
      price_cut: { cash_saved: credit * down, monthly_saving: cutSaving },
    };
  }

  const api = { plan, payment, concessions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Offer = api;
})(typeof window !== "undefined" ? window : globalThis);
