# treinar.py
# Etapa 7: treina o YOLO26n para reconhecer garrafa PET, copo plástico e lata de alumínio.
#
# Ponto de partida: os pesos pré-treinados do YOLO26n (ele já sabe "ver" formas, bordas e
# objetos em geral). O treino ajusta esse conhecimento para as NOSSAS 3 classes.

import shutil
import time
from pathlib import Path

from ultralytics import YOLO

PASTA = Path(__file__).resolve().parent
DATA_YAML = PASTA / "dataset" / "data.yaml"
MODELO_BASE = PASTA / "yolo26n.pt"            # pesos pré-treinados (baixados na Etapa 1)
MODELO_FINAL = PASTA / "modelo_reciclaveis.pt"  # cópia do melhor modelo, usada pelo reconhecer.py

# ---------- Configurações (leves, para CPU e 8 GB de RAM) ----------
EPOCAS = 30            # quantas vezes o modelo vê o dataset de treino inteiro
TAMANHO_IMAGEM = 640   # as fotos são redimensionadas para 640 px antes de entrar no modelo
BATCH = 2              # quantas fotos ele processa de uma vez (menor = usa menos memória)
DISPOSITIVO = "cpu"    # "cpu" ou 0 (primeira GPU NVIDIA, se houver)


def main():
    if not DATA_YAML.exists():
        print(f"ERRO: {DATA_YAML} não encontrado. Rode antes: python organizar_dataset.py")
        return

    modelo = YOLO(str(MODELO_BASE) if MODELO_BASE.exists() else "yolo26n.pt")
    print(f"Treinando com {DATA_YAML}")
    print(f"Épocas={EPOCAS}  imagem={TAMANHO_IMAGEM}px  batch={BATCH}  dispositivo={DISPOSITIVO}\n")

    inicio = time.time()
    metricas = modelo.train(
        data=str(DATA_YAML),
        epochs=EPOCAS,
        imgsz=TAMANHO_IMAGEM,
        batch=BATCH,
        device=DISPOSITIVO,
        workers=0,          # 0 = sem processos extras (evita erros e falta de memória no Windows)
        cache=False,        # não guarda as imagens na RAM
        project=str(PASTA / "runs"),
        name="reciclaveis",
        seed=0,             # torna o treino repetível
        plots=True,         # salva gráficos (results.png, matriz de confusão...)
    )
    minutos = (time.time() - inicio) / 60

    pasta_treino = Path(modelo.trainer.save_dir)
    melhor = pasta_treino / "weights" / "best.pt"
    print("\n" + "=" * 60)
    print(f"Treino concluído em {minutos:.1f} minutos.")
    print(f"Resultados e gráficos: {pasta_treino}")
    if melhor.exists():
        shutil.copy2(melhor, MODELO_FINAL)
        print(f"Melhor modelo: {melhor}")
        print(f"Cópia para usar no reconhecimento: {MODELO_FINAL}")
    try:
        caixa = metricas.box
        print("\nMétricas na VALIDAÇÃO (fotos que o modelo não usou para aprender):")
        print(f"  Precisão (P):  {caixa.mp:.2f}   → das caixas que ele desenhou, quantas estavam certas")
        print(f"  Revocação (R): {caixa.mr:.2f}   → dos objetos que existiam, quantos ele achou")
        print(f"  mAP50:         {caixa.map50:.2f}   → nota geral (0 a 1) com acerto de posição 'razoável'")
        print(f"  mAP50-95:      {caixa.map:.2f}   → nota geral exigindo caixas cada vez mais precisas")
    except Exception:
        pass
    print("=" * 60)


if __name__ == "__main__":
    main()
