import onnxruntime as ort
import os

# Use relative path
model_path = os.path.join(os.path.dirname(__file__), "test.onnx")

sess = ort.InferenceSession(
    model_path,
    providers=[
        "CUDAExecutionProvider",
        "CPUExecutionProvider"
    ]
)

print("Model loaded from:", model_path)
print("Providers:", sess.get_providers())
print("GPU available:", "CUDAExecutionProvider" in sess.get_providers())
