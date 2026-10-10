"""Nested entrypoint for Pair Notebook detached compute jobs.

The job snapshots this package; owner datasets are separately provisioned by
the compute agent's --data-manifest, rather than embedded in the source job.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from examples.anti_fraud_reference.__main__ import main


if __name__ == "__main__":
    main()
