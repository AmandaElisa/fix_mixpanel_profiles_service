# Mixpanel Profile Fixer (Mongo → Mixpanel)

Sincroniza propriedades de **User Profile** no Mixpanel a partir do MongoDB.  
Ele:

1. Roda um **JQL** no Mixpanel para achar perfis que estão **faltando** (ou com valores “vazios”) em **qualquer** destes campos:  
   `status`, `plan`, `endDate`, `toleranceEndDate`, `recurrence`.
2. Lê do MongoDB (coleção `users`) usando a propriedade do Mixpanel **“Store Id (aid)”** como chave: busca por **`aid` ou `sourceId`** (case sensitive).
3. Monta o payload e atualiza no Mixpanel via **`profile-batch-update`** (rápido e estável).
4. Normaliza datas para **ISO-8601 UTC** e sobrescreve valores “vazios” como `"undefined"`, `""`, `"null"`, `"nan"`, `"none"`, `"n/a"`, `"-"`.
5. (Opcional) Atualiza **também** quando o valor do Mongo é **diferente** do que já está no Mixpanel.

> Idempotente e seguro para rodar em lotes (por exemplo, 50k perfis/execução).

---

## Tabela de Conteúdo

- [Arquitetura](#arquitetura)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Configuração (.env)](#configuração-env)
- [Como rodar](#como-rodar)
- [Logs e Auditoria](#logs-e-auditoria)
- [Mapeamento de Campos](#mapeamento-de-campos)
- [Desempenho e Boas Práticas](#desempenho-e-boas-práticas)
- [Erros comuns / Troubleshooting](#erros-comuns--troubleshooting)
- [Roadmap / Integração RabbitMQ (opcional)](#roadmap--integração-rabbitmq-opcional)
- [Licença](#licença)

---

## Arquitetura

1. **JQL** (Mixpanel):  
   Retorna perfis cujo `status|plan|endDate|toleranceEndDate|recurrence` está **missing** ou “**blankish**” (`""`, `"undefined"`, `"null"`, `"nan"`, `"none"`, `"n/a"`, `"-"`).  
   Também retorna os valores atuais (`props`) **e** a propriedade **“Store Id (aid)”** (`aid_prop`).

2. **MongoDB (db.kyte-admin.users)**:  
   Busca em **lotes** pelos AIDs vindos do Mixpanel — **por `aid` ou `sourceId`** — retornando só os campos necessários.

3. **Montagem do payload**:  
   Converte `expireDate → endDate` e `toleranceDate → toleranceEndDate` para **ISO-8601 UTC**; ignora valores nulos; opcionalmente atualiza se **diferente**.

4. **Envio**:  
   Usa `https://api.mixpanel.com/engage#profile-batch-update` com lotes grandes (padrão 1000 perfis/lote), respeitando pequena pausa entre requisições.

5. **Auditoria**:  
   Seta `kyte_last_profile_sync_at=<SYNC_RUN_TAG>` em cada perfil atualizado.

---

## Pré-requisitos

- **Node.js 18+**
- Acesso ao **MongoDB**
- Acesso ao **Mixpanel** com Service Account que possa:
  - **Ver classified data** (se seu projeto usa isso)
  - **Modificar usuários (Engage/Profiles)**
- **Project ID** e **Project Token** do Mixpanel

---

## Instalação

```bash
git clone <seu-repo>.git
cd mixpanel-profile-fixer
npm i
```

Se usar TypeScript localmente, compile com:

```bash
npx tsc
```

> Dica (Windows/PowerShell): evite `ts-node` em produção; rode o **build** (`dist/`).

---

## Configuração (.env)

Crie um `.env` na raiz (exemplo abaixo). Ajuste para o seu ambiente:

```env
# —— Mixpanel ——
MIXPANEL_PROJECT_ID=123456
MIXPANEL_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
MIXPANEL_SERVICE_USERNAME=service@example.com
MIXPANEL_SERVICE_SECRET=your-service-secret

# Propriedade do perfil que contém o AID
AID_PROP_NAME=Store Id (aid)

# —— Mongo ——
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/<db>?retryWrites=true&w=majority
MONGODB_DB=kyte-admin
MONGODB_COLLECTION=users

# —— Execução ——
DRY_RUN=0                    # 1 = simulação (não escreve no Mixpanel)
MAX_JQL_RESULTS=50000        # limita quantos perfis vêm do JQL por rodada
DRY_RUN_LIMIT=0              # corta localmente (só no DRY_RUN)

# —— Batch Mixpanel ——
BATCH_UPDATE_SIZE=1000       # quantos perfis por request
BATCH_UPDATE_PAUSE_MS=300    # pausa entre requests (ms)
SYNC_RUN_TAG=2025-08-13T18:30:00Z  # carimbo de auditoria (opcional)

# —— Mongo batching ——
MONGO_BATCH_SIZE=1000        # lote para $in no Mongo
MONGO_SAMPLE_LIMIT=0         # 0 = não imprimir amostras

# —— Comportamento ——
FORCE_UPDATE_IF_DIFFERENT=false   # atualiza mesmo se já existir, quando o valor diverge
FALLBACK_AID_EQUALS_DISTINCT=false # fallback usa distinct_id como chave de busca (evite; use só se precisar)
```

> **Importante (Windows/PowerShell):** variáveis de ambiente **da sessão** podem **sobrescrever** o `.env`.  
> Antes de rodar “valendo”, rode:  
> `Remove-Item Env:DRY_RUN` (ou `$env:DRY_RUN="0"`).

---

## Como rodar

### Dry-run (simulação, sem escrever no Mixpanel)
```powershell
# Windows PowerShell
$env:DRY_RUN="1"
node dist/fix-mixpanel-profiles.js
```

### Execução real
```powershell
# Garanta que DRY_RUN não está setado na sessão
Remove-Item Env:DRY_RUN
node dist/fix-mixpanel-profiles.js
```

**Logs esperados (exemplos):**
```
JQL retornou 50000 perfis com algum campo faltando.
ℹ️ Perfis do JQL sem "Store Id (aid)": 123
AIDs vindos do Mixpanel ("Store Id (aid)") para buscar no Mongo: 49877
... Mongo: processados 50000/49877, encontrados (uniq) 49200 · hits aid=48000 · hits sourceId=1200
✅ Localizados 49200 usuários no Mongo (de 49877 solicitados)
ℹ️ Sem doc no Mongo para o aid/sourceId: 677
ℹ️ Updates a enviar: 31000
✍️ Preparando para atualizar (batch) 31000 perfis no Mixpanel...
🚦 Modo: LIVE (atualizando) · batchSize=1000 · pauseMs=300
✅ Lote 1 enviado · 1000/31000 (3.2%) · 0.8s
...
✅ Perfis atualizados com sucesso: 31000
🔖 Carimbo desta execução (kyte_last_profile_sync_at): 2025-08-13T18:30:00Z
```

Repita a execução até o estoque de “faltando” cair a ~0.

---

## Logs e Auditoria

Cada atualização grava um campo no perfil:
- `kyte_last_profile_sync_at = <SYNC_RUN_TAG>`

Para consultar **quem foi atualizado** nessa rodada, rode um JQL:

```js
function main(){
  var tag = "2025-08-13T18:30:00Z";
  return People()
    .filter(function(u){
      var p = u.properties||{};
      return p.kyte_last_profile_sync_at === tag;
    })
    .reduce(mixpanel.reducer.count());
}
```

---

## Mapeamento de Campos

**Mixpanel (User Profile)** ← **Mongo (`users`)**

- `status`           ← `status`
- `plan`             ← `plan`
- `endDate`          ← `expireDate`      (normalizado para ISO-8601 UTC)
- `toleranceEndDate` ← `toleranceDate`   (normalizado para ISO-8601 UTC)
- `recurrence`       ← `recurrence`

> “Vazios” no Mixpanel como `"undefined"`, `""`, `"null"`, `"nan"`, `"none"`, `"n/a"`, `"-"` são tratados como **faltando** e serão sobrescritos.

---

## Desempenho e Boas Práticas

- **Batch endpoint**: `profile-batch-update` com `BATCH_UPDATE_SIZE=1000` é muito mais rápido que `people.set` unitário.
- **JQL paginado**: use `MAX_JQL_RESULTS=50000` e rode em “passadas”.
- **Mongo**:
  - Garanta índice em `users.aid` **e** `users.sourceId`:
    ```js
    db.users.createIndex({ aid: 1 });
    db.users.createIndex({ sourceId: 1 });
    ```
  - Lotes (`MONGO_BATCH_SIZE`) de 1000 evitam estourar BSON (16 MB).
- **Case sensitive**: **não** faça `lowercase` nos IDs; `aid/sourceId` são sensíveis a maiúsculas.
- **Flags úteis**:
  - `FORCE_UPDATE_IF_DIFFERENT=true` para também sincronizar divergências (não só campos faltantes).
  - `FALLBACK_AID_EQUALS_DISTINCT=true` só se você quiser usar `distinct_id` como chave de busca quando “Store Id (aid)” estiver vazio (evite se possível).

---

## Erros comuns / Troubleshooting

- **JQL 403 – “classified data”**  
  A Service Account precisa permissão para ver dados classificados.

- **JQL 412 – `.slice`/`.limit` não existe**  
  O JQL do Mixpanel não tem esses métodos; no código usamos um **contador** dentro do `.filter` para limitar.

- **Mongo: `RangeError [ERR_OUT_OF_RANGE]` (BSON 16 MB)**  
  Resolvido com **batch** de AIDs (env `MONGO_BATCH_SIZE`).

- **DNS `querySrv ENOTFOUND _mongodb._tcp.cluster`**  
  Verifique seu `MONGODB_URI` (SRV e cluster corretos).

- **Windows: “`'DRY_RUN' is not recognized`”**  
  No PowerShell, use:
  ```powershell
  $env:DRY_RUN="1"
  # ou remova:
  Remove-Item Env:DRY_RUN
  ```

- **Node/TS: `ERR_UNKNOWN_FILE_EXTENSION ".ts"`**  
  Compile com `npx tsc` e rode `node dist/...`.

---

## Roadmap / Integração RabbitMQ (opcional)

Você pode plugar essa lógica como **consumer** em filas existentes:

- **Fila**: ex. `mixpanel/profile-sync`
- **Mensagem**:
  - `{ "aids": ["AID_1","AID_2", ...] }` para corrigir casos pontuais
  - `{ "since": "2025-08-01", "limit": 5000 }` para janelas de atualização
- O consumer reusa a mesma montagem de payload e chama `profile-batch-update`.

> Útil para manter sincronismo contínuo sem rodadas manuais.

---

## Licença

MIT – use à vontade.  
Sugestões e PRs são bem-vindos! 💚
