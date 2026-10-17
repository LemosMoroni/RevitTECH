# verificar_ambiente.py
# Confere se o Python e as bibliotecas do projeto estão instalados corretamente.

import platform
import sys

print("=" * 55)
print("VERIFICAÇÃO DO AMBIENTE - Reconhecimento de Recicláveis")
print("=" * 55)

# 1) Versão do Python e se o ambiente virtual está ativo
print(f"Python: {platform.python_version()}")
print(f"Executável: {sys.executable}")
venv_ativo = sys.prefix != sys.base_prefix
print(f"Ambiente virtual ativo: {'SIM' if venv_ativo else 'NÃO  <-- ative o .venv!'}")
print()

# 2) PyTorch (motor da IA)
try:
    import torch
    print(f"PyTorch: {torch.__version__}")
    print(f"GPU NVIDIA (CUDA) disponível: {torch.cuda.is_available()}  (False é normal: vamos usar CPU)")
except ImportError:
    print("ERRO: PyTorch não está instalado. Rode o comando de instalação do torch.")

# 3) OpenCV (webcam e desenho na imagem)
try:
    import cv2
    print(f"OpenCV: {cv2.__version__}")
except ImportError:
    print("ERRO: OpenCV não está instalado. Rode: pip install opencv-python")

# 4) Ultralytics (YOLO)
try:
    import ultralytics
    print(f"Ultralytics: {ultralytics.__version__}")
except ImportError:
    print("ERRO: Ultralytics não está instalado. Rode: pip install -U ultralytics")
    sys.exit(1)

print()
print("Informações do computador (CPU, memória RAM, disco):")
ultralytics.checks()

# 5) Teste final: carregar o modelo YOLO26n pré-treinado
print()
print("Carregando o modelo YOLO26n (na primeira vez baixa um arquivo pequeno, de poucos MB)...")
from ultralytics import YOLO

modelo = YOLO("yolo26n.pt")
print(f"Modelo carregado! Ele já conhece {len(modelo.names)} classes genéricas (pessoa, carro, garrafa...).")
print("Na Etapa 7 vamos ensiná-lo a reconhecer as NOSSAS 3 classes.")
print("=" * 55)
print("Ambiente pronto! Pode seguir para a Etapa 2.")