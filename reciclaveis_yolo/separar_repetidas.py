# separar_repetidas.py
# Move as fotos quase idênticas para fotos_repetidas\ (nada é apagado).
# Fotos repetidas gastam tempo de anotação e, se caírem uma no treino e outra na validação,
# deixam a avaliação do modelo otimista demais.

import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

PASTA = Path(__file__).resolve().parent
FOTOS = PASTA / "fotos"
REPETIDAS = PASTA / "fotos_repetidas"
LIMIAR = 12   # diferença máxima (de 240) para considerar "a mesma foto"; maior = mais rigoroso


def ler(caminho):
    return cv2.imdecode(np.fromfile(str(caminho), dtype=np.uint8), cv2.IMREAD_COLOR)


def assinatura(img):
    """dHash: compara cada pixel com o vizinho numa versão minúscula e cinza da foto."""
    pequena = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (17, 16), interpolation=cv2.INTER_AREA)
    return (pequena[:, 1:] > pequena[:, :-1]).flatten()


def main():
    if not FOTOS.exists():
        sys.exit(f"Pasta não encontrada: {FOTOS}")
    total_movidas = 0
    for pasta_cat in sorted(p for p in FOTOS.iterdir() if p.is_dir()):
        mantidas = []
        movidas = 0
        for foto in sorted(pasta_cat.glob("*.jpg")):   # ordem do nome = ordem em que foram tiradas
            img = ler(foto)
            if img is None:
                print(f"  (ignorada, não abriu) {foto.name}")
                continue
            h = assinatura(img)
            if mantidas and min(int((h != m).sum()) for m in mantidas) <= LIMIAR:
                destino = REPETIDAS / pasta_cat.name
                destino.mkdir(parents=True, exist_ok=True)
                shutil.move(str(foto), str(destino / foto.name))
                movidas += 1
            else:
                mantidas.append(h)
        total_movidas += movidas
        print(f"{pasta_cat.name:15s} mantidas={len(mantidas):3d}  movidas para fotos_repetidas={movidas:3d}")
    print(f"\nTotal movido: {total_movidas} foto(s) → {REPETIDAS}")


if __name__ == "__main__":
    main()
