# Bot WhatsApp + Supabase (WAHA)

## 1) Criar tabela/função no Supabase
Rode o SQL de [supabase/schema.sql](c:\Users\Projetos\Desktop\chatbot\supabase\schema.sql) no SQL Editor do Supabase.

## 2) Configurar variaveis
Copie `.env.example` para `.env` e preencha:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WAHA_BASE_URL`
- `WAHA_API_KEY` (se estiver ativo)
- `WAHA_SESSION`

## 3) Sincronizar Supabase (sempre atualizado da API)
```powershell
npm run sync
```

Por padrao, o historico de setores sincroniza de `2026-01-01` ate hoje. Para trocar o periodo:
```powershell
$env:SYNC_DATA_INICIAL="2026-05-01"
$env:SYNC_DATA_FINAL="2026-06-02"
npm run sync
```

Tabelas criadas no schema `chatbot`:
- `volumes_diarios`: historico por tipo de volume (`projetado`, `fabricado`, `acabado`, `expedido`, `montado`).
- `setores_diarios`: historico diario de `programado` e `realizado` por setor.

RPCs usadas pelo bot:
- `get_volume_geral_periodo(data_inicial, data_final)`.
- `get_programado_realizado_periodo(data_inicial, data_final, setor)`.

## 4) Atualizacao automatica a cada 5 minutos (Windows)
Executar uma vez para instalar a tarefa agendada:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-sync-task.ps1
```

Para remover a tarefa:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\remove-sync-task.ps1
```

Nome da tarefa criada: `SyncSupabaseVolumes`

## 5) Rodar bot webhook
```powershell
node waha-bot.js
```

Webhook do bot: `POST http://SEU_SERVIDOR:8787/webhook/waha`
Healthcheck: `GET http://SEU_SERVIDOR:8787/health`

## 6) Deixar o bot rodando 24h (Windows)

### Opcao recomendada: rodar mesmo sem usuario logado
Abra o PowerShell como Administrador e execute:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-bot-system-task.ps1
```

Nome da tarefa criada: `ChatbotWhatsApp24h`.

Essa opcao cria a tarefa como `SYSTEM` e inicia o bot no boot do Windows, sem depender de login do usuario.

Conferir se esta online:
```powershell
Invoke-WebRequest http://localhost:8787/health -UseBasicParsing
```

Logs do bot:
```powershell
Get-Content .\logs\bot.log -Tail 80
```

Para remover/parar:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\remove-bot-task.ps1
```

### Alternativa: iniciar somente no login do usuario
Instale uma tarefa agendada para iniciar o bot automaticamente no login:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-bot-task.ps1
```

Se o Windows negar permissao para criar tarefa agendada, o instalador cria automaticamente um fallback na pasta Inicializar do usuario:
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ChatbotWhatsApp24h.cmd`

## 7) Configurar WAHA
Instalacao WAHA (Docker):
- Doc oficial: https://waha.devlike.pro/docs/how-to/install/
- Exemplo base:
```yaml
services:
  waha:
    image: devlikeapro/waha
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - ./.sessions:/app/.sessions
```

Depois de parear o numero (QR Code), configure a sessao com webhook `message` para a URL do bot.
Doc de recebimento/webhook:
- https://waha.devlike.pro/docs/how-to/receive-messages/

## Exemplo de pergunta no WhatsApp
`@bot qual foi o volume fabricado no dia 20 de marco de 2026`

Outros exemplos:
- `@bot programado vs realizado hoje`
- `@bot volume geral do dia 02/06/2026`
- `@bot resumo de junho de 2026`
- `@bot resumo da ultima segunda`
- `@bot resumo da ultima semana`
- `@bot qual foi o volume produzido nesta semana`
- `@bot qual foi o volume montado nesta semana`
- `@bot qual foi o volume qualidade neste mes`
- `@bot resumo do ultimo mes`
- `@bot resumo de março de 2026`

Fluxo conversacional:
1. Usuario envia `@bot`.
2. Bot responde `Qual a data que deseja consultar?`.
3. Usuario responde com `29/05`, `hoje`, `ontem`, `ultima sexta` ou `junho de 2026`.
4. Bot envia a data consultada, `Programado vs Realizado` e `Volume geral` para o periodo informado.
