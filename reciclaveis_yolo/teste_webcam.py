# teste_webcam.py
# Etapa 2: abre a webcam, mostra o vídeo em tempo real e fecha ao apertar Q.

import time
import cv2

from camera_util import abrir_camera, explicar_falha

# ---------- Configurações (pode mudar aqui) ----------
INDICE_CAMERA = 0      # 0 = primeira câmera (normalmente a do notebook). Use 1, 2... para outras.
LARGURA = 1280         # resolução pedida à câmera (ela usa a mais próxima que suportar)
ALTURA = 720
ESPELHAR = True        # True = imagem como espelho (mais natural para se ver na tela)
NOME_JANELA = "Teste da Webcam - aperte Q para sair"


def main():
    print(f"Procurando a câmera (preferência: índice {INDICE_CAMERA})...")
    camera, indice, backend = abrir_camera(INDICE_CAMERA, LARGURA, ALTURA)
    if camera is None:
        print(explicar_falha(INDICE_CAMERA))
        return

    largura = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))
    altura = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"Câmera {indice} ({backend}) aberta! Resolução: {largura}x{altura}")
    print("Clique na janela do vídeo e aperte Q para sair.")

    fps = 0.0
    anterior = time.time()
    falhas_seguidas = 0

    while True:
        ok, quadro = camera.read()          # lê um quadro (ok = deu certo?)
        if not ok:
            falhas_seguidas += 1
            if falhas_seguidas >= 30:       # ~1 segundo sem imagem
                print("ERRO: a câmera parou de enviar imagens (outro programa pode estar usando).")
                break
            continue
        falhas_seguidas = 0

        if ESPELHAR:
            quadro = cv2.flip(quadro, 1)    # 1 = espelha na horizontal

        # Quadros por segundo (média suavizada, para o número não ficar pulando)
        agora = time.time()
        fps = 0.9 * fps + 0.1 * (1.0 / max(agora - anterior, 1e-6))
        anterior = agora

        # Faixa preta com o texto (as fontes do OpenCV não têm acentos)
        texto = f"{quadro.shape[1]}x{quadro.shape[0]}  |  {fps:.0f} FPS  |  Q = sair"
        cv2.rectangle(quadro, (10, 10), (460, 50), (0, 0, 0), -1)
        cv2.putText(quadro, texto, (20, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

        cv2.imshow(NOME_JANELA, quadro)

        # Espera 1 ms por uma tecla. É isso que mantém a janela atualizando.
        tecla = cv2.waitKey(1) & 0xFF
        if tecla in (ord("q"), ord("Q")):
            break
        # Também encerra se a janela for fechada no X
        if cv2.getWindowProperty(NOME_JANELA, cv2.WND_PROP_VISIBLE) < 1:
            break

    camera.release()            # devolve a câmera para o Windows
    cv2.destroyAllWindows()     # fecha as janelas do OpenCV
    print("Câmera liberada. Programa encerrado.")


if __name__ == "__main__":
    main()
