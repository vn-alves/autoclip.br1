# Layers editáveis na timeline e zoom sem redimensionamento

## Objetivo
Adicionar edição temporal direta das camadas sem alterar o visual ou os demais fluxos do editor.

## Implementação
- Fazer o comando “NEW LAYER +” abrir a escolha de vídeo e criar a camada selecionada na posição atual do playhead, com início e fim próprios.
- Tornar cada barra de camada arrastável para mover seu intervalo inteiro e adicionar alças nas extremidades para ajustar início e fim.
- Aplicar encaixe magnético ao início, centro e fim do vídeo, ao playhead e às bordas das outras camadas, com indicação visual discreta.
- Manter os campos numéricos do painel sincronizados com a timeline e preservar salvar, exportar, desfazer/refazer e visibilidade por `startTime`/`endTime`.
- Trocar o scroll sobre a prévia por zoom apenas da visualização, sem alterar posição, largura ou altura do vídeo.

## Validação
- Adicionar testes do cálculo temporal e do snapping.
- Confirmar no navegador criação, seleção, movimento, ajuste das duas extremidades e aparecimento somente no intervalo definido.
- Confirmar que o scroll aproxima/afasta a prévia sem modificar o tamanho persistido da camada.
- Verificar desktop, viewport menor e compilação final.

## Premissa
“NEW LAYER +” representa uma camada de vídeo, como no modelo atual; a camada é criada depois que o arquivo é escolhido.
