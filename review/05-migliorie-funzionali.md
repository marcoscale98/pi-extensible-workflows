# 3 migliorie funzionali proposte

Tutte e tre nascono da lacune osservate nel codice attuale, riusano macchinari gia esistenti e restano nel perimetro del progetto.

---

## 1. Tool `workflow_list`: enumerazione programmatica dei run

**Lacuna.** Il prompt del tool `workflow` istruisce l'agente: "After failure follow-ups ... call workflow_status({ runId }) before recovery". Ma `workflow_status` richiede un `runId` gia noto: dopo una compaction del contesto, o per run lanciati in una sessione precedente, l'agente non ha modo di scoprirli. L'elenco run esiste solo nel picker interattivo `/workflow` (umano) e nell'inspector CLI — non nella superficie tool.

**Proposta.** Nuovo tool read-only `workflow_list`:
```
parameters: { state?: "active" | "terminal" | "all", limit?: 1..50 (default 20) }
result: [{ runId, workflowName, state, createdAt, updatedAt, phase?, usage?, delivery?, error? }]
```

**Riuso.** Tutto gia pronto: `listPersistedSessionIds` + `listRunIds` (gia usati da `workflowStatusRun` in `host.ts`), e soprattutto `summary.json` / `RunStore.loadSummary()` — la proiezione economica esiste *esattamente* per letture di questo tipo, senza decodificare `state.json` completo. Rendering: riuso di `workflowControlCall`/`workflowControlResult` (con la factory R6 di 01-ripetizioni il tool costa ~20 righe).

**Note di bound.** `limit` massimo fisso, ordinamento per `updatedAt` desc, scansione con lo stesso pattern tollerante di `workflowStatusRun` (run illeggibili saltati).

**Effort**: basso (tool + test). **Rischio**: minimo, read-only.

---

## 2. Retention automatica dei run terminali

**Lacuna.** Le directory dei run (state, journal, snapshot, result, worktree, system-prompts) crescono senza limite: l'unica pulizia e manuale (`piewf doctor-cleanup --older-than-days N`, con preview/conferma). Un utente che usa workflow quotidianamente accumula centinaia di run directory e branch git `pi-extensible-workflows/*` per sempre. E l'unico punto del sistema in cui una risorsa cresce senza bound ne policy — in tensione con la disciplina "bounded resources" applicata ovunque altrove.

**Proposta.** Chiave opzionale in `settings.json`:
```json
{ "retention": { "olderThanDays": 30, "maxTerminalRuns": 200 } }
```
Applicata best-effort a `session_start` (dopo l'acquisizione della session lease, prima del resume dei run interrotti), solo su run in stato hard-terminal (`completed|failed|stopped`).

**Riuso.** `doctor-cleanup.ts` ha gia tutto il pezzo difficile: calcolo dei candidati, protezione delle catene di dipendenza retry/parentRunId ("Persisted run dependency cycle prevents safe cleanup"), verifica di sicurezza delle sessioni, e `RunStore.delete()` gia rimuove worktree+branch in modo sicuro (`validateDeletionWorktrees`). Serve solo: spostare il calcolo dei candidati dal CLI al core, aggiungere la chiave a `parseSettings` (validazione: interi positivi), e invocarlo con `void ...catch(...)` documentato.

**Guard-rail.** Mai cancellare: run con discendenti retry vivi, run `parentRunId` di run non terminali, run con worktree presi in prestito da altri run. Tutte condizioni che doctor-cleanup gia calcola.

**Effort**: medio (estrazione dal CLI + settings + test). **Rischio**: gestito dai guard-rail esistenti; default = disattivato (opt-in), quindi zero cambi di comportamento per chi non la configura.

---

## 3. Tool `workflow_steer`: messaggi a un agente di un run in corso

**Lacuna.** I subagent hanno `subagents_steer` (con coda bounded `MAX_PENDING_STEERING_MESSAGES = 16`); gli agenti dentro un run workflow no. Se un fan-out da 8 agenti sta lavorando e uno sta andando nella direzione sbagliata, le uniche opzioni sono aspettare o `workflow_stop` dell'intero run — sproporzionato. L'asimmetria tra le due superfici e visibile anche nella doc.

**Proposta.** Nuovo tool:
```
workflow_steer: { runId: string, agentId: string, message: string }
```
Risultato: `{ delivered: boolean, reason?: "unknown_run" | "unknown_agent" | "agent_settled" | "no_handler" }`.

**Riuso.** Il plumbing c'e gia per intero:
- `FairAgentScheduler` registra un handler di steering per nodo (`setSteer`, `node.steer`) e ha gia `scheduler.steer(parentId, childId, message)` per il caso parent->child (`agent-execution.ts:1281`);
- le sessioni live espongono `steer(text)` (`agent-execution.ts:595`) e `liveAgents` in `host.ts` tiene il riferimento alla sessione viva per (runId, agentId);
- gli `agentId` sono gia visibili all'agente chiamante via `workflow_status`.
Manca solo il percorso host->nodo: un metodo `steerNode(runId, agentId, message)` sullo scheduler (o lookup via `liveAgents.get(runId, agentId).session?.steer`), piu la coda bounded riusando la costante dei subagents.

**Determinismo.** Lo steering non altera l'identita strutturale del run (prompt e journal restano quelli): un retry non ri-applica gli steer. Va detto nella doc, ed e coerente con come i subagent gia trattano la cosa.

**Effort**: medio-basso. **Rischio**: contenuto — nessun nuovo stato persistito, fallisce in modo esplicito quando l'agente e settled.

---

## Perche queste tre

Insieme chiudono il ciclo operativo che oggi ha tre buchi: *scoprire* i run (1), *intervenire* su un run vivo senza ucciderlo (3), e *non pagare per sempre* i run finiti (2). Nessuna richiede formati persistiti nuovi ne tocca il percorso di recovery.
