# reconhecer.py
# Etapa 8: abre a webcam e reconhece garrafa PET, copo plástico e lata de alumínio em tempo real.
#
# Teclas:  Q = sair    + / - = aumentar / diminuir o limiar de confiança

import time
from pathlib import Path

import cv2
from ultralytics import YOLO

from camera_util import abrir_camera, explicar_falha

PASTA = Path(__file__).resolve().parent
MODELO = PASTA / "modelo_reciclaveis.pt"   # criado pelo treinar.py (cópia do best.pt)

# ---------- Configurações (pode mudar aqui) ----------
INDICE_CAMERA = 0      # troque para 1, 2... se a webcam estiver em outro índice
LARGURA = 1280
ALTURA = 720
CONFIANCA = 0.50       # só mostra detecções com confiança >= 50% (ajuste com + e -)
ESPELHAR = True        # mostra como espelho (o modelo recebe a imagem normal)
NOME_JANELA = "Reconhecimento de Reciclaveis - Q para sair"

# cor (B, G, R) de cada classe
CORES = {"garrafa_pet": (0, 200, 255), "copo_plastico": (255, 140, 0), "lata_aluminio": (60, 60, 255)}


def achar_modelo():
    """Usa o modelo_reciclaveis.pt; se não existir, o best.pt mais recente em runs\\."""
    if MODELO.exists():
        return MODELO
    candidatos = sorted(PASTA.glob("runs/*/weights/best.pt"), key=lambda p: p.stat().st_mtime)
    return candidatos[-1] if candidatos else None


def main():
    caminho = achar_modelo()
    if caminho is None:
        print("ERRO: modelo treinado não encontrado. Rode antes: python treinar.py")
        return
    print(f"Carregando o modelo: {caminho}")
    modelo = YOLO(str(caminho))
    nomes = modelo.names   # {0: 'garrafa_pet', 1: 'copo_plastico', 2: 'lata_aluminio'}
    print(f"Classes: {nomes}")

    camera, indice, backend = abrir_camera(INDICE_CAMERA, LARGURA, ALTURA)
    if camera is None:
        print(explicar_falha(INDICE_CAMERA))
        return
    largura = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))
    altura = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"Câmera {indice} ({backend}) aberta: {largura}x{altura}")
    print("Clique na janela e use Q para sair, + e - para ajustar a confiança.")

    confianca = CONFIANCA
    fps = 0.0
    anterior = time.time()
    falhas_seguidas = 0

    while True:
        ok, quadro = camera.read()
        if not ok:
            falhas_seguidas += 1
            if falhas_seguidas >= 30:       # ~1 segundo sem imagem
                print("ERRO: a câmera parou de enviar imagens "
                      "(outro programa pode ter assumido a webcam).")
                break
            continue
        falhas_seguidas = 0

        # O modelo analisa o quadro original (sem espelhar)
        resultado = modelo.predict(quadro, conf=confianca, imgsz=640, device="cpu", verbose=False)[0]

        tela = cv2.flip(quadro, 1) if ESPELHAR else quadro.copy()
        largura_tela = tela.shape[1]
        contagem = {}

        for caixa in resultado.boxes:
            classe = nomes[int(caixa.cls)]
            conf = float(caixa.conf)
            x1, y1, x2, y2 = (int(v) for v in caixa.xyxy[0])
            if ESPELHAR:   # espelha também as coordenadas da caixa
                x1, x2 = largura_tela - x2, largura_tela - x1
            cor = CORES.get(classe, (0, 255, 0))
            contagem[classe] = contagem.get(classe, 0) + 1

            cv2.rectangle(tela, (x1, y1), (x2, y2), cor, 3)
            texto = f"{classe} {conf * 100:.0f}%"
            (tw, th), _ = cv2.getTextSize(texto, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
            y_texto = max(th + 10, y1)
            cv2.rectangle(tela, (x1, y_texto - th - 10), (x1 + tw + 10, y_texto), cor, -1)
            cv2.putText(tela, texto, (x1 + 5, y_texto - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)

        agora = time.time()
        fps = 0.9 * fps + 0.1 * (1.0 / max(agora - anterior, 1e-6))
        anterior = agora

        # Painel de informações
        resumo = "  ".join(f"{k}: {v}" for k, v in sorted(contagem.items())) or "nenhum objeto"
        cv2.rectangle(tela, (0, 0), (largura_tela, 40), (0, 0, 0), -1)
        cv2.putText(tela, f"{fps:.0f} FPS | confianca >= {confianca * 100:.0f}% (+/-) | {resumo}",
                    (10, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)

        cv2.imshow(NOME_JANELA, tela)
        tecla = cv2.waitKey(1) & 0xFF
        if tecla in (ord("q"), ord("Q")):
            break
        if tecla in (ord("+"), ord("=")):
            confianca = min(0.95, confianca + 0.05)
        if tecla in (ord("-"), ord("_")):
            confianca = max(0.05, confianca - 0.05)
        if cv2.getWindowProperty(NOME_JANELA, cv2.WND_PROP_VISIBLE) < 1:
            break

    camera.release()
    cv2.destroyAllWindows()
    print("Programa encerrado.")


if __name__ == "__main__":
    main()
