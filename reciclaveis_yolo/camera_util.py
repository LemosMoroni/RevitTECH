# camera_util.py
# Função compartilhada para abrir a webcam no Windows.
#
# Por que isto existe: no Windows, uma câmera pode "abrir" (isOpened() = True) e mesmo assim
# não entregar nenhuma imagem — é o que acontece quando outro programa já está usando a webcam,
# ou quando o índice aponta para uma câmera virtual. Por isso aqui a gente só considera a câmera
# válida depois de CONSEGUIR LER um quadro de verdade.

import cv2

BACKENDS = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF), ("padrao", 0)]


def _tentar(indice, backend, largura, altura):
    """Abre e tenta ler alguns quadros. Devolve a câmera se funcionar, senão None."""
    cam = cv2.VideoCapture(indice, backend) if backend else cv2.VideoCapture(indice)
    if cam.isOpened():
        if largura:
            cam.set(cv2.CAP_PROP_FRAME_WIDTH, largura)
            cam.set(cv2.CAP_PROP_FRAME_HEIGHT, altura)
        for _ in range(8):            # algumas câmeras demoram a entregar o 1º quadro
            ok, quadro = cam.read()
            if ok and quadro is not None:
                return cam
    cam.release()
    return None


def abrir_camera(indice_preferido=0, largura=1280, altura=720, max_indices=4, silencioso=False):
    """Procura uma câmera que realmente entregue imagem.

    Tenta primeiro o índice pedido (com cada backend) e, se falhar, os outros índices.
    Devolve (camera, indice, backend) ou (None, None, None) se nenhuma funcionar.
    """
    indices = [indice_preferido] + [i for i in range(max_indices) if i != indice_preferido]
    for indice in indices:
        for nome, backend in BACKENDS:
            cam = _tentar(indice, backend, largura, altura)
            if cam is not None:
                if not silencioso and indice != indice_preferido:
                    print(f"AVISO: a camera {indice_preferido} nao entregou imagem; usando a camera {indice}.")
                return cam, indice, nome
    return None, None, None


def explicar_falha(indice_preferido):
    """Mensagem de ajuda quando nenhuma câmera funciona."""
    return (
        f"ERRO: nenhuma camera entregou imagem (tentei os indices 0 a 3).\n"
        f"  1) Feche TUDO que usa a webcam: a aba da estacao da lixeira (lixeira.html) no\n"
        f"     navegador, Teams, Zoom, Meet, o app Camera do Windows.\n"
        f"     No Windows, normalmente so um programa por vez usa a webcam.\n"
        f"  2) Confira a permissao: Configuracoes > Privacidade e seguranca > Camera >\n"
        f"     'Permitir que aplicativos da area de trabalho acessem a camera'.\n"
        f"  3) Se for webcam USB, desconecte e conecte de novo.\n"
        f"  4) Para forcar um indice especifico, mude INDICE_CAMERA no topo do arquivo."
    )
