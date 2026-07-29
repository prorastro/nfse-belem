# NFS-e Belém — Microserviço de assinatura + emissão (padrão Nacional / ADN)

Assina a DPS com o certificado A1, comprime (gzip+base64), envia via **mTLS** ao
ADN de Belém e devolve a NFS-e. O **n8n** só orquestra e nunca vê o certificado.

## Endpoint da prefeitura (homologação)
`POST https://homol-nfse2.belem.pa.gov.br/notafiscal-adn-ws/api/adn/dps`
Body: `{ "dpsXmlGZipB64": "<DPS assinada, gzip, base64>" }`
Resposta 201: `{ chaveAcesso, nfseXmlGZipB64, ... }`

## Rotas do microserviço
| Rota | O que faz |
|------|-----------|
| `GET /health` | status do processo + do certificado (usado no healthcheck) |
| `POST /emitir-nota` | recebe dados da cobrança, monta+assina+envia. **É a que o n8n chama.** |
| `POST /emitir` | recebe `{dpsXml, refId}` já montado (uso avançado) |
| `POST /reload-cert` | recarrega o .pfx sem reiniciar o container |

Body do `/emitir-nota`:
```json
{ "nDPS": 1, "vServ": 99.90, "tpAmb": 2,
  "tomador": { "cpf": "11122233344", "xNome": "Cliente", "email": "c@x.com" } }
```
Header: `x-token: <NFSE_SIGNER_TOKEN>`

## Robustez ("não trava")
- Sobe **mesmo sem certificado** (rotas de emissão respondem `503`, `/health` mostra o erro) → sem crash-loop.
- **Timeout** de 60s na chamada à prefeitura (`ADN_TIMEOUT_MS`) → não fica pendurado.
- Handlers globais de erro → exceção não derruba o processo.
- `HEALTHCHECK` no Docker → EasyPanel reinicia se travar.
- Trocou o .pfx? `POST /reload-cert` recarrega sem downtime.

---

## Deploy no EasyPanel

Você tem duas formas. A mais simples é **App via Dockerfile**.

### Opção A — App (Dockerfile) [recomendada]
1. Suba esta pasta para um repositório Git (GitHub/GitLab) **sem** o `.pfx` e sem `.env`.
2. No EasyPanel: **Create → App → Source = GitHub** (aponte para o repo).
3. **Build**: EasyPanel detecta o `Dockerfile` automaticamente.
4. **Environment** (aba Environment):
   ```
   PFX_PATH=/cert/prorastro.pfx
   PFX_PASS=senha-do-certificado
   API_TOKEN=um-token-forte
   ADN_URL=https://homol-nfse2.belem.pa.gov.br/notafiscal-adn-ws/api/adn/dps
   TZ=America/Belem
   ```
5. **Mounts / Volumes**: crie um mount de arquivo (ou volume) e envie o `prorastro.pfx`
   para dentro do container em `/cert/prorastro.pfx`.
   - No EasyPanel: **Mounts → Add File Mount**, path do container = `/cert/prorastro.pfx`,
     e cole/upload do conteúdo do certificado. (ou use um Volume e copie o arquivo via console).
6. **Port**: exponha a porta `3005` (Domains, se quiser acesso externo — não é obrigatório,
   o n8n acessa pela rede interna).
7. **Deploy**.

### Opção B — Compose
No EasyPanel: **Create → Compose**, cole o `docker-compose.yml`, defina as variáveis
`PFX_PASS` e `NFSE_SIGNER_TOKEN` em **Environment**, e garanta que o `./cert/prorastro.pfx`
exista no volume montado.

### Rede com o n8n
Se o n8n roda no **mesmo EasyPanel**, coloque os dois no mesmo projeto/rede e o n8n
acessa o serviço por `http://<nome-do-servico>:3005` (ex.: `http://nfse-signer:3005`).
Se estiver em outro host, exponha um domínio e use HTTPS.

---

## Teste rápido (após deploy)
```bash
# 1) saúde + status do certificado
curl https://SEU-SERVICO/health

# 2) primeira emissão em HOMOLOGAÇÃO
curl -X POST https://SEU-SERVICO/emitir-nota \
  -H "x-token: SEU_TOKEN" -H "Content-Type: application/json" \
  -d '{"nDPS":1,"vServ":1.00,"tpAmb":2,"tomador":{"cpf":"11122233344","xNome":"Teste Homologacao"}}'
```
A resposta traz `chaveAcesso` + `nfseXml` (sucesso) ou o motivo da rejeição (código `E0xxx`),
que é o que confirma na prática o `cTribNac`, o `serie` e o mTLS.

---

## Pendências antes de produção
1. **`cTribNac`**: mantido `010301` (LC116 1.03, o que o Asaas já emite). O correto para
   rastreamento é `110501` (11.05) — trocar quando a atividade 11.05 estiver no cadastro
   municipal (confirmar com contador). Ver `company.config.json`.
2. **`pTotTribSN`**: ajustar ao percentual efetivo do Simples Nacional (faixa RBT12).
3. Trocar `ADN_URL` para o endpoint de **produção** quando a homologação estiver ok.
4. **Idempotência**: no n8n, não emitir 2x para o mesmo `payment.id` do Asaas.
5. Guardar `chaveAcesso` + XML retornado (Google Sheet/DB).

## Arquivos
- `server.js` — microserviço (assinatura + mTLS)
- `dps-builder.js` — gerador da DPS (validado contra XSD v1.01, regras Simples Nacional)
- `company.config.json` — dados fiscais da PRORASTRO
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` — deploy
- `PRORASTRO - Emissao NFSe.json` — workflow n8n (importar no n8n)
- `spec/` — XSD oficial + ANEXO_I + exemplos de DPS (gerado e assinado)
