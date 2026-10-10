"""Imbalance-aware metrics and validation-only operating-point selection."""
from __future__ import annotations

import math
import numpy as np


def confusion(labels: np.ndarray, predictions: np.ndarray, costs: dict) -> dict:
    y = np.asarray(labels, dtype=bool)
    predicted = np.asarray(predictions, dtype=bool)
    tp, fp, fn, tn = [int(value) for value in [np.sum(y & predicted), np.sum(~y & predicted), np.sum(y & ~predicted), np.sum(~y & ~predicted)]]
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": tp / (tp + fp) if tp + fp else 0.0,
            "recall": tp / (tp + fn) if tp + fn else 0.0,
            "fpr": fp / (fp + tn) if fp + tn else 0.0,
            "reviews": tp + fp,
            "error_cost": fp * costs["false_positive_cost"] + fn * costs["false_negative_cost"]}


def average_precision(labels: np.ndarray, scores: np.ndarray) -> float:
    """Noninterpolated PR-AUC (average precision), grouping tied scores."""
    labels = np.asarray(labels, dtype=np.int64)
    scores = np.asarray(scores, dtype=np.float64)
    positives = int(labels.sum())
    if not positives:
        return 0.0
    order = np.argsort(-scores, kind="stable")
    sorted_y, sorted_scores = labels[order], scores[order]
    ends = np.r_[np.flatnonzero(np.diff(sorted_scores) != 0), len(scores) - 1]
    cumulative = np.cumsum(sorted_y)[ends]
    precision = cumulative / (ends + 1)
    recall = cumulative / positives
    return float(np.sum(precision * np.diff(np.r_[0.0, recall])))


def select_thresholds(labels: np.ndarray, scores: np.ndarray, costs: dict) -> dict:
    # Finite >1 represents accepting no score; avoids JSON Infinity. Test
    # labels never enter this function in the training pipeline.
    candidates = np.r_[np.nextafter(1.0, 2.0), np.unique(scores)]
    evaluated = [(float(threshold), confusion(labels, scores >= threshold, costs)) for threshold in candidates]
    cost_threshold, _ = min(evaluated, key=lambda pair: (pair[1]["error_cost"], pair[1]["reviews"], -pair[0]))
    fpr_threshold, _ = max((pair for pair in evaluated if pair[1]["fpr"] <= costs["max_fpr"]),
                           key=lambda pair: (pair[1]["recall"], -pair[1]["fpr"], pair[0]))
    capacity = math.floor(len(scores) * costs["review_fraction"])
    cap_threshold, _ = max((pair for pair in evaluated if pair[1]["reviews"] <= capacity),
                           key=lambda pair: (pair[1]["recall"], pair[1]["precision"], pair[0]))
    return {"selected_on": "validation", "minimum_cost": cost_threshold, "fixed_fpr": fpr_threshold,
            "review_capacity": cap_threshold, "max_fpr": costs["max_fpr"],
            "review_fraction": costs["review_fraction"],
            "capacity_policy": "validation threshold then at most floor(fraction * window rows), ranked by score; ties use stable transaction order"}


def evaluate(labels: np.ndarray, scores: np.ndarray, thresholds: dict, costs: dict) -> dict:
    capacity = math.floor(len(scores) * thresholds["review_fraction"])
    eligible = np.flatnonzero(scores >= thresholds["review_capacity"])
    order = eligible[np.argsort(-scores[eligible], kind="stable")][:capacity]
    selected = np.zeros(len(scores), dtype=bool)
    selected[order] = True
    return {
        "rows": len(scores), "positives": int(labels.sum()),
        "pr_auc_average_precision": average_precision(labels, scores),
        "minimum_cost": confusion(labels, scores >= thresholds["minimum_cost"], costs),
        "fixed_fpr": {**confusion(labels, scores >= thresholds["fixed_fpr"], costs), "validation_fpr_target": thresholds["max_fpr"]},
        "review_capacity": {**confusion(labels, selected, costs), "capacity": capacity},
        "brier_score": float(np.mean((scores - labels) ** 2)),
        "fpr_note": "The FPR constraint is selected on validation; future-window FPR may drift.",
    }
