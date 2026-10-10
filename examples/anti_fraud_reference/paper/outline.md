# Research manuscript outline — no real results supplied

This is a collaboratively editable scaffold. No journal requirements or real
anti-fraud dataset were provided. Do not describe the synthetic infrastructure
test as evidence of real fraud detection quality or model superiority.

1. **Problem and deployment setting — requires verification.** Document the
   owner dataset, prediction timestamp, fraud-label delay, customer population,
   review capacity and monetary false-positive/false-negative costs.
2. **Data — absent.** Record dataset permissions/version, chronological windows,
   label maturity, gap rationale, prevalence, known/new customer definitions,
   exclusions and causal availability of every aggregate.
3. **Methods — planned for real data.** Compare logistic baseline and an MLP.
   Fit preprocessing only on mature training rows. Choose checkpoints and
   operating thresholds only on validation. Freeze the final test window.
4. **Experiments — real data not executed.** Baseline comparison, customer
   subgroups, history ablation, multiple independent seeds, time-window shifts,
   calibration and uncertainty require real data and justified protocols.
   The reference CLI can execute the first comparison, ablation and seed runs
   on explicitly synthetic data; describe their actual execution separately.
5. **Results — populate only from saved artifacts.** Run
   `python -m examples.anti_fraud_reference tables --results ... --output ...`.
   Keep the generated `tables.md` and `table-provenance.json` together. Each row
   links run ID, config, data/source hashes, best checkpoint and final export.
6. **Infrastructure validation.** Report deterministic CPU resume equivalence,
   corruption/incomplete-write rejection, frozen inputs and filesystem tests.
   External VPS, real GPU, Windows, native VS Code and multi-hour soak results
   must be linked to separate evidence before being described as verified.
7. **Limitations.** Synthetic distributions, delayed-label assumptions,
   validation-to-test FPR drift, seed standard deviation versus confidence
   intervals, provider failures and trusted checkpoint deserialization.
8. **References — not supplied.** Add only verified sources. No DOI, citations,
   novelty or executed experiments are invented here.
