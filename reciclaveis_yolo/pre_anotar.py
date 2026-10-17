# pre_anotar.py
# Anotação assistida: o YOLO26n pré-treinado (dataset COCO) encontra ONDE está o objeto
# (ele já conhece "bottle" e "cup"), e a PASTA da foto diz QUAL é a classe.
# Resultado: arquivos .txt no formato YOLO em anotacoes\, para REVISAR no makesense.ai.
#
# Fotos da pasta "misturado" não são pré-anotadas (o modelo genérico não sabe separar
# lata de copo) e devem ser anotadas à mão.
#
# Usa o YOLO26x (o maior: ~110 MB, baixado na 1ª vez) com TTA, porque só roda uma vez e
# acha muito mais objetos difíceis que o YOLO26n. O TREINO continua com o YOLO26n (leve).
# Um .txt que já existe NUNCA é sobrescrito (para não perder correções feitas à mão).

from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

PASTA = Path(__file__).resolve().parent
FOTOS = PASTA / "fotos"
ANOTACOES = PASTA / "anotacoes"
PARA_ANOTAR = PASTA / "fotos_para_anotar"

# pasta → ID da classe (igual ao classes.txt / data.yaml)
CLASSE_DA_PASTA = {"garrafa_pet": 0, "copo_plastico": 1, "lata_aluminio": 2}
MODELO = "yolo26x.pt"
TTA = True                        # analisa também versões espelhadas/em outras escalas (mais lento, acha mais)
COCO_RECIPIENTES = [39, 40, 41]   # bottle, wine glass, cup
CONF_BOA = 0.25                   # caixas com confiança acima disso são aceitas
CONF_MINIMA = 0.08                # sem caixa boa: usa a melhor acima disso, marcada para revisão
AREA_MAXIMA = 0.85                # caixa cobrindo quase a foto toda costuma ser erro


def ler(caminho):
    return cv2.imdecode(np.fromfile(str(caminho), dtype=np.uint8), cv2.IMREAD_COLOR)


def iou(a, b):
    ax1, ay1, ax2, ay2 = a[0] - a[2] / 2, a[1] - a[3] / 2, a[0] + a[2] / 2, a[1] + a[3] / 2
    bx1, by1, bx2, by2 = b[0] - b[2] / 2, b[1] - b[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    uniao = a[2] * a[3] + b[2] * b[3] - inter
    return inter / uniao if uniao > 0 else 0


def main():
    modelo = YOLO(str(PASTA / MODELO) if (PASTA / MODELO).exists() else MODELO)
    ANOTACOES.mkdir(exist_ok=True)
    PARA_ANOTAR.mkdir(exist_ok=True)
    revisar = []

    for pasta_cat in sorted(p for p in FOTOS.iterdir() if p.is_dir()):
        nome = pasta_cat.name
        fotos = sorted(pasta_cat.glob("*.jpg"))
        if nome == "fundo_vazio":
            print(f"{nome:15s} {len(fotos):3d} fotos  (sem objetos: entram no dataset sem anotação)")
            continue
        for f in fotos:   # todas as fotos de objetos vão para a pasta de revisão no makesense
            destino = PARA_ANOTAR / f.name
            if not destino.exists():
                destino.write_bytes(f.read_bytes())
        if nome not in CLASSE_DA_PASTA:
            print(f"{nome:15s} {len(fotos):3d} fotos  (anotar à mão no makesense)")
            revisar += [f"{f.name}  → anotar à mão (misturado)" for f in fotos]
            continue

        classe = CLASSE_DA_PASTA[nome]
        com_caixa = sem_caixa = baixa = mantidas = 0
        for f in fotos:
            if (ANOTACOES / f"{f.stem}.txt").exists():
                mantidas += 1   # já anotada (talvez revisada à mão): não mexe
                continue
            img = ler(f)
            r = modelo.predict(img, conf=CONF_MINIMA, classes=COCO_RECIPIENTES, imgsz=640, device="cpu",
                               augment=TTA, verbose=False)[0]
            caixas = sorted(
                [(float(b.conf), [float(v) for v in b.xywhn[0]]) for b in r.boxes],
                key=lambda c: -c[0],
            )
            caixas = [c for c in caixas if c[1][2] * c[1][3] <= AREA_MAXIMA]

            escolhidas = []
            for conf, xywh in caixas:
                if conf < CONF_BOA:
                    continue
                if all(iou(xywh, e[1]) < 0.6 for e in escolhidas):   # remove caixas duplicadas
                    escolhidas.append((conf, xywh))
            if not escolhidas and caixas:
                escolhidas = [caixas[0]]
                baixa += 1
                revisar.append(f"{f.name}  → confiança baixa ({caixas[0][0]:.2f}): confira a caixa")

            if escolhidas:
                com_caixa += 1
                linhas = [f"{classe} {x:.6f} {y:.6f} {w:.6f} {h:.6f}" for _, (x, y, w, h) in escolhidas]
                (ANOTACOES / f"{f.stem}.txt").write_text("\n".join(linhas) + "\n", encoding="utf-8")
            else:
                sem_caixa += 1
                revisar.append(f"{f.name}  → nenhum objeto encontrado: anotar à mão")
        print(f"{nome:15s} {len(fotos):3d} fotos  pré-anotadas={com_caixa:3d}  "
              f"(confiança baixa={baixa})  sem objeto encontrado={sem_caixa}  já anotadas antes={mantidas}")

    (ANOTACOES / "classes.txt").write_text((PASTA / "classes.txt").read_text(encoding="utf-8"), encoding="utf-8")
    (PASTA / "REVISAR.txt").write_text("\n".join(revisar) + "\n", encoding="utf-8")
    print(f"\nAnotações: {ANOTACOES}")
    print(f"Fotos para revisar no makesense: {PARA_ANOTAR}")
    print(f"Lista do que conferir com atenção: {PASTA / 'REVISAR.txt'} ({len(revisar)} itens)")


if __name__ == "__main__":
    main()
