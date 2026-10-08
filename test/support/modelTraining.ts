/** Real CPU model fitting, repository inputs, checkpoint reload and evaluation. */
export const trainingProgram = `import csv, json, os, time
from pathlib import Path
from training_helpers import predict
root = Path.cwd()
config = json.loads((root / 'config.json').read_text())
with (root / config['dataset']).open() as stream:
    rows = [(float(row['x']), float(row['y'])) for row in csv.DictReader(stream)]
weights = [0.0, 0.0]
print('TRAINING_STARTED', flush=True)
time.sleep(config.get('delay', 0))
for epoch in range(400):
    errors = [predict(weights, x) - y for x, y in rows]
    weights[0] -= 0.05 * sum(error * x for error, (x, _) in zip(errors, rows)) / len(rows)
    weights[1] -= 0.05 * sum(errors) / len(rows)
checkpoint = root / 'checkpoints' / 'model.json'
checkpoint.parent.mkdir(exist_ok=True)
checkpoint.write_text(json.dumps({'weights': weights, 'epochs': epoch + 1}))
restored = json.loads(checkpoint.read_text())['weights']
mse = sum((predict(restored, x) - y) ** 2 for x, y in rows) / len(rows)
assert mse < 1e-10, mse
assert abs(predict(restored, 3) - 7) < 1e-4
print(json.dumps({'mse': mse, 'prediction': predict(restored, 3), 'checkpoint': str(checkpoint)}), flush=True)
`;
export const trainingHelper = 'def predict(weights, x):\n    return weights[0] * x + weights[1]\n';
export const trainingData = 'x,y\n-2,-3\n-1,-1\n0,1\n1,3\n2,5\n';
