"""Generate manuscript tables from saved run results; never invented values."""
from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import statistics

from .checkpoints import atomic_bytes, atomic_json, digest_file, digest_json


def generate_tables(results_paths: list[Path], output: Path) -> dict:
    groups = defaultdict(list)
    citations = []
    for path in results_paths:
        result = json.loads(path.read_text())
        if result.get("format_version") != 1 or result.get("kind") != "synthetic-infrastructure-only" or result.get("status") != "completed":
            raise ValueError(f"not a completed synthetic reference result: {path}")
        # Distinct run IDs prevent inflating the seed count by reading the same
        # artifact twice. Repeated seeds are not independent repetitions.
        if any(entry["run_id"] == result["run_id"] for entry in citations):
            raise ValueError("duplicate run ID")
        comparison_config = {key: value for key, value in result["config"].items() if key != "seed"}
        group = (result["model"], result["ablation"], digest_json(comparison_config), result["provenance"]["dataset_sha256"],
                 result["provenance"]["source"]["sha256"])
        if any(entry["seed"] == result["seed"] for entry in groups[group]):
            raise ValueError("duplicate seed within comparison group")
        groups[group].append(result)
        citations.append({"run_id": result["run_id"], "results": str(path.resolve()),
                          "results_sha256": digest_file(path),
                          "config_sha256": result["provenance"]["config_sha256"],
                          "dataset_sha256": result["provenance"]["dataset_sha256"],
                          "source_sha256": result["provenance"]["source"]["sha256"],
                          "best_checkpoint": result["checkpoints"]["best_validation"],
                          "export": result["checkpoints"]["final_export"]})
    lines = ["# Generated synthetic infrastructure results", "",
             "No real fraud-model performance or superiority is established. Values below are read from completed saved runs.", "",
             "PR-AUC is noninterpolated average precision. Mean ± sample standard deviation describes configured seed variation; it is not a confidence interval or uncertainty over real fraud data.", "",
             "| Model | Ablation | Independent seeds | Test PR-AUC | Recall at validation FPR target | Precision at review capacity | Error cost |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    summary = []
    for (model, ablation, comparison_sha, dataset_sha, source_sha), entries in sorted(groups.items()):
        def describe(getter):
            values = [float(getter(entry)) for entry in entries]
            mean = statistics.mean(values)
            standard_deviation = statistics.stdev(values) if len(values) > 1 else None
            return {"mean": mean, "sample_std": standard_deviation}, f"{mean:.4f}" + (f" ± {standard_deviation:.4f}" if standard_deviation is not None else " (uncertainty not evaluated)")
        pr, pr_text = describe(lambda entry: entry["test"]["pr_auc_average_precision"])
        recall, recall_text = describe(lambda entry: entry["test"]["fixed_fpr"]["recall"])
        precision, precision_text = describe(lambda entry: entry["test"]["review_capacity"]["precision"])
        cost, cost_text = describe(lambda entry: entry["test"]["minimum_cost"]["error_cost"])
        lines.append(f"| {model} | {ablation} | {len(entries)} | {pr_text} | {recall_text} | {precision_text} | {cost_text} |")
        summary.append({"model": model, "ablation": ablation, "seeds": sorted(entry["seed"] for entry in entries),
                        "comparison_config_sha256_excluding_seed": comparison_sha,
                        "dataset_sha256": dataset_sha, "source_sha256": source_sha,
                        "pr_auc": pr, "recall_fixed_fpr": recall, "precision_capacity": precision, "error_cost": cost})
    lines += ["", "Actual test FPR can exceed the validation-selected target. Review allocation is capped independently in the evaluation window.", "",
              "## Run provenance", ""]
    for citation in citations:
        lines.append(f"- `{citation['run_id']}`: `{citation['results']}`; config `{citation['config_sha256']}`; dataset `{citation['dataset_sha256']}`; source `{citation['source_sha256']}`; best `{citation['best_checkpoint']}`; export `{citation['export']}`.")
    if not groups:
        lines += ["No experiments executed. Baseline, MLP comparison, history ablation and multiple-seed uncertainty are planned."]
    output.mkdir(parents=True, exist_ok=True)
    atomic_bytes(output / "tables.md", ("\n".join(lines) + "\n").encode())
    record = {"generator": "examples.anti_fraud_reference.report.generate_tables", "generator_source_sha256": digest_file(Path(__file__)),
              "kind": "synthetic-infrastructure-only",
              "groups": summary, "runs": citations,
              "research_status": {"real_data": "absent", "physical_gpu_comparison": "not-executed",
                                  "real_model_superiority": "not-evaluated", "confidence_intervals": "not-executed"}}
    atomic_json(output / "table-provenance.json", record)
    return record
