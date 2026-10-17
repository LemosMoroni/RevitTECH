# organizar_dataset.py
# Etapa 5: monta o dataset no formato do YOLO, separando ~80% treino e ~20% validação.
#
# Fotos tiradas em sequência são quase iguais. Se uma fica no treino e a "irmã" na validação,
# a validação vira "cola" e a nota do modelo engana. Por isso a divisão é feita em BLOCOS DE
# TEMPO: fotos vizinhas ficam no mesmo grupo, e vizinhas muito parecidas na fronteira de um
# bloco de validação vão junto com ele.
#
# Entradas:  fotos_para_anotar\*.jpg + anotacoes\*.txt   (fotos com objetos)
#            fotos\fundo_vazio\*.jpg                       (fotos sem objetos)
# Saída:     dataset\images\{train,val}  dataset\labels\{train,val}  dataset\data.yaml
#            (a pasta dataset\ é recriada do zero a cada execução)

import shutil
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

PASTA = Path(__file__).resolve().parent
FOTOS_OBJETOS = PASTA / "fotos_para_anotar"
ANOTACOES = PASTA / "anotacoes"
FOTOS_FUNDO = PASTA / "fotos" / "fundo_vazio"
DATASET = PASTA / "dataset"

CLASSES = ["garrafa_pet", "copo_plastico", "lata_aluminio"]   # mesma ordem do classes.txt
FRACAO_VAL = 0.20
TAMANHO_BLOCO = 5          # fotos seguidas que ficam sempre juntas
LIMIAR_VIZINHA = 25        # diferença (de 240) abaixo da qual a vizinha da fronteira vai junto


def ler(caminho):
    return cv2.imdecode(np.fromfile(str(caminho), dtype=np.uint8), cv2.IMREAD_COLOR)


def assinatura(caminho):
    img = cv2.resize(cv2.cvtColor(ler(caminho), cv2.COLOR_BGR2GRAY), (17, 16), interpolation=cv2.INTER_AREA)
    return (img[:, 1:] > img[:, :-1]).flatten()


def categoria_e_hora(caminho):
    """garrafa_pet_20261017_131642_059.jpg → ('garrafa_pet', datetime)."""
    cat, data, hora, ms = caminho.stem.rsplit("_", 3)
    return cat, datetime.strptime(f"{data}{hora}{ms}", "%Y%m%d%H%M%S%f")


def dividir(fotos):
    """Divide uma categoria (ordenada no tempo) em treino/val por blocos espalhados na sessão."""
    blocos = [fotos[i:i + TAMANHO_BLOCO] for i in range(0, len(fotos), TAMANHO_BLOCO)]
    n_val = max(1, round(len(fotos) * FRACAO_VAL / TAMANHO_BLOCO))
    # blocos de validação espalhados ao longo da sessão (luz e cenário mudam com o tempo)
    escolhidos = {int(round((k + 0.5) * len(blocos) / n_val - 0.5)) for k in range(n_val)}
    val = set()
    for b in escolhidos:
        val.update(blocos[b])
    # vizinha da fronteira muito parecida com a primeira/última foto do bloco de validação vai junto
    hashes = {f: assinatura(f) for f in fotos}
    for b in escolhidos:
        bloco = blocos[b]
        i0, i1 = fotos.index(bloco[0]), fotos.index(bloco[-1])
        for viz, ref in ((i0 - 1, bloco[0]), (i1 + 1, bloco[-1])):
            if 0 <= viz < len(fotos) and fotos[viz] not in val:
                if int((hashes[fotos[viz]] != hashes[ref]).sum()) <= LIMIAR_VIZINHA:
                    val.add(fotos[viz])
    treino = [f for f in fotos if f not in val]
    return treino, sorted(val), hashes


def copiar(foto, rotulo_origem, divisao):
    shutil.copy2(foto, DATASET / "images" / divisao / foto.name)
    destino = DATASET / "labels" / divisao / f"{foto.stem}.txt"
    if rotulo_origem is not None and rotulo_origem.exists():
        shutil.copy2(rotulo_origem, destino)
    else:
        destino.write_text("", encoding="utf-8")   # sem objetos = exemplo de fundo


def main():
    if DATASET.exists():
        shutil.rmtree(DATASET)
    for d in ("images/train", "images/val", "labels/train", "labels/val"):
        (DATASET / d).mkdir(parents=True)

    # agrupa por categoria, em ordem de tempo
    grupos = {}
    for f in FOTOS_OBJETOS.glob("*.jpg"):
        if not (ANOTACOES / f"{f.stem}.txt").exists():
            print(f"AVISO: {f.name} não tem anotação e ficou de fora.")
            continue
        grupos.setdefault(categoria_e_hora(f)[0], []).append(f)
    grupos["fundo_vazio"] = list(FOTOS_FUNDO.glob("*.jpg")) if FOTOS_FUNDO.exists() else []

    contagem = {"train": [0, 0, 0], "val": [0, 0, 0]}
    imagens = {"train": 0, "val": 0}
    vazamento = []
    print(f"{'categoria':15s} {'treino':>6s} {'val':>5s}  ({'% val'})")
    for cat, fotos in sorted(grupos.items()):
        if not fotos:
            continue
        fotos.sort(key=lambda f: categoria_e_hora(f)[1])
        treino, val, hashes = dividir(fotos)
        for divisao, lista in (("train", treino), ("val", val)):
            for f in lista:
                rotulo = None if cat == "fundo_vazio" else ANOTACOES / f"{f.stem}.txt"
                copiar(f, rotulo, divisao)
                imagens[divisao] += 1
                if rotulo is not None:
                    for linha in rotulo.read_text(encoding="utf-8").split("\n"):
                        if linha.strip():
                            contagem[divisao][int(linha.split()[0])] += 1
        # conferência: foto da validação quase idêntica a alguma do treino?
        for v in val:
            dist = min((int((hashes[v] != hashes[t]).sum()) for t in treino), default=999)
            if dist <= 12:
                vazamento.append(f"{v.name} (diferença {dist})")
        print(f"{cat:15s} {len(treino):6d} {len(val):5d}  ({100 * len(val) / len(fotos):.0f}%)")

    caminho = DATASET.as_posix()
    yaml = (
        "# data.yaml — Reconhecimento de Recicláveis (RevitTech)\n"
        "# Os IDs abaixo precisam bater com o 1º número de cada linha dos .txt de anotação.\n"
        f'path: "{caminho}"\n'
        "train: images/train\n"
        "val: images/val\n"
        "\n"
        "names:\n" + "".join(f"  {i}: {nome}\n" for i, nome in enumerate(CLASSES))
    )
    (DATASET / "data.yaml").write_text(yaml, encoding="utf-8")

    print(f"\nImagens: treino={imagens['train']}  validação={imagens['val']}  "
          f"({100 * imagens['val'] / (imagens['train'] + imagens['val']):.0f}% val)")
    for i, nome in enumerate(CLASSES):
        print(f"  {nome:15s} caixas no treino={contagem['train'][i]:3d}  na validação={contagem['val'][i]:3d}")
    print(f"Fotos da validação quase idênticas a fotos do treino: {len(vazamento)}")
    for v in vazamento:
        print(f"  - {v}")
    print(f"\nDataset pronto em: {DATASET}")
    print(f"Arquivo de configuração: {DATASET / 'data.yaml'}")


if __name__ == "__main__":
    main()
