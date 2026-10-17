# testar.py
# Etapa 9: avalia o modelo treinado e aponta onde ele erra.
#
# Três testes:
#   1) Métricas oficiais no conjunto de validação (por classe).
#   2) Fotos que NUNCA entraram no treino (fotos_repetidas\) + falsos positivos nos fundos.
#   3) Teste de estresse: as mesmas fotos com menos luz, borradas e com o objeto pequeno
#      — para estimar como ele vai se sair na boca da lixeira, que é mais difícil.
#
# Gera a pasta relatorio_teste\ com folhas de imagens dos erros encontrados.

import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

PASTA = Path(__file__).resolve().parent
MODELO = PASTA / "modelo_reciclaveis.pt"
DATA_YAML = PASTA / "dataset" / "data.yaml"
RELATORIO = PASTA / "relatorio_teste"

CONFIANCA = 0.50
CLASSES = {"garrafa_pet": 0, "copo_plastico": 1, "lata_aluminio": 2}
CORES = [(0, 200, 255), (255, 140, 0), (60, 60, 255)]


def ler(caminho):
    return cv2.imdecode(np.fromfile(str(caminho), dtype=np.uint8), cv2.IMREAD_COLOR)


def salvar_folha(itens, nome, colunas=4):
    """Monta uma folha de miniaturas com as detecções desenhadas."""
    if not itens:
        return
    tiles = []
    for img, boxes, legenda in itens[:24]:
        vis = img.copy()
        for classe, conf, (x1, y1, x2, y2) in boxes:
            cv2.rectangle(vis, (x1, y1), (x2, y2), CORES[classe], 4)
            cv2.putText(vis, f"{list(CLASSES)[classe]} {conf*100:.0f}%", (x1, max(30, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, CORES[classe], 3)
        t = cv2.resize(vis, (400, 225))
        cv2.rectangle(t, (0, 198), (400, 225), (0, 0, 0), -1)
        cv2.putText(t, legenda[:52], (4, 217), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 255), 1)
        tiles.append(t)
    while len(tiles) % colunas:
        tiles.append(np.zeros((225, 400, 3), np.uint8))
    folha = np.vstack([np.hstack(tiles[i:i + colunas]) for i in range(0, len(tiles), colunas)])
    RELATORIO.mkdir(exist_ok=True)
    cv2.imencode(".jpg", folha, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tofile(str(RELATORIO / nome))
    print(f"    folha salva: relatorio_teste\\{nome}")


def detectar(modelo, img, conf=CONFIANCA):
    r = modelo.predict(img, conf=conf, imgsz=640, device="cpu", verbose=False)[0]
    return [(int(b.cls), float(b.conf), tuple(int(v) for v in b.xyxy[0])) for b in r.boxes]


# ---------- Transformações que imitam a boca da lixeira ----------
def escurecer(img, fator=0.45):
    return cv2.convertScaleAbs(img, alpha=fator, beta=0)


def borrar(img, k=15):
    return cv2.GaussianBlur(img, (k, k), 0)


def afastar(img, escala=0.45):
    """Objeto menor: encolhe a foto e coloca num fundo cinza do tamanho original."""
    h, w = img.shape[:2]
    pequena = cv2.resize(img, (int(w * escala), int(h * escala)))
    fundo = np.full((h, w, 3), 60, np.uint8)
    y, x = (h - pequena.shape[0]) // 2, (w - pequena.shape[1]) // 2
    fundo[y:y + pequena.shape[0], x:x + pequena.shape[1]] = pequena
    return fundo


ESTRESSES = [
    ("menos luz (45%)", escurecer),
    ("movimento borrado", borrar),
    ("objeto pequeno/distante", afastar),
    ("borrado + escuro", lambda i: borrar(escurecer(i, 0.55), 11)),
]


def main():
    if not MODELO.exists():
        print(f"ERRO: {MODELO.name} não encontrado. Rode antes: python treinar.py")
        return
    modelo = YOLO(str(MODELO))
    print(f"Modelo: {MODELO.name}   classes: {modelo.names}\n")

    # ---------- 1) Métricas oficiais na validação ----------
    print("=" * 70)
    print("1) MÉTRICAS NA VALIDAÇÃO (44 fotos separadas no dataset)")
    print("=" * 70)
    if DATA_YAML.exists():
        m = modelo.val(data=str(DATA_YAML), imgsz=640, device="cpu", verbose=False, plots=False)
        print(f"{'classe':16s} {'precisão':>9s} {'revocação':>10s} {'mAP50':>7s} {'mAP50-95':>9s}")
        for i, nome in enumerate(modelo.names.values()):
            p, r, ap50, ap = m.box.class_result(i)
            print(f"{nome:16s} {p:9.3f} {r:10.3f} {ap50:7.3f} {ap:9.3f}")
        print(f"{'GERAL':16s} {m.box.mp:9.3f} {m.box.mr:10.3f} {m.box.map50:7.3f} {m.box.map:9.3f}")
    else:
        print("dataset/data.yaml não encontrado; pulando.")

    # ---------- 2) Fotos nunca vistas ----------
    print("\n" + "=" * 70)
    print("2) FOTOS QUE O MODELO NUNCA VIU (fotos_repetidas) + FALSOS POSITIVOS")
    print("=" * 70)
    erros = []
    total = acertos = 0
    for cat, cid in CLASSES.items():
        pasta = PASTA / "fotos_repetidas" / cat
        if not pasta.exists():
            continue
        fotos = sorted(pasta.glob("*.jpg"))
        ok = ec = na = 0
        for f in fotos:
            img = ler(f)
            boxes = detectar(modelo, img)
            classes = [b[0] for b in boxes]
            total += 1
            if not classes:
                na += 1
                erros.append((img, boxes, f"{cat}: nao detectou nada"))
            elif cid in classes:
                ok += 1
                acertos += 1
            else:
                ec += 1
                erros.append((img, boxes, f"{cat}: classificou como {list(CLASSES)[classes[0]]}"))
        print(f"  {cat:15s} {len(fotos):3d} fotos | acertou {ok:3d} | classe errada {ec:2d} | nao detectou {na:2d}")
    if total:
        print(f"  {'TOTAL':15s} {total:3d} fotos | acertou {acertos:3d} ({100*acertos/total:.0f}%)")

    fundos = sorted((PASTA / "fotos" / "fundo_vazio").glob("*.jpg")) + \
             sorted((PASTA / "fotos_repetidas" / "fundo_vazio").glob("*.jpg"))
    falsos = 0
    for f in fundos:
        img = ler(f)
        boxes = detectar(modelo, img)
        if boxes:
            falsos += 1
            erros.append((img, boxes, "FALSO POSITIVO em foto sem objeto"))
    if fundos:
        print(f"  Fundos sem objeto: {len(fundos)} fotos | deteccoes falsas: {falsos} "
              f"({100*falsos/len(fundos):.0f}%)")
    salvar_folha(erros, "erros_fotos_novas.jpg")

    # ---------- 3) Teste de estresse ----------
    print("\n" + "=" * 70)
    print("3) TESTE DE ESTRESSE — condicoes parecidas com a boca da lixeira")
    print("=" * 70)
    amostra = []
    for cat, cid in CLASSES.items():
        pasta = PASTA / "fotos_repetidas" / cat
        if pasta.exists():
            amostra += [(f, cid, cat) for f in sorted(pasta.glob("*.jpg"))[:10]]
    if not amostra:
        print("  sem fotos para o teste de estresse")
    else:
        print(f"  {len(amostra)} fotos, cada uma testada em 5 condicoes:\n")
        print(f"  {'condicao':26s} {'acertou':>8s} {'% acerto':>9s} {'conf. media':>12s}")
        falhas_estresse = []
        for nome, transformar in [("original", lambda i: i)] + ESTRESSES:
            ok = 0
            confs = []
            for f, cid, cat in amostra:
                img = transformar(ler(f))
                boxes = detectar(modelo, img)
                if any(b[0] == cid for b in boxes):
                    ok += 1
                    confs += [b[1] for b in boxes if b[0] == cid]
                elif nome != "original":
                    falhas_estresse.append((img, boxes, f"{nome}: {cat} nao reconhecido"))
            media = f"{100*np.mean(confs):.0f}%" if confs else "-"
            print(f"  {nome:26s} {ok:4d}/{len(amostra):<3d} {100*ok/len(amostra):8.0f}% {media:>12s}")
        salvar_folha(falhas_estresse, "falhas_estresse.jpg")

    print("\n" + "=" * 70)
    print("COMO MELHORAR: colete fotos novas justamente nas condicoes que falharam acima")
    print("  python coletar_fotos.py  ->  python separar_repetidas.py  ->  python pre_anotar.py")
    print("  -> revisar anotacoes -> python organizar_dataset.py -> python treinar.py")
    print("=" * 70)


if __name__ == "__main__":
    main()
