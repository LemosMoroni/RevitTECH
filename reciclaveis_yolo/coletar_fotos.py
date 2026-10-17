# coletar_fotos.py
# Etapa 3: tira e salva fotos dos recicláveis com a barra de espaço.
#
# Teclas:
#   1 = garrafa_pet   2 = copo_plastico   3 = lata_aluminio
#   4 = misturado (vários tipos na mesma foto)   0 = fundo_vazio (sem nenhum objeto)
#   ESPAÇO = salva a foto   Q = sai

import time
from datetime import datetime
from pathlib import Path

import cv2

from camera_util import abrir_camera, explicar_falha

# ---------- Configurações (pode mudar aqui) ----------
INDICE_CAMERA = 0          # troque para 1, 2... se a webcam estiver em outro índice (veja a Etapa 2)
LARGURA = 1280
ALTURA = 720
ESPELHAR_TELA = True       # espelha só o que aparece na tela; a foto é salva como a câmera vê
INTERVALO_MINIMO = 0.4     # segundos entre duas fotos (evita fotos repetidas sem querer)
PASTA_FOTOS = Path(__file__).resolve().parent / "fotos"
NOME_JANELA = "Coleta de fotos - ESPACO salva, Q sai"

CATEGORIAS = {
    "1": "garrafa_pet",
    "2": "copo_plastico",
    "3": "lata_aluminio",
    "4": "misturado",
    "0": "fundo_vazio",
}

VERDE = (0, 220, 0)
BRANCO = (255, 255, 255)
CINZA = (190, 190, 190)


def contar_fotos():
    """Quantas fotos já existem em cada categoria (para continuar de onde parou)."""
    return {nome: len(list((PASTA_FOTOS / nome).glob("*.jpg"))) for nome in CATEGORIAS.values()}


def salvar_foto(quadro, categoria):
    """Salva o quadro em fotos/<categoria>/<categoria>_<data>_<hora>.jpg."""
    pasta = PASTA_FOTOS / categoria
    pasta.mkdir(parents=True, exist_ok=True)
    carimbo = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]   # até milissegundos
    caminho = pasta / f"{categoria}_{carimbo}.jpg"
    # imencode + tofile funciona mesmo com acentos no caminho (cv2.imwrite pode falhar no Windows)
    ok, dados = cv2.imencode(".jpg", quadro, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise RuntimeError("não foi possível codificar a imagem")
    dados.tofile(str(caminho))
    return caminho


def desenhar_painel(tela, categoria, contagem):
    """Painel semitransparente à esquerda com a categoria atual e as contagens."""
    camada = tela.copy()
    cv2.rectangle(camada, (0, 0), (360, 250), (0, 0, 0), -1)
    cv2.addWeighted(camada, 0.6, tela, 0.4, 0, dst=tela)

    cv2.putText(tela, "CATEGORIA ATUAL:", (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, CINZA, 1)
    cv2.putText(tela, categoria.upper(), (15, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.85, VERDE, 2)

    y = 100
    for tecla, nome in CATEGORIAS.items():
        cor = VERDE if nome == categoria else BRANCO
        cv2.putText(tela, f"[{tecla}] {nome}", (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, cor, 1)
        cv2.putText(tela, str(contagem[nome]), (300, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, cor, 1)
        y += 26

    cv2.putText(tela, f"TOTAL: {sum(contagem.values())}", (15, y + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, BRANCO, 2)

    altura = tela.shape[0]
    cv2.rectangle(tela, (0, altura - 40), (tela.shape[1], altura), (0, 0, 0), -1)
    cv2.putText(tela, "ESPACO = tirar foto   |   1 2 3 4 0 = categoria   |   Q = sair",
                (15, altura - 13), cv2.FONT_HERSHEY_SIMPLEX, 0.6, BRANCO, 1)


def main():
    print(f"Procurando a câmera (preferência: índice {INDICE_CAMERA})...")
    camera, indice, backend = abrir_camera(INDICE_CAMERA, LARGURA, ALTURA)
    if camera is None:
        print(explicar_falha(INDICE_CAMERA))
        return

    print(f"Câmera {indice} ({backend}) aberta: "
          f"{int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))}")
    print(f"As fotos serão salvas em: {PASTA_FOTOS}")

    categoria = CATEGORIAS["1"]
    contagem = contar_fotos()
    ultima_foto = 0.0
    aviso = ""
    aviso_ate = 0.0
    falhas_seguidas = 0

    while True:
        ok, quadro = camera.read()
        if not ok:
            falhas_seguidas += 1
            if falhas_seguidas >= 30:
                print("ERRO: a câmera parou de enviar imagens.")
                break
            continue
        falhas_seguidas = 0

        # "tela" é só o que aparece na janela; "quadro" (sem textos) é o que vira foto
        tela = cv2.flip(quadro, 1) if ESPELHAR_TELA else quadro.copy()
        desenhar_painel(tela, categoria, contagem)

        if time.time() < aviso_ate:
            h, w = tela.shape[:2]
            cv2.rectangle(tela, (0, 0), (w - 1, h - 1), VERDE, 12)
            cv2.putText(tela, aviso, (w // 2 - 170, h // 2), cv2.FONT_HERSHEY_SIMPLEX, 1.3, VERDE, 3)

        cv2.imshow(NOME_JANELA, tela)
        tecla = cv2.waitKey(1) & 0xFF

        if tecla in (ord("q"), ord("Q")):
            break
        if tecla == 32:  # barra de espaço
            if time.time() - ultima_foto >= INTERVALO_MINIMO:
                caminho = salvar_foto(quadro, categoria)
                contagem[categoria] += 1
                ultima_foto = time.time()
                aviso = f"FOTO SALVA ({contagem[categoria]})"
                aviso_ate = time.time() + 0.4
                print(f"Salva: {caminho.relative_to(PASTA_FOTOS.parent)}")
        elif chr(tecla) in CATEGORIAS:
            categoria = CATEGORIAS[chr(tecla)]
            print(f"Categoria: {categoria}")

        if cv2.getWindowProperty(NOME_JANELA, cv2.WND_PROP_VISIBLE) < 1:
            break

    camera.release()
    cv2.destroyAllWindows()

    print("\nResumo da coleta:")
    for nome, n in contagem.items():
        print(f"  {nome:15s} {n:4d} fotos")
    print(f"  {'TOTAL':15s} {sum(contagem.values()):4d} fotos")


if __name__ == "__main__":
    main()
