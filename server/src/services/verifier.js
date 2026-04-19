const { parseFirstCurrency, parseFirstPercent } = require("../lib/answerVerifier");

function verifyNarrativeNumbers(narrative, expected) {
  const tol = expected.tolerance ?? 0.02;
  const mismatches = [];

  const currencyInText = parseFirstCurrency(narrative);
  if (currencyInText != null && expected.currencyTargets?.length) {
    const target = expected.currencyTargets[0];
    if (
      Number.isFinite(target) &&
      target !== 0 &&
      Math.abs(currencyInText - target) / Math.max(Math.abs(target), 1e-9) > tol
    ) {
      mismatches.push({ kind: "currency", found: currencyInText, expected: target });
    }
  }

  const pctInText = parseFirstPercent(narrative);
  if (pctInText != null && expected.percentTargets?.length) {
    const target = expected.percentTargets[0];
    if (Number.isFinite(target) && Math.abs(pctInText - target) > 0.6) {
      mismatches.push({ kind: "percent", found: pctInText, expected: target });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

function applyNumericGuardrails(narrative, computedSummary) {
  const v = verifyNarrativeNumbers(narrative, {
    currencyTargets: computedSummary?.currencyTargets,
    percentTargets: computedSummary?.percentTargets,
  });
  if (v.ok) return { text: narrative, repaired: false };

  const facts = computedSummary?.bulletFacts || "";
  const note =
    "\n\n*(Figures above are server-computed from your CSV; any conflicting numbers in the narrative were discarded.)*";
  const text = facts
    ? `${facts.trim()}\n\n${String(narrative || "").trim()}${note}`
    : `${String(narrative || "").trim()}${note}`;
  return { text, repaired: true };
}

module.exports = { verifyNarrativeNumbers, applyNumericGuardrails };
