import torch
import torch.nn as nn

class TinyModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 2)

    def forward(self, x):
        return self.fc(x)

model = TinyModel().eval()

dummy = torch.randn(1, 4)
torch.onnx.export(
    model,
    dummy,
    "test.onnx",
    input_names=["input"],
    output_names=["output"],
    opset_version=11,
)

print("test.onnx file created!")
