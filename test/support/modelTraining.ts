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

/** Binary tensors are deliberately kept in the owner's repository, outside guest/job snapshots. */
export const torchPython = process.env.PAIR_NOTEBOOK_TEST_TORCH_PYTHON || 'python3';
export const torchDatasetSetup = `import sys, torch
torch.save({'inputs': torch.tensor([[-2.], [-1.], [0.], [1.], [2.]], dtype=torch.float64),
            'targets': torch.tensor([[-3.], [-1.], [1.], [3.], [5.]], dtype=torch.float64)}, sys.argv[1])
`;

export const torchTrainingProgram = `import json, os, time, torch
from pathlib import Path
from training_helpers import predict
torch.set_num_threads(1)
torch.manual_seed(42)
root = Path.cwd()
config = json.loads((root / 'config.json').read_text())
dataset_root = Path(os.environ['PAIR_NOTEBOOK_WORKSPACE'])
data = torch.load(dataset_root / config['dataset'], map_location='cpu', weights_only=True)
dataset = torch.utils.data.TensorDataset(data['inputs'], data['targets'])
loader = torch.utils.data.DataLoader(dataset, batch_size=2, shuffle=True, generator=torch.Generator().manual_seed(42))
model = torch.nn.Linear(1, 1, dtype=torch.float64)
optimizer = torch.optim.SGD(model.parameters(), lr=0.05, momentum=0.5)
print('TORCH_TRAINING_STARTED', flush=True)
time.sleep(config.get('delay', 0))
model.train()
steps = 0
for epoch in range(100):
    for inputs, targets in loader:
        optimizer.zero_grad()
        loss = torch.nn.functional.mse_loss(model(inputs), targets)
        loss.backward()
        optimizer.step()
        steps += 1
checkpoint = root / 'checkpoints' / 'model.pt'
checkpoint.parent.mkdir(exist_ok=True)
temporary = checkpoint.with_suffix('.tmp')
torch.save({'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'epochs': epoch + 1, 'steps': steps}, temporary)
os.replace(temporary, checkpoint)
restored = torch.load(checkpoint, map_location='cpu', weights_only=True)
evaluation_model = torch.nn.Linear(1, 1, dtype=torch.float64)
evaluation_model.load_state_dict(restored['model'])
evaluation_optimizer = torch.optim.SGD(evaluation_model.parameters(), lr=0.05, momentum=0.5)
evaluation_optimizer.load_state_dict(restored['optimizer'])
assert evaluation_optimizer.state_dict()['state'], 'optimizer state was not restored'
evaluation_model.eval()
with torch.no_grad():
    mse = torch.nn.functional.mse_loss(evaluation_model(data['inputs']), data['targets']).item()
    prediction = evaluation_model(torch.tensor([[3.]], dtype=torch.float64)).item()
weights = [evaluation_model.weight.item(), evaluation_model.bias.item()]
assert mse < 1e-10, mse
assert abs(prediction - 7) < 1e-4, prediction
assert abs(predict(weights, 3) - prediction) < 1e-10
metrics = {'backend': 'pytorch', 'torch_version': str(torch.__version__), 'weights': weights,
           'epochs': restored['epochs'], 'steps': restored['steps'], 'mse': mse, 'prediction': prediction,
           'checkpoint_reloaded': True, 'optimizer_state_reloaded': True}
(root / 'checkpoints' / 'model.json').write_text(json.dumps(metrics))
print(json.dumps(metrics), flush=True)
`;
