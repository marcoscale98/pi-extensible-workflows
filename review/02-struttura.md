# Struttura e pulizia

## Cosa funziona bene (da non toccare)

- **Confini dei moduli chiari**: `store.ts` (persistenza), `execution.ts` (worker sandbox + RPC), `agent-execution.ts` (sessioni/scheduler), `host-*.ts` (recovery, navigator, delivery, phases, view), `decoders.ts` (confine di fiducia in lettura), `validation.ts` (confine di fiducia in scrittura). La divisione riflette i trust boundary reali.
- **`LiveAgentRegistry`** (`host.ts:1362+`): esempio giusto di consolidamento — una mappa sostituisce cinque mappe parallele, con il commento che spiega il perche. Idem `HARD_TERMINAL_RUN_STATES`/`SETTLED_AGENT_STATES` in `types.ts` come vocabolario unico.
- **Commenti**: quasi solo "perche" e invarianti (es. il razionale del watchdog in `execution.ts`, il preambolo di `background-widget.ts`). I tre `// ponytail:` esistenti nominano correttamente il ceiling.
- **`io.ts` / `paths.ts`**: piccoli, senza wrapper superflui.

## S1. `host.ts`: una funzione da ~1.150 righe con ~30 closure

`workflowExtension()` (`host.ts:248` fino a ~1400) contiene: bridge di log/phase/shell/checkpoint, macchina di consegna foreground/background, scheduler callback, session_start/shutdown, 6 registrazioni tool, resume interattivo. Le dipendenze passano a `createWorkflowRecovery` come oggetto con **~28 campi** (`host.ts:877`, `host-recovery.ts:62`).

Non e codice disordinato — e coeso e le estrazioni giuste (`host-recovery`, `host-navigator`, `host-delivery`, `host-phases`) sono gia state fatte. Ma e oltre ogni soglia di ispezionabilita: qualunque modifica richiede di ricostruire mentalmente lo stato condiviso di ~15 mappe/flag di modulo.

**Passo incrementale a basso rischio** (non un rewrite): estrarre la macchina di consegna foreground in `host-delivery.ts`, dove il nome gia punta:
`foregroundDeliveries`, `pendingFailureDiagnostics`, `foregroundResumeClaims`, `terminalDeliveryQueues`, `deliverTerminal`, `scheduleForegroundDelivery`, `foregroundDeliveryCandidates`, `moveForegroundToBackground`, `isForegroundAttached`, `queueForegroundDelivery`.
Sono ~180 righe con uno stato proprio ben delimitato (mappe keyed su toolCallId/RunStore) e un'interfaccia stretta verso il resto (`runs`, `deliver`). Diventerebbe una classe `ForegroundDeliveryController` testabile in isolamento.

## S2. `execute()` del tool `workflow`: ~250 righe

Dentro il tool principale convivono: validazione/aliases, creazione snapshot+store, wiring foreground (`detach`), lancio, catena `finish/completion`, e la corsa `completion` vs `detachedResult`. Il punto di taglio naturale e separare "preparazione del lancio" (da `validateBudget` a `store.create`) da "wiring della consegna". Da fare solo quando si tocca quel codice, non come task a se.

## S3. Stile a riga unica

Interi record su una riga (`RunRecord` in `types.ts`: ~30 campi, 700+ caratteri; `resumedSnapshotSettings` in `host.ts`; la riga `runs.set(runId, {...})` in `session_start` da ~1.100 caratteri). E uno stile coerente e deliberato, ma:
- i diff su quelle righe sono illeggibili (ogni modifica a un campo tocca l'intera riga);
- `git blame` perde granularita;
- il code review di una modifica a `RunRecord` non mostra *quale* campo e cambiato.

Non c'e un formatter nel repo, quindi e una scelta manuale. Suggerimento minimo: multilinea solo per i record persistiti/pubblici con piu di ~8 campi (`RunRecord`, `AgentRecord`, `LaunchSnapshot`, `AgentResourcePolicy`). Il resto puo restare com'e.

## S4. `types.ts` come contenitore unico (258 righe, ~120 dichiarazioni)

Mischia: vocabolari runtime (stati, eventi), tipi wire/persistiti, tipi di sessione agente, tipi del catalogo, tipi di validazione. Funziona perche e tutto su una riga; se S3 viene applicato crescera parecchio. Split naturale (solo allora): `types.ts` (dominio/wire) + `session-types.ts` (WorkflowAgentSession*) + `catalog-types.ts`. Oggi: nessuna azione.

## S5. Macchina a stati manuale in `createLocalWorkflowAgentSession`

`agent-execution.ts:380-607`: uno stato stringa a 6 valori (`active|suspending|suspended|resuming|disposing|disposed`) piu ~10 variabili mutabili correlate (`aborting`, `disposal`, `suspendOperation`, `resumeOperation`, `resumingActive`, `observationGeneration`, `eventNotificationFailure`, ...). Le transizioni sono corrette a lettura attenta (e coperte dai test di handoff), ma ogni invariante e implicito. Rimedio a costo quasi zero quando si ritocca: un commento con il diagramma delle transizioni ammesse e di chi puo scriverle. Il refactor a discriminated union e opzionale e va fatto solo con una ragione funzionale.

## S6. Artefatto di test in percorso sbagliato

`packages/core/test/real-workflow-session.test.ts:31` risolve la trace dir con `process.env.PI_WORKFLOW_TRACE_DIR ?? join(process.cwd(), ".tmp", ...)`. Con `PI_WORKFLOW_TRACE_DIR` relativa (o cwd inatteso) nasce `packages/core/packages/core/.tmp/workflow-real-session-develop/trace.jsonl` — esiste ora nel worktree. E git-ignorata, ma il percorso e sbagliato.

**Fix**: risolvere contro la root del pacchetto (`new URL("..", import.meta.url)`) invece che contro `process.cwd()`.

## S7 (area grigia). `childSource`: ~250 righe di JS dentro una template string

`execution.ts:60+` incorpora il worker come stringa. Vantaggi reali: dist a file unico, nessun problema di path a runtime, il codice e sotto controllo del bundle. Svantaggio: niente lint/typecheck su quel blocco (un errore di sintassi si scopre solo a runtime — mitigato dal fatto che i test lo eseguono continuamente). Alternativa se mai desse fastidio: file `.cjs` reale letto a build-time e inlined. Oggi non vale il cambio.

## Pulizia varia

- Nessun TODO/FIXME/HACK dimenticato; nessun codice morto evidente nei file letti.
- `docs:check`, `lint` verdi; `.gitignore` minimale e corretto.
- I nomi seguono unita e qualificatori (`timeoutMs`, `DELIVERY_LIMIT_BYTES`, `OWNER_WRITE_GRACE_MS`) in modo consistente.
