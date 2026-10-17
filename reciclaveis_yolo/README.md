# Reconhecimento de Recicláveis com YOLO

Modelo de visão computacional treinado do zero para reconhecer **garrafa PET**, **copo plástico** e **lata de alumínio** pela webcam, em tempo real.

Faz parte do [RevitTech](../README.md). O site usa o COCO-SSD genérico, que **não conhece a classe "lata"**; este modelo foi treinado justamente para resolver isso.

## Resultados

Treinado com **209 fotos** (165 treino / 44 validação) em **15 minutos de CPU** (i5-13450HX), sem GPU.

| Classe | Precisão | Revocação | mAP50 | mAP50-95 |
|---|---|---|---|---|
| garrafa_pet | 0,996 | 1,000 | 0,995 | 0,921 |
| copo_plastico | 0,981 | 1,000 | 0,995 | 0,948 |
| lata_aluminio | 0,984 | 1,000 | 0,995 | 0,882 |
| **Geral** | **0,987** | **1,000** | **0,995** | **0,917** |

**Em 46 fotos que não entraram no treino: 93% de acerto** (43/46), com **zero falsos positivos** em 35 fotos de fundo vazio.

Teste de estresse, simulando a boca da lixeira:

| Condição | Acerto |
|---|---|
| original | 96% |
| menos luz (45%) | 96% |
| movimento borrado | 100% |
| objeto pequeno/distante | 100% |
| borrado + escuro | 92% |

Velocidade: **~15 ms por imagem** na CPU.

> **Leia com cuidado:** todas as fotos vêm de um único cenário (um coworking claro) e de poucos objetos — 3 garrafas, 1 copo e 1 lata. O modelo aprendeu bem *essas* condições. Em outro ambiente, com outros objetos, o desempenho deve ser menor. Os números acima **não** são garantia de uso em produção.

## Como usar

**Requisitos:** Python 3.12, webcam, Windows (os scripts usam os backends de vídeo do Windows).

```bash
cd reciclaveis_yolo
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -U ultralytics opencv-python
python verificar_ambiente.py     # confere a instalação
```

O modelo treinado (`modelo_reciclaveis.pt`, 5 MB) **não está no repositório**, assim como os demais arquivos `.pt`. Treine o seu com `python treinar.py` — leva uns 15 minutos.

```bash
python reconhecer.py     # reconhecimento ao vivo pela webcam (Q sai, + e - ajustam a confiança)
```

## Os programas

| Arquivo | O que faz |
|---|---|
| `verificar_ambiente.py` | Confere Python, PyTorch, OpenCV e Ultralytics |
| `teste_webcam.py` | Mostra o vídeo da webcam (teste básico) |
| `coletar_fotos.py` | Tira e organiza fotos por categoria (espaço = foto, 1/2/3/4/0 = categoria) |
| `separar_repetidas.py` | Move fotos quase idênticas para `fotos_repetidas\` |
| `pre_anotar.py` | Pré-anota as fotos com o YOLO26x, para só revisar depois |
| `organizar_dataset.py` | Monta `dataset\` com a divisão treino/validação e o `data.yaml` |
| `treinar.py` | Treina o YOLO26n (30 épocas, 640 px, batch 2, CPU) |
| `reconhecer.py` | Reconhecimento ao vivo pela webcam |
| `testar.py` | Avalia o modelo e gera folhas de imagens com os erros |
| `camera_util.py` | Abre a webcam procurando um índice que realmente entregue imagem |

## O ciclo para melhorar o modelo

```
coletar_fotos.py → separar_repetidas.py → pre_anotar.py → (revisar as anotações)
→ organizar_dataset.py → treinar.py → testar.py
```

O `pre_anotar.py` nunca sobrescreve uma anotação existente, então só as fotos novas são pré-anotadas.

## Decisões técnicas

- **Divisão treino/validação por blocos de tempo.** Fotos tiradas em sequência são quase iguais. Se uma cai no treino e a "irmã" na validação, a nota fica inflada. O `organizar_dataset.py` mantém fotos vizinhas no mesmo grupo e confere, no fim, se sobrou alguma quase idêntica nos dois lados.
- **Anotação assistida.** O YOLO26x (modelo grande, usado só para anotar) encontra *onde* está o objeto; a pasta da foto diz *qual* é a classe. Isso transformou ~2 horas de marcação manual numa revisão de ~30 minutos. O treino usa o YOLO26n, que é leve.
- **Fotos de fundo vazio** (sem nenhum objeto, com `.txt` vazio) ensinam o modelo a não inventar detecções. Foram 29 no dataset, e o resultado foi zero falsos positivos no teste.
- **Abertura robusta da webcam.** No Windows, uma câmera pode "abrir" e não entregar imagem — quando outro programa já a está usando, por exemplo. O `camera_util.py` só aceita a câmera depois de conseguir ler um quadro de verdade.

## Estrutura

```
reciclaveis_yolo/
├── fotos/                  fotos organizadas por categoria
│   ├── garrafa_pet/  copo_plastico/  lata_aluminio/  fundo_vazio/
├── fotos_repetidas/        quase idênticas, separadas (viraram conjunto de teste)
├── anotacoes/              os .txt no formato YOLO + classes.txt
├── dataset/                gerado pelo organizar_dataset.py (fora do repositório)
├── runs/                   resultados do treino (fora do repositório)
├── classes.txt             garrafa_pet, copo_plastico, lata_aluminio
└── *.py
```

As classes e seus IDs (`0: garrafa_pet`, `1: copo_plastico`, `2: lata_aluminio`) precisam bater entre `classes.txt`, os `.txt` de anotação e o `data.yaml`.

## Próximos passos

- Coletar fotos **na boca da lixeira**, com outros copos e latas, e retreinar.
- Exportar para **TensorFlow.js** e usar na estação da lixeira do RevitTech, no lugar do COCO-SSD.
- Contagem automática por classe e integração com ESP32 para separação física.
