"""Run from the repository root: python -m examples.anti_fraud_reference."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from .data import generate_dataset
from .pipeline import export_predictions, train
from .report import generate_tables


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthetic anti-fraud infrastructure reference; no real fraud-model claims")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate-data")
    generate.add_argument("--output", type=Path, required=True)
    generate.add_argument("--rows", type=int, default=4000)
    generate.add_argument("--seed", type=int, default=91)
    generate.add_argument("--label-delay", type=int, default=24)
    for name in ["train", "resume", "suite"]:
        command = commands.add_parser(name)
        command.add_argument("--config", type=Path, required=True)
        command.add_argument("--data", type=Path, required=True)
        command.add_argument("--manifest", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
        if name == "resume":
            command.add_argument("--allow-retained-fallback", action="store_true", help="explicitly permit rollback to a retained usable resume checkpoint")
        if name == "train":
            command.add_argument("--stop-after-epoch", type=int, help="explicitly pause after a complete epoch checkpoint")
        if name == "suite":
            command.add_argument("--seeds", type=int, nargs="+", required=True)
    evaluate = commands.add_parser("evaluate-export")
    evaluate.add_argument("--checkpoints", type=Path, required=True)
    evaluate.add_argument("--data", type=Path, required=True)
    evaluate.add_argument("--manifest", type=Path, required=True)
    evaluate.add_argument("--output", type=Path, required=True)
    report = commands.add_parser("tables")
    report.add_argument("--results", type=Path, nargs="+", required=True)
    report.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "generate-data":
        result = generate_dataset(args.output, args.rows, args.seed, args.label_delay)
    elif args.command in {"train", "resume"}:
        result = train(json.loads(args.config.read_text()), args.data, args.manifest, args.output,
                       resume=args.command == "resume", allow_fallback=getattr(args, "allow_retained_fallback", False),
                       stop_after_epoch=getattr(args, "stop_after_epoch", None))
    elif args.command == "suite":
        config = json.loads(args.config.read_text())
        if len(set(args.seeds)) != len(args.seeds):
            parser.error("suite seeds must be distinct")
        paths = []
        for model, use_history in [("logistic", True), ("mlp", True), ("mlp", False)]:
            for seed in args.seeds:
                variant = copy.deepcopy(config)
                variant.update(model=model, seed=seed, use_history=use_history)
                output = args.output / f"{model}-{'full' if use_history else 'no-history'}-seed{seed}"
                train(variant, args.data, args.manifest, output)
                paths.append(output / "results.json")
        result = generate_tables(paths, args.output / "paper")
    elif args.command == "evaluate-export":
        result = export_predictions(args.checkpoints, args.data, args.manifest, args.output)
    else:
        result = generate_tables(args.results, args.output)
    print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
