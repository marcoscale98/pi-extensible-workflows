# TigerStyle check (Safety > Performance > DX)

Scope: `packages/core/src`, `packages/cli/src`, `packages/extensions/*/src`. Solo finding con evidenza; formato `SEVERITY | CATEGORY | posizione | regola | evidenza | rimedio minimo`.

## Violazioni

```text
MAJOR | Performance | packages/core/src/store.ts:288-311 + host.ts (workflowAgentHandler, shellForRun) | lavoro limitato / hot path prevedibile
  Ogni chiamata agent/shell fa store.replay(path) -> replayableOperationsFrom(): load() completo del run,
  decode dell'intero journal, risalita ricorsiva della catena retry, e structuredClone di TUTTE le
  operazioni completate, per poi cercarne UNA per path. Con N operazioni completate il run paga O(N^2)
  clone+decode complessivi; su retry-chain profonde si moltiplica per la profondita. Su fan-out grandi
  (centinaia di agent) e I/O+CPU quadratico osservabile.
  Rimedio minimo: replay(path) dedicato che consulta journal.completed[path] direttamente (con la stessa
  risalita della catena ma senza clonare l'insieme), oppure cache in memoria del journal valida sotto la
  session lease gia esistente. Nota: stima da lettura, non misurata.

MINOR | Safety | packages/core/src/host.ts:260-273 (logBridge) + store.ts appendEvent | crescita esterna limitata al confine
  Gli eventi "log" di un run foreground attaccato vengono accodati a run.events senza tetto sul numero
  (ogni messaggio e limitato a DELIVERY_LIMIT_BYTES=4KB, ma il conteggio no) e state.json viene riscritto
  integralmente a ogni append. Un workflow autore che logga in loop fa crescere state.json linearmente e
  paga riscritture O(n^2) cumulative. Conseguenza plausibile: run lunghi e loquaci degradano I/O e
  parsing dello stato. Rimedio minimo: tetto (es. ultimi 200 eventi) con scarto FIFO in logBridge/appendEvent.

MINOR | Safety | packages/core/test/real-workflow-session.test.ts:31 | artefatti in percorso controllato
  La trace dir di fallback e join(process.cwd(), ".tmp", ...): risolta contro il cwd del runner, non
  contro il pacchetto. Evidenza: packages/core/packages/core/.tmp/workflow-real-session-develop/trace.jsonl
  presente nel worktree. Rimedio: risolvere contro la root del pacchetto via import.meta.url.
```

## Allineato (campione, non esaustivo)

- **Bound espliciti ovunque contino**: `RPC_LIMIT_BYTES` 10 MB applicato su entrambi i lati dell'IPC e sull'output shell cumulato (`execution.ts`); `DELIVERY_LIMIT_BYTES`; prompt/context dei checkpoint limitati a 1/4 KB (`validation.ts`); attempt persistiti troncati (`manager.ts`: `MAX_PERSISTED_ATTEMPT_*`); ricorsioni su retry/worktree-chain protette da cycle-set (`store.ts`).
- **Watchdog corretto**: heartbeat 1 s / timeout 5 s con compensazione del ritardo dello stesso watchdog (`execution.ts:614-624`) — raro vederlo fatto giusto.
- **Sandbox del worker**: `vm` con `codeGeneration` disabilitata, globals azzerati, `process.*` pericolosi rimossi, `--permission --allow-fs-read=<dir>`, `--max-old-space-size=128`. Difesa in profondita reale.
- **Persistenza**: tmp+rename atomici (`io.ts`), directory create 0700, run creati in staging dir e promossi con un solo `rename`, marker `.creating` per il cleanup dei worktree orfani, identita del run ri-verificata sia in scrittura sia in lettura (check accoppiati sui due lati del confine, come da disciplina).
- **Ownership async**: ogni promise ha un proprietario; fire-and-forget sempre nel pattern `void p.catch(...)` con commento sul perche (es. il poll del checkpoint UI in `host.ts` con `//NOTE:`); `AbortSignal` propagato fino a shell e sessioni; kill del process-tree con SIGTERM->SIGKILL e timer `unref()`.
- **Errori**: mai catch vuoti silenziosi non commentati; i best-effort dichiarano il razionale inline; `cause`-equivalente tramite codici + `failedAt` assoluti nel journal.
- **Lease/lock**: `acquireStorageOwner` (subagents) gestisce marker corrotti, grace window sull'mtime, rename-verify-restore — corretto anche nei casi di gara.

## Aree grigie

- `io.ts json()` legge file interi senza tetto: i file sono prodotti dal sistema stesso sotto lease, quindi non e input esterno; nessuna violazione. Diventerebbe rilevante solo se `state.json` crescesse senza tetto (vedi il finding MINOR sugli eventi log, che e la causa a monte).
- `deliverTerminal` (`host.ts:833-866`) fa un secondo `load()` post-claim per rivalidare lo stato dopo l'await: giusto secondo la regola "rivalida dopo sospensione", ma la coppia claim/unclaim su `foregroundResumeClaims` merita un commento d'invariante — oggi si ricostruisce solo leggendo tre funzioni.
- Concurrency cap globale 16 (`FairAgentScheduler`, settings max 16): bound presente e documentato; nessun problema.

## Check non eseguiti

- `npm run lint` e `npm run docs:check`: eseguiti, verdi.
- `npm run build` / suite test / acceptance / evals: non rieseguiti in questa review (stato repo: release 5.5.0, worktree pulito). I finding sopra derivano da lettura del codice, non da regressioni osservate a runtime.
